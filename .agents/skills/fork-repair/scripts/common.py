"""Helpers that the fork repair scripts share. Not a script: the scripts import it."""

import datetime
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

# Agents read the output through a pipe. Without line buffering, progress shows only at the end.
sys.stdout.reconfigure(line_buffering=True)

# GitHub logs carry color codes. Their length and parameters vary, so a pattern is the simplest match.
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")


def fail(message: str) -> NoReturn:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def git(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        fail(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout.strip()


def git_ok(*args: str, cwd: Path | None = None) -> bool:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, check=False).returncode == 0


def repo_root() -> Path:
    return Path(git("rev-parse", "--show-toplevel"))


def container() -> Path:
    """The folder that holds .bare/ and one folder per worktree, read from git."""
    common_dir = Path(git("rev-parse", "--path-format=absolute", "--git-common-dir"))
    if common_dir.name != ".bare":
        fail(f"expected the git dir to be <container>/.bare, got {common_dir}")
    return common_dir.parent


def vp(root: Path) -> str:
    """The vp of this checkout, else the one of main/, else the one on PATH."""
    for candidate in (root / "node_modules/.bin/vp", container() / "main/node_modules/.bin/vp"):
        if candidate.exists():
            return str(candidate)
    found = shutil.which("vp")
    if found is None:
        fail("vp not found. Run the install in main/ or add node_modules/.bin to PATH.")
    return found


def utc_stamp(now: datetime.datetime) -> str:
    """Date and time, because two repairs can start on one day."""
    return now.astimezone(datetime.UTC).strftime("%Y-%m-%d-%H%M")


def log_dir(name: str) -> Path:
    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d-%H%M%S")
    folder = Path(tempfile.gettempdir()) / "fork-repair" / f"{name}-{stamp}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub("", text)


def test_env() -> dict[str, str]:
    """The VPS server sets T3_SERVICE_LAUNCHER_CONTEXT, and some tests fail when they inherit it."""
    env = dict(os.environ)
    env.pop("T3_SERVICE_LAUNCHER_CONTEXT", None)
    return env


def run_logged(command: list[str], log: Path, cwd: Path, env: dict[str, str] | None = None) -> int:
    """Runs in the foreground with all output in the log file. Returns the exit code."""
    with log.open("w") as handle:
        handle.write(f"$ (cd {cwd} && {' '.join(command)})\n\n")
        handle.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=handle, stderr=subprocess.STDOUT, check=False)
    return result.returncode


def tail(log: Path, count: int) -> str:
    lines = strip_ansi(log.read_text(errors="replace")).splitlines()
    return "\n".join(lines[-count:])
