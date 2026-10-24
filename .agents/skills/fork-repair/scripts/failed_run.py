# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Prints the failed jobs of a GitHub Actions run and the last useful log lines of each.

It takes a run id or a run URL. For each failed job, it prints the output of the step that failed,
without the step script, timestamps and color codes. The full log goes to a file. For a Fork Sync
run, it also prints the newest comment of the open issue "Fork sync: upstream merge failed".
"""

import argparse
import json
import subprocess
from dataclasses import dataclass

import common

DEFAULT_REPO = "Yarden-zamir/t3code"
SYNC_ISSUE_TITLE = "Fork sync: upstream merge failed"


@dataclass(frozen=True)
class RunRef:
    repo: str
    run_id: str


def parse_run_ref(value: str, default_repo: str) -> RunRef:
    """Accepts `123`, or `https://github.com/<owner>/<repo>/actions/runs/123[/job/...]`."""
    if value.isdigit():
        return RunRef(default_repo, value)
    path = value.removeprefix("https://").removeprefix("github.com/").split("/")
    if len(path) >= 5 and path[2] == "actions" and path[3] == "runs" and path[4].isdigit():
        return RunRef(f"{path[0]}/{path[1]}", path[4])
    raise ValueError(f"not a run id or run URL: {value}")


def clean_line(raw: str) -> tuple[str, str]:
    """`<job>\\t<step>\\t<timestamp> <text>` from `gh run view --log-failed` to (job, text)."""
    parts = raw.split("\t", 2)
    if len(parts) < 3:
        return "", common.strip_ansi(raw)
    job, _step, text = parts
    text = text.removeprefix("﻿")
    stamp, _, rest = text.partition(" ")
    if len(stamp) > 20 and stamp[4] == "-" and stamp[10] == "T" and stamp.endswith("Z"):
        text = rest
    return job, common.strip_ansi(text)


def failed_step_output(lines: list[str], count: int) -> list[str]:
    """The output of the first step that reported an error, after its script echo.

    `gh` names every step "UNKNOWN STEP" in --log-failed, so the steps are found by the
    `##[group]Run` line that opens each step and the `##[error]` line that ends a failed one.
    """
    error = next((index for index, line in enumerate(lines) if line.startswith("##[error]")), None)
    if error is None:
        return lines[-count:]
    start = next((index for index in range(error, -1, -1) if lines[index].startswith("##[group]Run ")), 0)
    end_group = next((index for index in range(start, error) if lines[index] == "##[endgroup]"), start)
    output = [line for line in lines[end_group + 1 : error + 1] if line.strip()]
    return output[-count:]


def gh(*args: str) -> str:
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        common.fail(f"gh {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def newest_sync_comment(repo: str) -> str | None:
    found = json.loads(
        gh(
            "issue",
            "list",
            "-R",
            repo,
            "--state",
            "open",
            "--search",
            f'in:title "{SYNC_ISSUE_TITLE}"',
            "--json",
            "number,url",
        )
    )
    if not found:
        return None
    issue = json.loads(gh("issue", "view", str(found[0]["number"]), "-R", repo, "--json", "url,comments,body"))
    comments = issue["comments"]
    body = comments[-1]["body"] if comments else issue["body"]
    return f"{issue['url']}\n{body.strip()}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run", help="run id or run URL")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"repository of a bare run id (default {DEFAULT_REPO})")
    parser.add_argument("--lines", type=int, default=60, help="log lines per failed job (default 60)")
    args = parser.parse_args()
    try:
        ref = parse_run_ref(args.run.strip(), args.repo)
    except ValueError as error:
        common.fail(str(error))

    run = json.loads(
        gh(
            "run",
            "view",
            ref.run_id,
            "-R",
            ref.repo,
            "--json",
            "workflowName,conclusion,event,headBranch,headSha,url,jobs",
        )
    )
    print(f"{run['workflowName']} {run['conclusion']} ({run['event']} on {run['headBranch']} {run['headSha'][:12]})")
    print(run["url"])
    failed_jobs = [job for job in run["jobs"] if job["conclusion"] in ("failure", "timed_out", "cancelled")]
    if not failed_jobs:
        print("No failed jobs.")

    out = common.log_dir(f"failed-run-{ref.run_id}")
    log_file = out / "failed.log"
    by_job: dict[str, list[str]] = {}
    if failed_jobs:
        raw = gh("run", "view", ref.run_id, "-R", ref.repo, "--log-failed")
        for raw_line in raw.splitlines():
            job, text = clean_line(raw_line)
            by_job.setdefault(job, []).append(text)
        log_file.write_text("".join(f"{job}\t{text}\n" for job, texts in by_job.items() for text in texts))

    for job in failed_jobs:
        steps = [step["name"] for step in job["steps"] if step["conclusion"] in ("failure", "timed_out", "cancelled")]
        print(f"\n== {job['name']}: {job['conclusion']}, failed steps: {', '.join(steps) or 'none listed'}")
        print("\n".join(failed_step_output(by_job.get(job["name"], []), args.lines)))

    if run["workflowName"] == "Fork Sync":
        comment = newest_sync_comment(ref.repo)
        print(f'\n== Issue "{SYNC_ISSUE_TITLE}": {comment or "no open issue"}')
    if failed_jobs:
        print(f"\nFull failed log: {log_file}")


if __name__ == "__main__":
    main()
