# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Lists the files that both upstream and the fork changed since their merge base.

It writes the upstream diff of each file to its own file, for the review of upstream changes in
fork areas. By default it compares upstream/main with origin/main, as before a sync merge.
With --last-merge, it reviews the last upstream merge on origin/main: the fork side is the first
parent and the upstream side is the second parent.
"""

import argparse
from pathlib import Path

import common


def shared(upstream_changed: list[str], fork_changed: list[str]) -> list[str]:
    return sorted(set(upstream_changed) & set(fork_changed))


def diff_file_name(path: str) -> str:
    return path.replace("/", "__") + ".diff"


def changed(base: str, head: str, root: Path) -> list[str]:
    return [line for line in common.git("diff", "--name-only", base, head, cwd=root).splitlines() if line]


def last_upstream_merge(root: Path, fork: str, upstream: str) -> str:
    """The newest merge on the fork branch whose second parent is in upstream main."""
    for commit in common.git("log", fork, "--merges", "--format=%H", "-n", "200", cwd=root).splitlines():
        if common.git_ok("merge-base", "--is-ancestor", f"{commit}^2", upstream, cwd=root):
            return commit
    common.fail(f"no upstream merge in the last 200 merges of {fork}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upstream", default="upstream/main", help="upstream side (default upstream/main)")
    parser.add_argument("--fork", default="origin/main", help="fork side (default origin/main)")
    parser.add_argument("--merge", help="review this merge commit: fork side ^1, upstream side ^2")
    parser.add_argument("--last-merge", action="store_true", help="review the last upstream merge on --fork")
    args = parser.parse_args()
    root = common.repo_root()
    for ref in (args.upstream, args.fork):
        if not common.git_ok("rev-parse", "--verify", "-q", ref, cwd=root):
            common.fail(f"unknown ref {ref}. Run `git fetch origin` and `git fetch --no-tags upstream main`.")

    merge = last_upstream_merge(root, args.fork, args.upstream) if args.last_merge else args.merge
    if merge is not None:
        fork_side, upstream_side = f"{merge[:12]}^1", f"{merge[:12]}^2"
        print(f"Merge {merge[:12]}: {common.git('log', '-1', '--format=%s', merge, cwd=root)}")
    else:
        fork_side, upstream_side = args.fork, args.upstream
    base = common.git("merge-base", fork_side, upstream_side, cwd=root)
    files = shared(changed(base, upstream_side, root), changed(base, fork_side, root))

    out = common.log_dir("shared-files")
    for path in files:
        diff = common.git("diff", base, upstream_side, "--", path, cwd=root)
        (out / diff_file_name(path)).write_text(diff + "\n")
    (out / "files.txt").write_text("".join(f"{path}\n" for path in files))
    print(f"Base {base[:12]}, upstream {upstream_side}, fork {fork_side}.")
    print(f"{len(files)} files changed on both sides:")
    for path in files:
        print(f"  {path}")
    print(f"Upstream diff per file (path with / as __): {out}")
    print(f"File list: {out / 'files.txt'}")


if __name__ == "__main__":
    main()
