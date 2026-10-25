# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Runs the repair checks one after another in the foreground, and reports each step.

Steps: `vp run typecheck`, the migration check against upstream/main, the adopted pull request
check, and on a fork-fix/ branch `vp run fork:check`. A fork-sync/ branch skips fork:check:
on a merge with upstream it checks hundreds of files, and Fork CI checks the pull request.
A fork-sync/ branch lints the files that differ from upstream/main instead, because a new
upstream lint rule can fail on fork files that the merge did not touch.
"""

import argparse
import sys

import common


LINT_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".cjs")


def lintable(paths: list[str]) -> list[str]:
    return sorted({path for path in paths if path.endswith(LINT_SUFFIXES)})


def lint_errors(log_text: str) -> list[str]:
    """The error lines of a `vp lint` log; its hundreds of warnings would hide them."""
    return [line for line in log_text.splitlines() if ": error" in line]


def steps(vp: str, branch: str, fork_files: list[str]) -> list[tuple[str, list[str]]]:
    result = [
        ("typecheck", [vp, "run", "typecheck"]),
        ("migrations", ["node", "scripts/fork-check-migrations.ts", "upstream/main"]),
        ("adopted PRs", ["node", "scripts/fork-adopted-prs.ts", "check"]),
    ]
    if branch.startswith("fork-fix/"):
        result.append(("fork:check", [vp, "run", "fork:check"]))
    elif fork_files:
        result.append(("lint", [vp, "lint", *fork_files]))
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
    if failed:
        print(f"Failed: {', '.join(failed)}")
        sys.exit(1)
    print(f"All checks passed on {branch or 'a detached HEAD'}.")


if __name__ == "__main__":
    main()
