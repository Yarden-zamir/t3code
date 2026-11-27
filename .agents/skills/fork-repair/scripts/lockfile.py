# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Resolves a pnpm-lock.yaml merge conflict.

It takes the upstream lockfile and rebuilds it from the merged package.json files with
`CI=1 vp i --lockfile-only`. pnpm keeps each upstream resolution that still fits and resolves only
the fork dependencies. It stages the lockfile only when each package integrity in it comes from the
upstream or the fork lockfile, so the rebuild picked no new package version. A start from the fork
lockfile instead resolves each range that upstream changed to the newest version of today, not to
the version that upstream locked.

Limits: MERGE_HEAD must be the upstream side (run it in the sync worktree, not in a merge of fork
main into the sync branch). A fork-only dependency resolves fresh, so a new release of one stops
the script for a manual check.

With --rebuild, it also runs when git merged the lockfile without a conflict, but the text merge
broke it (`vp i --frozen-lockfile` fails with ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY). After the
merge commit, --rebuild takes the second parent of HEAD as the upstream side, so commit the staged
lockfile as a fix on top.
"""

import argparse
import os
import sys
from pathlib import Path

import common

LOCKFILE = "pnpm-lock.yaml"
INTEGRITY = "resolution: {integrity:"


def integrities(lockfile: str) -> frozenset[str]:
    """The integrity hashes of a lockfile, one for each resolved package version."""
    return frozenset(
        line.split(INTEGRITY, 1)[1].split(",", 1)[0].strip().rstrip("}").strip()
        for line in lockfile.splitlines()
        if INTEGRITY in line
    )


def new_integrities(rebuilt: str, *sides: str) -> frozenset[str]:
    """The integrities of the rebuilt lockfile that no side has: package versions the rebuild picked."""
    known = frozenset().union(*(integrities(side) for side in sides))
    return integrities(rebuilt) - known


def merge_sides(root: Path, rebuild: bool) -> tuple[str, str]:
    """The upstream and fork refs: the merge in progress, or with --rebuild the merge commit at HEAD."""
    if common.git_ok("rev-parse", "--verify", "-q", "MERGE_HEAD", cwd=root):
        return "MERGE_HEAD", "HEAD"
    if rebuild and common.git_ok("rev-parse", "--verify", "-q", "HEAD^2", cwd=root):
        return "HEAD^2", "HEAD^1"
    common.fail("no merge in progress, and HEAD is not a merge commit.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rebuild", action="store_true", help="rebuild a lockfile that merged without a conflict")
    args = parser.parse_args()
    root = common.repo_root()
    upstream_ref, fork_ref = merge_sides(root, args.rebuild)
    unmerged = common.git("diff", "--name-only", "--diff-filter=U", cwd=root).splitlines()
    if LOCKFILE not in unmerged and not args.rebuild:
        common.fail(f"{LOCKFILE} has no conflict.")

    common.git("checkout", upstream_ref, "--", LOCKFILE, cwd=root)
    log = common.log_dir("lockfile") / "install.log"
    code = common.run_logged([common.vp(root), "i", "--lockfile-only"], log, root, {**os.environ, "CI": "1"})
    if code != 0:
        common.fail(f"`vp i --lockfile-only` failed (exit {code}). See {log}")

    rebuilt = (root / LOCKFILE).read_text()
    upstream = common.git("show", f"{upstream_ref}:{LOCKFILE}", cwd=root)
    fork = common.git("show", f"{fork_ref}:{LOCKFILE}", cwd=root)
    added = new_integrities(rebuilt, upstream, fork)
    if added:
        print(f"The rebuild picked {len(added)} package versions that neither side locked:")
        for line in rebuilt.splitlines():
            if INTEGRITY in line and integrities(line) <= added:
                print(f"  {line.strip()}")
        print(f"Check them before you stage: git diff {upstream_ref} -- {LOCKFILE}")
        sys.exit(1)
    common.git("add", LOCKFILE, cwd=root)
    print(f"Rebuilt {LOCKFILE} from the upstream side with no new package versions. Staged it.")


if __name__ == "__main__":
    main()
