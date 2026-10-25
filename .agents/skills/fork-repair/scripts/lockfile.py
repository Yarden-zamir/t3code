# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Resolves a pnpm-lock.yaml merge conflict.

It takes the fork lockfile, rebuilds it from the merged package.json files with
`CI=1 vp i --lockfile-only`, and compares the package integrity lines that changed with the ones
that the merged side changed. It stages the lockfile only when both sets are equal. The other
lockfile lines differ between the two sides on purpose: the fork resolves other peer versions.

With --rebuild, it also runs when git merged the lockfile without a conflict, but the text merge
broke it (`vp i --frozen-lockfile` fails with ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY).
"""

import argparse
import os
import sys

import common

LOCKFILE = "pnpm-lock.yaml"
INTEGRITY = "resolution: {integrity:"


def integrity_changes(diff: str) -> tuple[frozenset[str], frozenset[str]]:
    """The removed and the added integrity lines of a unified diff, without the +/- mark."""
    removed = {line[1:].strip() for line in diff.splitlines() if line.startswith("-") and INTEGRITY in line}
    added = {line[1:].strip() for line in diff.splitlines() if line.startswith("+") and INTEGRITY in line}
    return frozenset(removed), frozenset(added)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rebuild", action="store_true", help="rebuild a lockfile that merged without a conflict")
    args = parser.parse_args()
    root = common.repo_root()
    if not common.git_ok("rev-parse", "--verify", "-q", "MERGE_HEAD", cwd=root):
        common.fail("no merge in progress.")
    unmerged = common.git("diff", "--name-only", "--diff-filter=U", cwd=root).splitlines()
    if LOCKFILE not in unmerged and not args.rebuild:
        common.fail(f"{LOCKFILE} has no conflict.")

    # A lockfile without a conflict has no "ours" stage; HEAD holds the fork's copy.
    common.git("checkout", *(["--ours"] if LOCKFILE in unmerged else ["HEAD", "--"]), LOCKFILE, cwd=root)
    log = common.log_dir("lockfile") / "install.log"
    code = common.run_logged([common.vp(root), "i", "--lockfile-only"], log, root, {**os.environ, "CI": "1"})
    if code != 0:
        common.fail(f"`vp i --lockfile-only` failed (exit {code}). See {log}")

    ours = integrity_changes(common.git("diff", "HEAD", "--", LOCKFILE, cwd=root))
    base = common.git("merge-base", "HEAD", "MERGE_HEAD", cwd=root)
    theirs = integrity_changes(common.git("diff", base, "MERGE_HEAD", "--", LOCKFILE, cwd=root))
    print(f"Rebuilt {LOCKFILE}: {len(ours[0])} integrity lines removed, {len(ours[1])} added.")
    if ours != theirs:
        print("The integrity changes differ from the merged side. Compare them before you stage:")
        print(f"  git diff HEAD -- {LOCKFILE}")
        print(f"  git diff {base[:12]} MERGE_HEAD -- {LOCKFILE}")
        sys.exit(1)
    common.git("add", LOCKFILE, cwd=root)
    print(f"The integrity changes match the merged side. Staged {LOCKFILE}.")


if __name__ == "__main__":
    main()
