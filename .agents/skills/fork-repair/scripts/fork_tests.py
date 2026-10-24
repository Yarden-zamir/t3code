# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Runs the fork tests in chunks, as the Fork Sync job selects them.

The fork tests are the test files that the fork changed since the last merged upstream commit,
`git merge-base upstream/main HEAD`. apps/web tests run from apps/web in its unit and browser
projects. A chunk that dies with exit code 137 (out of memory) runs again once in smaller chunks.
"""

import argparse
import math
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import common

TEST_SUFFIXES = (".test.ts", ".test.tsx")
WEB = "apps/web/"
OOM_EXIT_CODES = {137, -9}


@dataclass(frozen=True)
class Chunk:
    group: str  # "root" or "web"
    files: tuple[str, ...]  # repo-relative paths


def select_tests(changed: list[str]) -> list[str]:
    return sorted({file for file in changed if file.endswith(TEST_SUFFIXES)})


def filter_prefixes(files: list[str], only: list[str], exclude: list[str]) -> list[str]:
    """Keep files under one of `only` (all when empty), then drop files under one of `exclude`."""
    kept = [file for file in files if not only or file.startswith(tuple(only))]
    return [file for file in kept if not file.startswith(tuple(exclude))]


def chunked(files: list[str], size: int) -> list[tuple[str, ...]]:
    if size < 1:
        raise ValueError("chunk size must be at least 1")
    return [tuple(files[start : start + size]) for start in range(0, len(files), size)]


def make_chunks(files: list[str], size: int) -> list[Chunk]:
    web = [file for file in files if file.startswith(WEB)]
    root = [file for file in files if not file.startswith(WEB)]
    return [Chunk("root", part) for part in chunked(root, size)] + [Chunk("web", part) for part in chunked(web, size)]


def smaller_size(size: int) -> int:
    return max(1, math.ceil(size / 4))


def command(vp: str, chunk: Chunk) -> tuple[list[str], str]:
    """The command and the folder (relative to the repo root) it runs in."""
    if chunk.group == "web":
        relative = [file.removeprefix(WEB) for file in chunk.files]
        return [vp, "test", "run", "--project", "unit", "--project", "browser", *relative], WEB
    return [vp, "test", "run", *chunk.files], "."


def changed_files(root: Path, base: str) -> list[str]:
    output = common.git("diff", "--name-only", "--diff-filter=AMR", base, "HEAD", cwd=root)
    return [line for line in output.splitlines() if line]


def prepare(root: Path, vp: str, files: list[str], log: Path) -> None:
    """As in the Fork Sync job. These installs do nothing when the binaries exist."""
    steps: list[list[str]] = []
    if any(file.startswith("apps/desktop/") for file in files):
        steps.append([vp, "run", "--filter", "@t3tools/desktop", "ensure:electron"])
    # Without --with-deps: that needs the system package manager. Add it when Chromium fails to start.
    if any(file.startswith("apps/server/") for file in files):
        steps.append(["node", "apps/server/node_modules/playwright-core/cli.js", "install", "--only-shell", "chromium"])
    if any(file.startswith(WEB) and ".browser.test." in file for file in files):
        steps.append(["node", "apps/web/node_modules/playwright/cli.js", "install", "--only-shell", "chromium"])
    for step in steps:
        with log.open("a") as handle:
            handle.write(f"$ {' '.join(step)}\n")
            handle.flush()
            if subprocess.run(step, cwd=root, stdout=handle, stderr=subprocess.STDOUT, check=False).returncode != 0:
                common.fail(f"prepare step failed: {' '.join(step)}. See {log}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--chunk", type=int, default=20, help="files per vp test run (default 20)")
    parser.add_argument("--base", help="base commit (default: git merge-base upstream/main HEAD)")
    parser.add_argument("--files", type=Path, help="run the files listed in this file, one per line, instead")
    parser.add_argument(
        "--only", action="append", default=[], metavar="PREFIX", help="run only files under this path prefix (repeatable)"
    )
    parser.add_argument(
        "--exclude", action="append", default=[], metavar="PREFIX", help="skip files under this path prefix (repeatable)"
    )
    parser.add_argument("--dry-run", action="store_true", help="print the files and chunks only")
    args = parser.parse_args()
    if args.chunk < 1:
        common.fail("--chunk must be at least 1")

    root = common.repo_root()
    if args.files is not None:
        files = select_tests([line.strip() for line in args.files.read_text().splitlines() if line.strip()])
        source = str(args.files)
    else:
        if args.base is None and not common.git_ok("rev-parse", "--verify", "-q", "upstream/main", cwd=root):
            common.fail("no upstream/main. Run `git fetch --no-tags upstream main` first.")
        base = args.base or common.git("merge-base", "upstream/main", "HEAD", cwd=root)
        files = select_tests(changed_files(root, base))
        source = f"changed since {base[:12]}"
    if args.only or args.exclude:
        files = filter_prefixes(files, args.only, args.exclude)
        source += f", only {args.only or 'all'}, without {args.exclude or 'none'}"
    missing = [file for file in files if not (root / file).exists()]
    if missing:
        common.fail(f"test files not found: {', '.join(missing)}")

    chunks = make_chunks(files, args.chunk)
    print(f"{len(files)} fork test files ({source}), {len(chunks)} chunks of at most {args.chunk}.")
    if not files:
        return
    logs = common.log_dir("fork-tests")
    (logs / "files.txt").write_text("\n".join(files) + "\n")
    if args.dry_run:
        for index, chunk in enumerate(chunks, 1):
            print(f"chunk {index} ({chunk.group}): {len(chunk.files)} files, from {chunk.files[0]}")
        print(f"file list: {logs / 'files.txt'}")
        return

    vp = common.vp(root)
    prepare(root, vp, files, logs / "prepare.log")
    env = common.test_env()
    failed: list[str] = []

    def run(chunk: Chunk, label: str) -> int:
        cmd, folder = command(vp, chunk)
        log = logs / f"chunk-{label}.log"
        code = common.run_logged(cmd, log, root / folder, env)
        status = "pass" if code == 0 else f"fail (exit {code})"
        print(f"{status:<16} chunk {label} ({chunk.group}, {len(chunk.files)} files)  {log}")
        return code

    for index, chunk in enumerate(chunks, 1):
        code = run(chunk, str(index))
        if code == 0:
            continue
        if code not in OOM_EXIT_CODES or len(chunk.files) == 1:
            failed.extend(chunk.files)
            continue
        print(f"chunk {index} ran out of memory, running it again in smaller chunks")
        for part_index, part in enumerate(chunked(list(chunk.files), smaller_size(len(chunk.files))), 1):
            if run(Chunk(chunk.group, part), f"{index}.{part_index}") != 0:
                failed.extend(part)

    if not failed:
        print(f"All {len(files)} fork test files passed. Logs: {logs}")
        return
    # Limit: a failed chunk lists all its files, also the ones that passed. Parse the vitest
    # output for the failed files if the re-runs get too slow.
    failed_list = logs / "failed.txt"
    failed_list.write_text("\n".join(failed) + "\n")
    print(f"{len(failed)} files in failed chunks: {failed_list}")
    print(f"Re-run them: uv run {Path(__file__).resolve()} --files {failed_list}")
    sys.exit(1)


if __name__ == "__main__":
    main()
