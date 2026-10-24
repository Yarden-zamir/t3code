# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Creates or removes a repair worktree in the container that holds .bare/.

  create sync          branch fork-sync/<UTC stamp>, folder fork-sync-<UTC stamp>
  create fix <topic>   branch fork-fix/<UTC stamp>-<topic>, folder fork-fix-<UTC stamp>
  remove <folder>      removes the worktree and its local branch

The stamp is the UTC date and time, because two repairs can start on one day. Create fetches
origin (and upstream main for a sync), starts from origin/main and runs `CI=1 vp i`.
"""

import argparse
import datetime
import os
import sys
from pathlib import Path

import common

KINDS = ("sync", "fix")
REPAIR_PREFIXES = ("fork-sync/", "fork-fix/")


def names(kind: str, now: datetime.datetime, topic: str | None) -> tuple[str, str]:
    """The branch and the worktree folder name."""
    stamp = common.utc_stamp(now)
    if kind == "sync":
        if topic is not None:
            raise ValueError("a sync worktree takes no topic")
        return f"fork-sync/{stamp}", f"fork-sync-{stamp}"
    if kind != "fix":
        raise ValueError(f"kind must be one of {KINDS}")
    if not topic or not all(char.isascii() and (char.islower() or char.isdigit() or char == "-") for char in topic):
        raise ValueError("a fix topic is required: lowercase letters, digits and -")
    if topic.startswith("-") or topic.endswith("-"):
        raise ValueError("a fix topic must not start or end with -")
    return f"fork-fix/{stamp}-{topic}", f"fork-fix-{stamp}"


def worktree_branches(container: Path) -> dict[Path, str]:
    """Each worktree folder with its branch, from `git worktree list --porcelain`."""
    result: dict[Path, str] = {}
    current: Path | None = None
    for line in common.git("worktree", "list", "--porcelain", cwd=container / ".bare").splitlines():
        if line.startswith("worktree "):
            current = Path(line.removeprefix("worktree ")).resolve()
        elif line.startswith("branch ") and current is not None:
            result[current] = line.removeprefix("branch refs/heads/")
    return result


def create(kind: str, topic: str | None) -> None:
    container = common.container()
    try:
        branch, folder = names(kind, datetime.datetime.now(datetime.UTC), topic)
    except ValueError as error:
        common.fail(str(error))
    path = container / folder
    if path.exists():
        common.fail(f"{path} exists already")
    bare = container / ".bare"
    common.git("fetch", "origin", cwd=bare)
    if kind == "sync":
        common.git("fetch", "--no-tags", "upstream", "main", cwd=bare)
    common.git("worktree", "add", "-b", branch, str(path), "origin/main", cwd=bare)
    log = common.log_dir("worktree") / "install.log"
    code = common.run_logged([common.vp(path), "i"], log, path, {**os.environ, "CI": "1"})
    print(f"Worktree {path}")
    print(f"Branch {branch}")
    if code != 0:
        print(f"Install failed (exit {code}): {log}")
        print(common.tail(log, 30))
        sys.exit(1)
    print(f"Installed. Log: {log}")


def remove(folder: str) -> None:
    container = common.container()
    path = Path(folder) if Path(folder).is_absolute() else container / folder
    branch = worktree_branches(container).get(path.resolve())
    if branch is None or not branch.startswith(REPAIR_PREFIXES):
        common.fail(f"{path} is not a worktree of a fork-sync/ or fork-fix/ branch in {container}")
    # Show what the removal discards: uncommitted files and commits that no remote branch holds.
    dirty = common.git("status", "--short", cwd=path)
    unpushed = common.git("log", "--oneline", branch, "--not", "--remotes", cwd=path)
    if dirty:
        print(f"Discarded uncommitted files:\n{dirty}")
    if unpushed:
        print(f"Discarded commits that no remote branch holds:\n{unpushed}")
    common.git("worktree", "remove", "--force", str(path), cwd=container / ".bare")
    common.git("branch", "-D", branch, cwd=container / ".bare")
    print(f"Removed {path} and branch {branch}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="action", required=True)
    create_parser = sub.add_parser("create", help="create a repair worktree from origin/main")
    create_parser.add_argument("kind", choices=KINDS)
    create_parser.add_argument("topic", nargs="?", help="fix topic, for example vite-import")
    remove_parser = sub.add_parser("remove", help="remove a repair worktree and its local branch")
    remove_parser.add_argument("folder", help="worktree folder, absolute or relative to the container")
    args = parser.parse_args()
    if args.action == "create":
        create(args.kind, args.topic)
    else:
        remove(args.folder)


if __name__ == "__main__":
    main()
