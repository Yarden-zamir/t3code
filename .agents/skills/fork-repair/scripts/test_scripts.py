"""Run: uv run --no-project --with pytest==9.1.1 pytest -q .agents/skills/fork-repair/scripts"""

import datetime

import pytest

import checks
import common
import failed_run
import fork_tests
import lockfile
import shared_files
import worktree

NOW = datetime.datetime(2026, 10, 23, 8, 58, 30, tzinfo=datetime.UTC)


def test_select_tests_keeps_only_test_files_as_in_fork_sync():
    changed = [
        "apps/server/src/a.ts",
        "apps/server/src/a.test.ts",
        "apps/web/src/b.browser.test.tsx",
        "apps/web/src/b.test.tsx",
        "README.md",
        "apps/server/src/a.test.ts",
    ]
    assert fork_tests.select_tests(changed) == [
        "apps/server/src/a.test.ts",
        "apps/web/src/b.browser.test.tsx",
        "apps/web/src/b.test.tsx",
    ]


def test_make_chunks_runs_web_tests_separately_and_respects_the_size():
    files = [f"apps/server/{index}.test.ts" for index in range(5)] + ["apps/web/src/x.test.ts"]
    chunks = fork_tests.make_chunks(files, 2)
    assert [(chunk.group, len(chunk.files)) for chunk in chunks] == [("root", 2), ("root", 2), ("root", 1), ("web", 1)]
    assert sum(len(chunk.files) for chunk in chunks) == len(files)


def test_filter_prefixes_applies_only_then_exclude():
    files = ["apps/server/a.test.ts", "apps/web/b.test.ts", "packages/c.test.ts"]
    assert fork_tests.filter_prefixes(files, [], []) == files
    assert fork_tests.filter_prefixes(files, [], ["apps/server/"]) == ["apps/web/b.test.ts", "packages/c.test.ts"]
    assert fork_tests.filter_prefixes(files, ["apps/"], ["apps/server/"]) == ["apps/web/b.test.ts"]


def test_web_command_runs_from_apps_web_with_relative_paths():
    command, folder = fork_tests.command("vp", fork_tests.Chunk("web", ("apps/web/src/x.test.ts",)))
    assert folder == "apps/web/"
    assert command == ["vp", "test", "run", "--project", "unit", "--project", "browser", "src/x.test.ts"]


def test_smaller_size_and_chunk_size_bounds():
    assert fork_tests.smaller_size(20) == 5
    assert fork_tests.smaller_size(1) == 1
    with pytest.raises(ValueError):
        fork_tests.chunked(["a"], 0)


def test_names_use_utc_date_and_time():
    local = NOW.astimezone(datetime.timezone(datetime.timedelta(hours=3)))
    assert worktree.names("sync", local, None) == ("fork-sync/2026-10-23-0858", "fork-sync-2026-10-23-0858")
    assert worktree.names("fix", NOW, "vite-import") == (
        "fork-fix/2026-10-23-0858-vite-import",
        "fork-fix-2026-10-23-0858",
    )


@pytest.mark.parametrize("topic", [None, "", "Has Space", "-lead", "a/b"])
def test_fix_names_reject_bad_topics(topic):
    with pytest.raises(ValueError):
        worktree.names("fix", NOW, topic)


def test_parse_run_ref_accepts_ids_and_urls():
    assert failed_run.parse_run_ref("39918728446", "o/r") == failed_run.RunRef("o/r", "39918728446")
    url = "https://github.com/Yarden-zamir/t3code/actions/runs/39918728446/job/1"
    assert failed_run.parse_run_ref(url, "o/r") == failed_run.RunRef("Yarden-zamir/t3code", "39918728446")
    with pytest.raises(ValueError):
        failed_run.parse_run_ref("https://github.com/o/r/pull/1", "o/r")


def test_clean_line_strips_bom_timestamp_and_colors():
    raw = "Merge upstream\tUNKNOWN STEP\t﻿2026-10-23T07:35:31.8531937Z \x1b[36;1mgit fetch\x1b[0m"
    assert failed_run.clean_line(raw) == ("Merge upstream", "git fetch")
    assert common.strip_ansi("\x1b]8;;http://x\x07link") == "link"


def test_failed_step_output_skips_the_script_echo_and_other_steps():
    lines = [
        "##[group]Run actions/checkout@v6",
        "checkout noise",
        "##[endgroup]",
        "##[group]Run set -euo pipefail",
        "set -euo pipefail",
        "##[endgroup]",
        "CONFLICT (content): Merge conflict in a.ts",
        "",
        "##[error]Process completed with exit code 1.",
        "##[group]Run later step",
    ]
    assert failed_run.failed_step_output(lines, 10) == [
        "CONFLICT (content): Merge conflict in a.ts",
        "##[error]Process completed with exit code 1.",
    ]
    assert failed_run.failed_step_output(["a", "b", "c"], 2) == ["b", "c"]


def test_shared_files_and_diff_names():
    assert shared_files.shared(["a", "b", "c"], ["c", "a", "d"]) == ["a", "c"]
    assert shared_files.diff_file_name("apps/web/x.ts") == "apps__web__x.ts.diff"


def test_integrity_changes_ignore_peer_key_lines():
    fork = "\n".join(
        [
            "-  a@file:x-1.tgz(react@19.3.0(supports-color@10.2.2)):",
            "+  a@file:x-2.tgz(react@19.3.0(supports-color@10.2.2)):",
            "-    resolution: {integrity: sha512-old, tarball: file:x-1.tgz}",
            "+    resolution: {integrity: sha512-new, tarball: file:x-2.tgz}",
        ]
    )
    upstream = fork.replace("supports-color@10.2.2", "supports-color@8.1.1").replace("    resolution", "  resolution")
    assert lockfile.integrity_changes(fork) == lockfile.integrity_changes(upstream)
    assert lockfile.integrity_changes(fork) != lockfile.integrity_changes(fork.replace("sha512-new", "sha512-other"))


def test_sync_branches_lint_fork_files_and_fix_branches_run_fork_check():
    assert checks.lintable(["a.ts", "b.md", "c.tsx", "a.ts", "d.mjs"]) == ["a.ts", "c.tsx", "d.mjs"]
    sync = [name for name, _ in checks.steps("vp", "fork-sync/x", ["a.ts"])]
    fix = [name for name, _ in checks.steps("vp", "fork-fix/x", ["a.ts"])]
    assert sync[-1] == "lint" and "fork:check" not in sync
    assert fix[-1] == "fork:check" and "lint" not in fix


def test_lint_errors_keep_only_error_lines():
    log = "a.ts:1:1: warning x(y): noise\nb.ts:2:3: error: Identifier `x` has already been declared\nc.ts:4:5: error t3code(z): cut it"
    assert checks.lint_errors(log) == [
        "b.ts:2:3: error: Identifier `x` has already been declared",
        "c.ts:4:5: error t3code(z): cut it",
    ]
