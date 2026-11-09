# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Runs the repair checks one after another in the foreground, and reports each step.

Steps: `vp i --frozen-lockfile`, `vp run typecheck`, the migration check against upstream/main, the adopted pull request
check, and on a fork-fix/ branch `vp run fork:check`. A fork-sync/ branch skips fork:check:
on a merge with upstream it checks hundreds of files, and Fork CI checks the pull request.
A fork-sync/ branch lints the files that differ from upstream/main instead, because a new
upstream lint rule can fail on fork files that the merge did not touch. A fork-sync/ branch
also lists the active workflows that are not fork workflows, and prints the command that
disables each one.
"""

import argparse
import json
import subprocess
import sys

import common


LINT_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".cjs")
FORK_REPO = "Yarden-zamir/t3code"
WORKFLOW_DIR = ".github/workflows/"
# Its pull_request runs get no secrets, and fork pull requests use its budget check.
KEPT_UPSTREAM_WORKFLOWS = frozenset({"agent-context-budget.yml"})


def active_upstream_workflows(workflows: list[dict[str, str]]) -> list[str]:
    """The file names of active workflows that the fork does not keep on.

    Upstream workflows need upstream's runners and secrets. Fork workflow files start with "fork-".
    Workflows outside .github/workflows/, such as GitHub's dynamic ones, do not count.
    """
    names = (
        workflow["path"].removeprefix(WORKFLOW_DIR)
        for workflow in workflows
        if workflow["state"] == "active" and workflow["path"].startswith(WORKFLOW_DIR)
    )
    return sorted(name for name in names if not name.startswith("fork-") and name not in KEPT_UPSTREAM_WORKFLOWS)


def check_workflows() -> bool:
    """Limit: GitHub registers a new workflow file only after main has it. So a merge that adds
    one shows it only after the merge. Run this again on main after the merge."""
    result = subprocess.run(
        ["gh", "workflow", "list", "--repo", FORK_REPO, "--all", "--json", "path,state"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(f"{'fail':<16} {'workflows':<12} gh workflow list: {result.stderr.strip()}")
        return False
    active = active_upstream_workflows(json.loads(result.stdout))
    print(f"{'fail' if active else 'pass':<16} {'workflows':<12} {len(active)} active upstream workflows")
    for name in active:
        print(f"gh workflow disable --repo {FORK_REPO} {name}")
    return not active


def lintable(paths: list[str]) -> list[str]:
    return sorted({path for path in paths if path.endswith(LINT_SUFFIXES)})


def lint_errors(log_text: str) -> list[str]:
    """The error lines of a `vp lint` log; its hundreds of warnings would hide them."""
    return [line for line in log_text.splitlines() if ": error" in line]


def steps(vp: str, branch: str, fork_files: list[str]) -> list[tuple[str, list[str]]]:
    result = [
        # A merge that changes pnpm-lock.yaml leaves the install of the worktree stale.
        ("install", [vp, "i", "--frozen-lockfile"]),
        ("typecheck", [vp, "run", "typecheck"]),
        ("migrations", ["node", "scripts/fork-check-migrations.ts", "upstream/main"]),
        ("adopted PRs", ["node", "scripts/fork-adopted-prs.ts", "check"]),
    ]
    if branch.startswith("fork-fix/"):
        result.append(("fork:check", [vp, "run", "fork:check"]))
    elif fork_files:
        # Fork CI runs `vp check`, which fails on formatting before lint.
        result.append(("format", [vp, "fmt", "--check", *fork_files]))
        result.append(("lint", [vp, "lint", *fork_files]))
        # Fork CI's lint job also runs knip, which finds exports that a merge left unused.
        result.append(("knip", [vp, "run", "knip:check"]))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lines", type=int, default=30, help="log lines to print per failed step (default 30)")
    args = parser.parse_args()
    root = common.repo_root()
    if not common.git_ok("rev-parse", "--verify", "-q", "upstream/main", cwd=root):
        common.fail("no upstream/main. Run `git fetch --no-tags upstream main` first.")
    branch = common.git("branch", "--show-current", cwd=root)
    logs = common.log_dir("checks")
    failed: list[str] = []
    changed = common.git("diff", "--name-only", "--diff-filter=AM", "upstream/main", "HEAD", cwd=root)
    fork_files = lintable(changed.splitlines())
    for name, cmd in steps(common.vp(root), branch, fork_files):
        log = logs / f"{name.replace(' ', '-').replace(':', '-')}.log"
        code = common.run_logged(cmd, log, root)
        print(f"{'pass' if code == 0 else f'fail (exit {code})':<16} {name:<12} {log}")
        if code != 0:
            failed.append(name)
            errors = lint_errors(log.read_text()) if name == "lint" else []
            print("\n".join(errors) if errors else common.tail(log, args.lines))
    if branch.startswith("fork-sync/") and not check_workflows():
        failed.append("workflows")
    if failed:
        print(f"Failed: {', '.join(failed)}")
        sys.exit(1)
    print(f"All checks passed on {branch or 'a detached HEAD'}.")


if __name__ == "__main__":
    main()
