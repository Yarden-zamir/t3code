---
name: fork-repair
description: Scripts for the repair of the fork Yarden-zamir/t3code. Use to repair a failed Fork Sync, Fork CI or Fork Release run, to merge upstream into the fork by hand, and for any repeated fork maintenance chore. Each step is one plain command, and agents keep the scripts current.
---

# Fork repair

These scripts do the repeated steps of a fork repair. Each one is one command with no shell
substitution. It prints a short summary, writes long output to a log file, and prints the
path of that file. It exits with a non-zero code when its step fails.

Read [docs/fork-agents.md](../../../docs/fork-agents.md#repair-agent) and
[docs/fork/operations.md](../../../docs/fork/operations.md#fork-sync) for the repair rules.
This skill does not replace them.

## Scripts

Run each script from the root of the checkout that you repair. Run `<script> --help` for all
options.

| Command                                                                    | Use                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `uv run .agents/skills/fork-repair/scripts/failed_run.py <run id or URL>`  | Print the failed jobs of a run and the output of each failed step. For Fork Sync, also print the newest comment of the issue "Fork sync: upstream merge failed".                                       |
| `uv run .agents/skills/fork-repair/scripts/worktree.py create sync`        | Create the worktree `fork-sync-<UTC stamp>` on branch `fork-sync/<UTC stamp>` from `origin/main`, and install.                                                                                         |
| `uv run .agents/skills/fork-repair/scripts/worktree.py create fix <topic>` | Create the worktree `fork-fix-<UTC stamp>` on branch `fork-fix/<UTC stamp>-<topic>` from `origin/main`, and install.                                                                                   |
| `uv run .agents/skills/fork-repair/scripts/worktree.py remove <folder>`    | Remove a repair worktree and its local branch. It prints the uncommitted files and unpushed commits that it discards.                                                                                  |
| `uv run .agents/skills/fork-repair/scripts/lockfile.py`                    | In a merge with a `pnpm-lock.yaml` conflict: rebuild the fork lockfile, and stage it when its integrity changes match the merged side.                                                                 |
| `uv run .agents/skills/fork-repair/scripts/lockfile.py --rebuild`          | The same, when git merged `pnpm-lock.yaml` without a conflict but `vp i --frozen-lockfile` fails with `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`.                                                          |
| `uv run .agents/skills/fork-repair/scripts/route_tree.py`                  | In a merge that conflicts in `apps/web/src/routeTree.gen.ts` or moves route files: regenerate the route tree as the Vite router plugin does, and stage it.                                             |
| `uv run .agents/skills/fork-repair/scripts/shared_files.py`                | List the files that upstream and the fork both changed since the merge base, and write the upstream diff of each file to its own file.                                                                 |
| `uv run .agents/skills/fork-repair/scripts/shared_files.py --last-merge`   | The same review for the last upstream merge on `origin/main`.                                                                                                                                          |
| `uv run .agents/skills/fork-repair/scripts/fork_tests.py`                  | Run the fork tests in chunks of 20 (`--chunk <n>`). A chunk that runs out of memory (exit 137) runs again once in smaller chunks. Prints one re-run command.                                           |
| `uv run .agents/skills/fork-repair/scripts/fork_tests.py --files <file>`   | Run the test files listed in a file, for example the `failed.txt` of an earlier run.                                                                                                                   |
| `uv run .agents/skills/fork-repair/scripts/fork_tests.py --exclude <path>` | Skip the test files under a path prefix. `--only <path>` keeps only those files. Both repeat, and both also apply to `--files`.                                                                        |
| `uv run .agents/skills/fork-repair/scripts/checks.py`                      | Run typecheck, the migration check and the adopted pull request check, then `vp run fork:check` on a `fork-fix/` branch, or `vp lint` on the files that differ from upstream on a `fork-sync/` branch. |

- `worktree.py` reads the container (the folder that holds `.bare/`) from git. It works on the
  VPS (`/root/Github/t3code`) and on the Mac (`/Users/kcw/Github/t3code`).
- `fork_tests.py` selects the tests as the Fork Sync job does. It removes
  `T3_SERVICE_LAUNCHER_CONTEXT` from the test environment. It installs the Electron binary and
  Playwright Chromium when the selected tests need them.
- On the VPS, the `apps/server/` fork tests stop the agent session. There, run
  `--exclude apps/server/` and leave those files to Fork CI. A foreground command also stops
  after 10 minutes. If a run takes longer, run `--only apps/web/` and `--exclude apps/web/`
  as two runs. If a run still stops, run it again with `--from-chunk <n>` at its first chunk
  without a result.
- `shared_files.py` and `checks.py` need `upstream/main`. Run
  `git fetch --no-tags upstream main` first.
- The scripts call the existing `scripts/fork-*.ts` tools. They only run steps in order and
  report results.

## Keep this skill current

- When you do a repeated task by hand that no script covers, add a script or extend one for
  that real case.
- When a script is wrong, fix it. When a script is not used, remove it.
- Put the skill change in the pull request that you work on already, in the same commit
  series. Name each change in the pull request body under "Fork repair skill changes".
- Keep one row per command in the table above. This file is the index of the scripts.
- Keep changes generic. Do not add secrets. Do not add machine paths other than the VPS and
  Mac containers above. Do not add a one-off fix for one run.
- Write each script as a uv script with PEP 723 metadata. Use the standard library. Add a
  dependency only when it removes much code, and check its latest version first.
- Read paths from git, not from fixed paths. A script must work on the VPS (Linux, root) and on
  the Mac.
- Put pure logic in functions and test them in `scripts/test_scripts.py`. `vp run fork:check`
  runs these tests when a file of this skill changed.
- Never kill processes by a name or path pattern. Do not add command blocklists.

## Shell commands that pass Claude Code checks

Claude Code can ask for approval of a compound shell command, also in full access mode.
These rules keep each call plain:

- Run one command per call.
- Do not use `$(…)`, inline loops or `rm` inside a chain of commands. Use a script of this
  skill instead, or add one.
- Write a long list to a file, and pass the file to the next command.
- Run long commands in the foreground. A background command does not keep the thread awake.
