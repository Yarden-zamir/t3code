# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Runs the repair checks one after another in the foreground, and reports each step.

Steps: `vp run typecheck`, the migration check against upstream/main, the adopted pull request
check, and on a fork-fix/ branch `vp run fork:check`. A fork-sync/ branch skips fork:check:
on a merge with upstream it checks hundreds of files, and Fork CI checks the pull request.
"""

import argparse
import sys

import common


def steps(vp: str, branch: str) -> list[tuple[str, list[str]]]:
    result = [
        ("typecheck", [vp, "run", "typecheck"]),
        ("migrations", ["node", "scripts/fork-check-migrations.ts", "upstream/main"]),
        ("adopted PRs", ["node", "scripts/fork-adopted-prs.ts", "check"]),
    ]
    if branch.startswith("fork-fix/"):
        result.append(("fork:check", [vp, "run", "fork:check"]))
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
    for name, cmd in steps(common.vp(root), branch):
        log = logs / f"{name.replace(' ', '-').replace(':', '-')}.log"
        code = common.run_logged(cmd, log, root)
        print(f"{'pass' if code == 0 else f'fail (exit {code})':<16} {name:<12} {log}")
        if code != 0:
            failed.append(name)
            print(common.tail(log, args.lines))
    if failed:
        print(f"Failed: {', '.join(failed)}")
        sys.exit(1)
    print(f"All checks passed on {branch or 'a detached HEAD'}.")


if __name__ == "__main__":
    main()
