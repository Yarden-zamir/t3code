# Fork operations

Maintainer procedures of the fork [Yarden-zamir/t3code](https://github.com/Yarden-zamir/t3code): releases, builds, installs, deploys and secrets.
User-facing fork features are in [features.md](features.md). Agents that operate the machines start with [fork-agents.md](../fork-agents.md).

## How the fork works

Fork main only moves forward. Nothing rebases or force-pushes it. To see all fork changes, run `git diff upstream/main...main`.

The fork disables every upstream workflow, because they need upstream's runners and secrets. Fork workflow files start with `fork-`. One exception stays on: `agent-context-budget.yml` runs on `pull_request`, so it gets no secrets and a read-only token, and fork PRs use its budget check.

### Fork Sync

`.github/workflows/fork-sync.yml` merges `pingdotgg/t3code` main into fork main, then the new heads of the [adopted upstream pull requests](#adopted-upstream-pull-requests). The interval task "Fork Sync trigger" on the VPS T3 server starts it every 2 hours with `gh workflow run`. The workflow has no GitHub schedule, because GitHub delays and drops scheduled runs.

- It runs the migration check, typechecks the merge, runs the fork tests and pushes the merge as a fast-forward. If main moved during the run, it merges the new main and pushes again.
- The fork tests are the test files that the fork changed since `git merge-base upstream/main HEAD`. A diff against a newer upstream main also lists files that only upstream changed.
- For a local sync repair, run `vp run typecheck` and those fork tests. The [fork-repair skill](../../.agents/skills/fork-repair/SKILL.md) runs both: `checks.py` and `fork_tests.py`. To run the tests by hand, use `vp test run <files>`, and run apps/web tests from `apps/web` with `vp test run --project unit --project browser <files>`; install Playwright Chromium first if needed. Do not run the changed-file checks over all upstream changes; wait for Fork CI on the repair pull request.
- The apps/web fork tests run from `apps/web`, in its unit and browser projects. A browser test needs Playwright Chromium, so the job installs it first.
- Before the other fork tests, the job installs the Electron binary for the desktop tests. When a fork test is in `apps/server`, it also installs Playwright Chromium for the server preview tests.
- A conflict only in `README.md` resolves by itself. See [Change the fork](#change-the-fork).
- If a merge conflicts, upstream closes an adopted pull request without a merge, or a check fails, the sync comments on the issue "Fork sync: upstream merge failed" and stops. The comment and the call to the repair agent name the reason, for example the adopted pull request that conflicted.
- After each sync, the job "Check upstream workflows" fails when another workflow is active, except `agent-context-budget.yml`. It prints the `gh workflow disable` command for that workflow.
- To pause the automatic sync, disable the task "Fork Sync trigger" on the VPS. Before you merge upstream by hand, read [Repair agent](../fork-agents.md#repair-agent).

### Migrations

Fork main registers only the migration ids and names that `upstream/main` has. The fork has no migrations of its own.

- The migrator skips every id up to the highest recorded id, whatever its name. So upstream's startup check (`assertV2MigrationsCanRun` in `apps/server/src/persistence/Migrations.ts`) refuses to start when the database recorded a migration of id 55 or higher under another name, or not at all. A fork-only id that upstream later gives to another migration thus stops every fork machine after the next Fork Sync.
- Keep fork state outside the migration registry: in fork files, the secret store or existing tables.
- To adopt an open upstream pull request that adds a migration, remove its entries from `Migrations.ts` and its migration files in the adoption commit. Its code must then work without that schema.
- `scripts/fork-check-migrations.ts` enforces the rule. `vp run fork:check` and the Fork CI Lint job run it. It compares the registry of the working tree with `upstream/main`, and fails on each id that upstream main lacks or names differently.
- When upstream merges a migration, Fork Sync merges its file and registry entry like any other upstream change, at upstream's final number. A migration that the fork removed at adoption comes back this way. The fork never recorded the number of the open pull request, so a new number is no problem.

### Adopted upstream pull requests

Fork main holds open `pingdotgg/t3code` pull requests that upstream did not merge yet. [`scripts/fork-adopted-upstream-prs.json`](../../scripts/fork-adopted-upstream-prs.json) lists them in stack order. Each entry has the number, the title, the upstream branch (`headRef`), the head that fork main holds (`mergedHead`), the reason, and the optional `forkRules`. Today the list is empty. Upstream merged the linked environments stack (#16653 to #16719) that it held.

After the upstream main merge, Fork Sync runs `node scripts/fork-adopted-prs.ts sync`. For each entry, in list order, it reads the state of the pull request with `gh`:

- Open with the listed head: nothing changes.
- Open with a new head: it fetches `refs/pull/<number>/head` and merges it with a merge commit that also updates `mergedHead`. It never cherry-picks or rebases.
- Open, but the head is not on the `pingdotgg` branch `headRef`: the sync stops, because main deploys what the sync pushes. Correct `headRef` if the list has it wrong. A pull request from another repository cannot be adopted: remove the entry.
- Merged into main: it drops the entry, because upstream main brings the final version. The run summary shows its fork rules as a warning, so that you undo the rules that upstream main now covers.
- Merged into the branch of another listed pull request: it drops the entry and appends its fork rules to that entry, which now carries its code.
- Merged into another branch: the sync stops. The owner decides whether the fork follows that branch.
- Closed without a merge: the sync stops. Fork main keeps the code. The owner decides whether the fork keeps it. To resume Fork Sync, remove the entry, and revert its code if the fork does not keep it.

A conflict stops the sync like an upstream conflict. The migration check then runs, because a new head can bring back a migration that the fork removed at adoption.

To repair a failed sync by hand, run the same script on the repair branch after the upstream merge. It stops at the first conflict. Resolve that merge by hand with `git merge --no-ff <head>`, set `mergedHead` of the entry in the merge commit, and run the script again. `node scripts/fork-adopted-prs.ts check` checks the list: its schema and format, that HEAD holds each `mergedHead`, and that HEAD holds no upstream squash commit of a listed pull request. `vp run fork:check` and the Fork CI Lint job run it.

To adopt another open pull request, merge its head with `git merge --no-ff` on a new branch from `origin/main` and add its entry at its place in the stack order. Apply the [migration rule](#migrations).

The fork rules for upstream's linked environments:

- The fork does not use upstream's manual links. `MachinePeers` gives `PeerLinks` and `PeerMcpClient` the kitshn links, and its `link` and `unlink` refuse.
- The fork hooks in upstream files: `MachinePeers.layer` in the runtime core of `server.ts`, and the refusal layer in `cli/environment.ts`.
- Upstream's Labs setting `linkedEnvironmentsEnabled` gates links on each machine, also the kitshn links. Set it on the owner's machines through the shared `t3.settings` on kitshn.

### Fork Release

`.github/workflows/fork-release.yml` builds the desktop apps and the server archives on each push to main and on manual dispatch.

- A push that changes only `docs` or `*.md` builds no release. The next release lists its commits. If the commit already has a release, the run stops early.
- Only one release run works at a time, and no run is cancelled, so a release is never half published. GitHub keeps one waiting run, and a newer push replaces it. A burst of pushes thus builds only the running commit and the newest commit.
- `scripts/fork-release-notes.ts` writes the release notes from the first-parent commits on main after the previous release tag. Each line names its source, upstream or fork. The fork pull requests come last, because the update popover shows the last lines first and drops headings.
- The release builds macOS arm64 (signed), Windows x64 (unsigned), and Linux x64 and arm64 AppImages (unsigned) in parallel, on GitHub-hosted runners. Each platform publishes when its build is done.
- The desktop jobs take the Rust helpers (resource monitor, Linux capture helpers) from the Actions cache while their crate sources stay the same. A new Rust version alone builds no new helpers. To force a build, delete the `resource-monitor-*` and `linux-capture-helpers-*` caches.
- Each Linux build also publishes the server archive `t3-<version>-linux-<arch>.tar.gz`. It holds the `t3` single executable, the web client and the native packages, so `t3 serve` runs without Node.
- When both Linux archives are on the release, the job "Server checksums" uploads `SHA256SUMS` last. The server updaters (`t3 update`, `t3 service install`, "Update everything") verify the archives against it. `t3 update` skips a release without `SHA256SUMS`. For "Update everything", each server installs the newest release that has it.
- The release carries `nightly-mac.yml`, `nightly.yml` (Windows), `nightly-linux.yml` (x64) and `nightly-linux-arm64.yml` for electron-updater. Until a platform adds its file, its apps find no update in the new release.
- A manual run from a branch other than main publishes no release. It uploads the files of each platform as workflow artifacts.
- `CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts` points the server updaters at the fork releases.

The builds use the `nightly` update channel, the app id `com.t3tools.t3code` and the data directory `~/.t3`. They replace the upstream Nightly app and keep its data.

### Daily release

Each day at 09:00 Israel time, the VPS task "Fork daily release" promotes a nightly to a release. It builds nothing.

- `node scripts/fork-daily-release-data.ts` picks the newest nightly on main that has `SHA256SUMS`. It prints JSON with the changes since the previous release: fork changes, upstream changes and integration. If no new nightly exists, it prints `skip`.
- Integration is a merge that brings upstream commits: a Fork Sync merge or a sync pull request. Its fork commits are the conflict resolutions and fixes.
- Without a previous release, the range starts where the fork began, and the upstream group holds only the last upstream merge.
- An agent writes a notes plan from the JSON. The plan groups related changes into clusters, with a name and one sentence each, and orders clusters and changes by importance and cool factor. `--notes <plan.json>` prints the notes from it. The script fails and names each change that is missing, repeated or unknown.
- The notes start with the top 5 clusters of each section, the highlights. The full changelog lists every cluster on one line, with its changes in a collapsed block below it. Then the agent runs `gh release edit <tag> --prerelease=false --latest --title "T3 Code Fork <Israel date> (<first 12 characters of the commit>)" --notes-file <file>`. The tag and the assets stay.
- The title keeps the commit in brackets, because Fork Release and Fork Android find the release of a commit by its name.
- Each pull request item carries the images of its body, without badges and videos. A cluster in the plan can pick its images with `"images": [<url>, ...]`, from the images of any of its changes. The agent looks at each image and keeps only images that show what the line says. An empty list shows none. The script fails for a URL that no change of the cluster has. Without `images`, the notes show up to 4 images of the first change that has any, and each change's own images in the fold. The script reads the bodies with one GraphQL call per 100 pull requests, for the fork and for upstream.
- A change without a pull request body, such as a direct commit, gets its images from `docs/fork/release-images.json`. The file maps a ref (`#123` or the full commit) to a list of `{url, alt}`. The data script adds these images to the matching fork change. Add an image there through a pull request, so that it gets a review.
- A release body holds at most 125000 characters. Over the budget of 120000 characters, the full changelog leaves out the screenshots of its last clusters first.
- A change is breaking when its pull request title has `!` after the type, its body has a "Breaking changes" section, it has the `breaking` label, or a commit has a `BREAKING CHANGE:` footer. Upstream changes count the same way. The JSON marks it `breaking: true`, with `breakingNote` from that section or footer.
- The plan gives each breaking change one line in `breaking`: `{section, change, line}`, with what changed, who is affected and what to do. The script fails when a breaking change has no line. The notes start with a "⚠️ Breaking changes" section, and a short warning sits right above "Full changelog", so the desktop update popover shows it first. The size budget never removes them.
- `--release <tag>` writes the data of a given release again, for example to rewrite its notes.
- Every updater picks a release by its tag, not by the prerelease flag. The tag keeps `-nightly.`, so nightly users get the next nightlies as before.
- The desktop update popover shows the last 8 lines of the notes before "Full changelog". So the highlights come before that heading, and the full lists come after it. The popover leaves out `<details>` blocks. Desktop builds from before this change show a "Screenshots" line for each block in those 8 lines.

### Fork CI

`.github/workflows/fork-ci.yml` runs the `ci.yml` commands on GitHub-hosted runners, for each push to main and each pull request to main. `ci.yml` needs upstream's Blacksmith runners, so it is disabled.

- A newer push to main or to a pull request cancels the Fork CI run of the older push.
- The job "Fork CI result" fails when any Fork CI job fails or is cancelled. Branch protection requires this one check.
- Fork CI compares a push with the commit of the last green push run, and a pull request with its base. Upstream's `.github/scripts/ci-changes.cjs` maps the changed files to packages and their dependents. A pull request runs only the jobs that those packages need. When only `docs/` or Markdown files changed, only the Lint job runs, on the changed files. A code push to main and a manual run run every job.
- Each job installs through upstream's `.github/actions/setup-ci-deps`. A cache hit makes no request to npm.
- The Lint job also runs `scripts/fork-check-doc-links.ts`. It fails on a relative link or an anchor that does not resolve in `README.md`, `docs/fork*` or `docs/fork/`.
- The Lint job also fetches upstream main and runs `scripts/fork-check-migrations.ts`. See [Migrations](#migrations).
- The Lint job also fetches the commits of HEAD without their files and runs `node scripts/fork-adopted-prs.ts check`. See [Adopted upstream pull requests](#adopted-upstream-pull-requests).
- Fork runs skip the upstream tests in `apps/server/src/fork/excludedUpstreamTests.ts` and `apps/web/src/forkExcludedUpstreamTests.ts`, each with its reason. The web list holds browser tests that the smaller runner of Fork CI cannot run in time.

### Repair agent

A failed Fork Sync, Fork Release or Fork CI run on main runs its `notify_agent` job, `scripts/fork-notify-agent.sh`. A pull request never calls it.

- The script posts the run to `T3_AGENT_WEBHOOK_URL`, the webhook task "Fork repair" on the VPS T3 server (`yarden-zamir-vps-2`), project "t3code fork" (`/root/Github/t3code/main`).
- The script retries once a minute for 15 minutes, so a server restart of the VPS does not lose the call. Each auto-update of the VPS restarts its server for about 20 seconds.
- A manual run with `notify_agent=false` does not post. A failure right after a failure of the same workflow does not post either, when the first notify job succeeded and the first failure started less than 90 minutes before. This window is shorter than the 2-hour sync interval, so the next scheduled failure can call again.
- The repair agent ignores a cancelled run.
- How the agent works, and how to stop it: [Repair agent](../fork-agents.md#repair-agent). Its repair steps use the scripts of the [fork-repair skill](../../.agents/skills/fork-repair/SKILL.md).

## Change the fork

Before a plan or status report, list recent merged fork PRs for the same topic:

```sh
gh pr list -R Yarden-zamir/t3code --state merged --search '<topic> sort:updated-desc'
git log origin/main -- <files>
```

Name the fork PRs that the plan builds on. Check fork merges first, then upstream.

- Prefer upstream scripts, CLI and docs. Explain why upstream alone does not meet the need.
- Keep fork changes generic. Add no special code paths for one machine or cloud provider.
- Put fork code in fork files: `forkSettings.ts`, `forkRpc.ts`, `fork/forkWs.ts`, `Fork*` components and `fork-*` scripts. Keep hooks in upstream files to one line.
- The web thread card layout block in `Sidebar.tsx` is the known exception. Revisit it after upstream changes that block in two consecutive syncs. Also revisit it when upstream adds a card layout hook.
- If an open upstream PR covers the feature, keep the fork version until upstream merges it. Add a code comment naming that PR and the replacement trigger. Do not open an upstream PR or issue.
- Put every fork behavior behind a setting. A setting that only adds something without noticeable cost starts on. A setting that changes existing behavior or layout, installs or restarts anything, changes access or needs setup starts off.
- Put the schema field of a fork setting in `packages/contracts/src/forkSettings.ts`, not in the upstream `settings.ts`.
- Put a new fork setting in the upstream settings section where a user looks for it. Add its entry with a `place` to `FORK_SETTING_GROUPS` (`forkSettingsCatalog.ts`), its row in `FORK_SETTING_ROWS` (`ForkSettingsSlot.tsx`), and its search item with the `to` of that place (`forkSettingsSearch.ts`). Settings > Fork lists it from the catalog. For a new place, add it to `FORK_SETTING_PLACES` and put one `<ForkSettingsSlot place=... />` line in the upstream page. Add a fork preference to the reset list in `forkSettingsRestore.ts`.
- `forkSettingsRegistration.test.ts` fails when a fork setting has no Fork page row, no place outside the Fork page, no search result at its place, or no Restore defaults rule. It also fails when a place has no slot or two slots. A setting without a row needs a reason in that test.
- The top of `README.md`, up to the first `---` line, lists the fork features and fixes. Keep one line per feature, with a link to its section in [features.md](features.md). A pull request that adds, removes or changes a fork feature updates its line and its section.
- If a Fork Sync merge conflicts only in `README.md`, the sync keeps the fork section up to the first `---` line and takes the upstream README below it. A conflict in another file stops the sync.
- If a sync conflicts on a tooltip line with a `ShortcutHint` (the key chips in upstream tooltips), take the upstream line, then add one `ShortcutHint` back. If the same file conflicts again, keep the upstream tooltip text in that file.
- A merge without conflicts can still break a fork feature. Each fork feature that changes upstream behavior needs a test of that behavior, so that the fork tests catch the break.
- Put fork tests in a fork test file next to the upstream test file: `foo.fork.test.ts` next to `foo.test.ts`, `Foo.fork.browser.test.tsx` next to `Foo.browser.test.tsx`. Do not add tests to an upstream test file. Change an upstream test only when a fork change breaks it, and keep that change small. Upstream changes its test files often, so fork tests in them cause sync conflicts.
- Prefer automated setup over manual instructions when the permission cost is acceptable. Keep documentation for steps that code cannot do.
- If setup lacks permission or an API refuses it, show the manual step, dashboard links and documentation links. Name the missing permission; never show the raw API error. Apply this rule to all fork automation.

### Harmless verification

Screenshots, T3 browser previews, read-only checks and worktree dev servers on copied data need no permission.
This fork rule overrides the `AGENTS.md` permission default for browsers and its ban on subagent dev servers.
Delegate slow verification to a low-cost subagent when suitable.
Still ask before live-state changes outside the request, publishing outside the fork, or deleting work.
Never write directly to live `~/.t3/userdata`.

Seed copied data with the dev server stopped:

```sh
vp run migrate-dev-db
```

Then start the worktree dev server. Use its own UI or API, not the live-server tool CLI.

```sh
node scripts/fork-dev-server.ts start              # add `-- --share` to share on the tailnet
node scripts/fork-dev-server.ts status
node scripts/fork-dev-server.ts stop
node scripts/fork-dev-server.ts orphans            # reports leftover dev processes, never kills
```

`start` runs `vp run dev` in a new process group, writes the log to `.t3/dev-server.log` and prints the ports and the `pairingUrl`.
`stop` stops the whole group, so that no `node --watch` process stays alive.
It refuses a group that does not run in this worktree.
`orphans` lists dev process groups with a deleted folder, or under PID 1 without a record.
It prints a `kill` command for each group. Only the owner runs it, after a check. Agents report the groups.
The helper works on macOS and Linux, not on Windows.

### Tool blockers

Check the intended tool first each session: Device panel, browser preview or MCP tool.
If it fails, stop and tell the owner before any workaround.
Start the reply with a red blocker line. State the cause and exact fix commands.
Ask: "Fix it now, or work around it?" Wait for the answer; do not silently switch tools.

## Check a change before you push

Run this command before every push:

```sh
vp run fork:check
```

- It runs the quick Fork CI checks on the files that changed since the merge base with `origin/main`. Uncommitted and untracked files count.
- On a branch with a merge whose second parent is not in `origin/main`, it prints one line and exits 0 without checks. This keeps sync repairs from checking every upstream change locally. Run `vp run typecheck` and the fork tests described in [Fork Sync](#fork-sync), then wait for Fork CI on the pull request.
- The steps are format and lint of the changed files, knip, typecheck of the changed packages, the tests of the changed files, the doc link check, the migration check, the check of the adopted upstream pull requests, and the Python tests of the fork-repair skill when its scripts changed. The migration check reads the local `upstream/main`, so run `git fetch upstream main` first. The tests are the changed test files, the tests next to changed source files, `forkSettingsRegistration.test.ts`, the React Compiler coverage test of a changed web or mobile app, and the import cycle test (`dependency-graph.test.ts`) of a changed mobile app.
- It prints one line per step: pass, fail or skipped with the reason. It exits with an error when a step fails.
- Without Playwright Chromium, it skips the browser tests and prints the install command.
- Fork CI still runs the full test suites, the typecheck of dependent packages, the desktop build and the Rust crates.
- Keep `fork:check` fast. Time each proposed step before adding it; never add a slow step.
- A few seconds is acceptable; tens of seconds is not. Weigh value against time without asking the owner.
- Report the decision and measured time. Leave slow checks to CI.

## Versions

The version is `<upstream base version>-nightly.<UTC date>.<build number>`, for example `0.0.46-nightly.20261010.3`.

- The build number is one integer, because the build and the app read the update channel from `-nightly.<date>.<number>`.
- CI uses the workflow run number times 10000, for example `0.0.46-nightly.20261011.180000`.
- A local build adds the minute of the UTC day (1 to 1440) to the newest CI number, for example `0.0.46-nightly.20261011.180845`. A local build is thus newer than the CI release it follows, and older than the next CI release.

## App icon

The fork replaces the nightly icons with the Tick3d lightning icon from `assets/fork/tick3d-macos.svg`. The desktop app, its notifications and the bundled web page use these files. The Android APK uses the layers `assets/fork/tick3d-android-{foreground,background,monochrome}.svg`, as PNG files in `apps/mobile/assets/fork/`. `apps/mobile/src/lib/forkAndroidIcon.ts` applies them when `T3CODE_ANDROID_PACKAGE` is set, which only `scripts/fork-android-apk.sh` does. To change the icon, edit the SVG and run:

```sh
S=assets/fork/tick3d-macos.svg N=assets/nightly T=$(mktemp -d)
rsvg-convert -w 1024 -h 1024 $S -o $N/nightly-macos-1024.png && cp $N/nightly-macos-1024.png $N/nightly-universal-1024.png
rsvg-convert -w 180 -h 180 $S -o $N/nightly-web-apple-touch-180.png
for s in 16 32; do rsvg-convert -w $s -h $s $S -o $N/nightly-web-favicon-${s}x${s}.png; done
for s in 16 24 32 48 64 128 256; do rsvg-convert -w $s -h $s $S -o $T/$s.png; done
magick $T/{16,24,32,48,64,128,256}.png $N/nightly-windows.ico && cp $N/nightly-windows.ico $N/nightly-web-favicon.ico
```

## macOS signing

The fork signs with the self-made certificate "Yarden Zamir T3 Fork". The fork does not notarize. Squirrel.Mac installs an update only when the update has the same signature as the running app, so every build must use the same certificate.

- The certificate, the key and the `.p12` password are in `_shared/signing/` in the repository container. They are not in git.
- The repository secrets `CSC_LINK` (base64 `.p12`) and `CSC_KEY_PASSWORD` hold the same certificate.
- `T3CODE_DESKTOP_MAC_SELF_SIGNED=true` tells `scripts/build-desktop-artifact.ts` to skip the passkey entitlements. Passkeys need an Apple team.
- The first install of a fork build is manual, because the upstream Nightly has another signature. macOS blocks the first start of an app that is not notarized. To allow it, Control-click the app and select Open.

### Trust the certificate on your Mac

Do this one time before the first local build:

```sh
security import _shared/signing/cert.p12 -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -P "$(cat _shared/signing/p12-password.txt)"
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db _shared/signing/cert.pem
security find-identity -v -p codesigning
```

The last command must list "Yarden Zamir T3 Fork".

## Local Mac build

A local build is the fast way to test a change on this Mac. It does not replace the normal flow: merge the change to main, and its CI release reaches every machine.

| Command                                 | Result                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/fork-desktop-mac.sh`           | Writes the signed ZIP and `nightly-mac.yml` to `release/`. It skips the DMG, which only a first manual install uses.          |
| `scripts/fork-desktop-mac.sh --install` | Quits T3, keeps the previous app in `_shared/backup/`, installs the new build and starts it. The next CI release replaces it. |
| `scripts/fork-desktop-mac.sh --publish` | Push the commit first. Creates a prerelease on the fork. Installed fork apps offer it as an update.                           |

## Server updates

A headless server that runs as the upstream background service (`t3 service install`) updates from the fork releases. The install is the upstream self-update. It unpacks the release into `<T3 home>/runtime/versions/<version>`, and the service launcher starts it on trial. If the new version does not start, the launcher goes back to the old version.

- Keep a release on each code push to main; never slow the update path. See [Fork Release](#fork-release) for the docs-only exception.
- Servers install updates only when idle.
- Ask the owner before migrating Oracle-VPS or VPS to another install path. Routine version-directory updates are not install-path migrations.
- The user setting is [Server auto-update](features.md#server-auto-update). It checks the fork releases every 5 minutes.
- A release is ready when it has `SHA256SUMS`. A version that rolled back or failed is not tried again. A newer release is tried.
- The kitshn command install-update of the T3 card works on such a server too. It waits for no running agent turn or background shell, even with `forkAutoUpdate` off. A program in a terminal thread holds it for at most 6 hours, then the update ends the program after a notice in its terminal.
- The `updateChannel` setting of the T3 card picks the feed: `nightly` (default) takes each nightly, `daily` takes only the releases that [Daily release](#daily-release) promoted. A server never installs an older build when the feed changes.
- A restart stops the running turns. "Continue threads after restarts" (`continueThreadsAfterServerUpdate`) and [Recover interrupted agents](features.md#recover-interrupted-agents) continue them.
- "Update everything" and `t3 update` also install fork releases. A self-update request for a version without a fork release installs the newest fork release instead. The Play Store app checks upstream releases, so its "Check for updates" installs the newest fork release.

## Deploy a local build

To try a change on a headless server before a release, deploy a build of your checkout over SSH. The server must run as the background service.

```sh
scripts/fork-deploy-local.sh <ssh-host>
```

- The script reads the system of the server with `ssh <ssh-host> uname -sm`. It supports Linux x64 and arm64.
- It builds the web client and the `t3` executable here. It takes the native packages and the resource monitor from the newest fork release that has `SHA256SUMS`.
- If the checkout changes `apps/server/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` or `patches` since that release, the script stops. Such a change needs a release.
- The version follows the rule of the local Mac build in [Versions](#versions), so `forkAutoUpdate` replaces it with the next release.
- On the server, the script unpacks the build into `<T3 home>/runtime/versions/<version>` and runs `t3 update <version> --yes`. The service restarts at once, and the restart stops running agent turns.
- After the switch, the script waits up to 90 seconds until `/.well-known/t3/environment` of the server reports the new version. If it does not, the script runs `t3 update <previous version> --yes --allow-downgrade` on the server and fails. If that rollback fails, it prints the command to run on the server. The earlier version is still in `runtime/versions`.
- `<T3 home>` is `~/.t3` of the SSH user, or `T3CODE_HOME` of the SSH session. Connect as the user that runs the service. On the VPS, this user is `t3`, not root.
- To build only, run `scripts/fork-deploy-local.sh --archive linux-x64` or `--archive linux-arm64`. The archive is in `release/`.

## Install the fork

`scripts/fork-install/` installs the fork on a new machine. Then join the machine to kitshn: `kitshn join <code> --server <address>`. "Add machine" on the kitshn map gives the code.

```sh
curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.ps1)))
```

- On macOS, `install.sh` downloads the newest nightly `.dmg`, copies the app to `/Applications` and opens it.
- On Windows, `install.ps1` downloads and runs the newest nightly `.exe`.
- On Linux with a display (`DISPLAY` or `WAYLAND_DISPLAY`), `install.sh` downloads the newest nightly AppImage to `~/Applications/T3-Code.AppImage`, adds a menu entry and starts it. AppImages need FUSE 2, for example `sudo apt install libfuse2t64`.
- The macOS and Linux desktop installs keep an installed app, because the app updates itself. `--force` replaces it.
- On Linux without a display, `install.sh` runs `scripts/install.sh`, the upstream installer pointed at the fork releases. It unpacks the newest release into `~/.t3/runtime/versions/<version>` and links `~/.local/bin/t3` to it. Then it runs `t3 service install`. The machine needs no Node.
- The drop-in file `~/.config/systemd/user/t3code.service.d/fork.conf` keeps the headless server on `127.0.0.1:3773` with the PATH of the installer shell.
- `t3 service install` turns on lingering, so the server keeps running after logout. If that needs an administrator, it says so. See [background-service.md](../user/background-service.md#troubleshooting).
- The installers read the release list of the GitHub API, because the nightlies are prereleases and `releases/latest` skips them.
- Run `install.sh --help` for the options.

### Set up a headless Linux machine

These steps set up a Linux server without a display, for example an Oracle Cloud Ubuntu 24.04 machine on Ampere (arm64). Run them over SSH as the normal user, for example `ubuntu`. Do not run the installer with `sudo` or `su`, because the server runs as a systemd user service.

1. On the machine, install the fork:

   ```sh
   sudo apt-get update && sudo apt-get install -y curl tar ca-certificates libatomic1
   curl -fsSL https://raw.githubusercontent.com/Yarden-zamir/t3code/main/scripts/fork-install/install.sh | bash
   ```

2. Install kitshn 2 and join the machine with a code from "Add machine" on the kitshn map.
3. Set up the tunnel, see [Set up the tunnel by hand](#set-up-the-tunnel-by-hand).

- The tunnel connects outbound, and the server listens only on `127.0.0.1`, so the cloud firewall needs no change. On Oracle Cloud, keep the default security list and the `iptables` rules of the image.
- To check the server, run `t3 service status` and `systemctl --user status t3code.service`.
- To update the server by hand, run `t3 update`. See [Server updates](#server-updates).

### Set up the tunnel by hand

T3 does not make the tunnel of a machine. Until kitshn makes it from the `site` of the T3 card, set it up with these steps.

1. In Cloudflare Zero Trust, create a tunnel, for example `t3-oracle`. Give it the public hostname `t3-oracle.yarden-zamir.com` with the service `http://127.0.0.1:3773`. Keep the tunnel token.
2. Make sure that the Access app "T3 Code servers" covers the new hostname.
3. Install `cloudflared` and run the tunnel as a system service:

   ```sh
   curl -fsSLo /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
   sudo dpkg -i /tmp/cloudflared.deb
   sudo cloudflared service install <tunnel-token>
   ```

4. Give the server its tunnel hostname and the Cloudflare Access login. Copy the Access values from the server environment of the VPS. The kitshn grants decide who gets in. `t3 service install` and `t3 update` replace only the unit file, so this drop-in file stays after an update.

   ```sh
   mkdir -p ~/.config/systemd/user/t3code.service.d
   cat > ~/.config/systemd/user/t3code.service.d/tunnel.conf <<'EOF'
   [Service]
   Environment=T3CODE_TUNNEL_PAIRING_URL=https://t3-oracle.yarden-zamir.com
   Environment=T3CODE_CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
   Environment=T3CODE_CLOUDFLARE_ACCESS_AUD=<audience tag of the Access app>
   EOF
   systemctl --user daemon-reload && systemctl --user restart t3code.service
   ```

## Hand a T3 host over to kitshn

kitshn replaces the portal. The host `t3-<slug>.yarden-zamir.com` of each machine moves to kitshn one machine at a time. The machines are `mac`, `vps`, `win` and `oracle-vps`. kitshn makes its own Access application for `<host>/*` and its own ingress rule. Then it moves the CNAME record of the host to its tunnel. After that, `scripts/fork-host-handover.ts` removes the part of the portal:

1. It takes the host out of the Access application "T3 Code servers".
2. It deletes the ingress rule of the host on the portal tunnel `t3-<slug>`.
3. It deletes no DNS record and changes no other Access application. The path applications on `t3-vps` stay.

The script stops if kitshn did not take the address: the CNAME record must point at a tunnel that is not a `t3-` portal tunnel, and a `kitshn` Access application must cover `<host>/*`. It also stops if the portal tunnel is managed on its machine, or if "T3 Code servers" has no policies. Each step checks the current state first, so a second run changes nothing. Before step 2, the script saves the old ingress rule to `~/.local/state/t3-host-handover/<host>.json` (or below `T3_HOST_HANDOVER_STATE_DIR`). `--undo` reads that file.

Do these steps for one machine at a time. The example uses `mac`.

1. Install a T3 release with the kitshn provider on the machine, and check that it registers with kitshn: Settings > Machines shows "Connected to kitshn". kitshn refuses "Take the address…" until the daemon reports `access`. Until the handover, the host keeps its portal path: the portal Access application, the portal tunnel, and on `oracle-vps` the tunnel that T3 runs from `machine-map-tunnel.json`.
2. Give each phone that used a portal app token a kitshn device invite, see [Device invites](features.md#device-invites). Its saved sessions keep working, but a new pairing needs the device token.
3. Before the `oracle-vps` handover, check what `t3-oracle-vps.yarden-zamir.com` serves. Its DNS record comment says "T3 machine map".
4. In kitshn, open the T3 card of the machine and select "Take the address…". Wait until the card shows the address.
5. Make a Cloudflare API token with "Access: Apps and Policies Edit", "Cloudflare Tunnel Edit" and "DNS Read" for the account and the zone `yarden-zamir.com`.
6. Write the token to a file, for example with T3 `request_secret` and delivery "file". Do not paste the token in a chat.
7. Run a dry run, and read the steps and API calls that it prints:

   ```sh
   CLOUDFLARE_HANDOVER_TOKEN_FILE=<token file> node scripts/fork-host-handover.ts mac --dry-run
   ```

8. Run the handover:

   ```sh
   CLOUDFLARE_HANDOVER_TOKEN_FILE=<token file> node scripts/fork-host-handover.ts mac
   ```

9. Open `https://t3-mac.yarden-zamir.com` and check that the kitshn Access login and the T3 app open.
10. After the last machine, delete the API token in the Cloudflare dashboard and delete the token file.

To undo the part of the portal, run the script with `--undo`. It puts the host back into "T3 Code servers" and the old ingress rule back on the portal tunnel. It deletes nothing of kitshn. The DNS record still points at kitshn after the undo. To point the record back at the portal, select "Give the address back…" on the T3 card in kitshn.

```sh
CLOUDFLARE_HANDOVER_TOKEN_FILE=<token file> node scripts/fork-host-handover.ts mac --undo
```

On `oracle-vps`, T3 runs the portal tunnel only while kitshn does not serve the host. It stops the tunnel when kitshn lists the host in `served`, after the DNS record moved to kitshn's tunnel, and starts it again when a give-back drops the host from that list. `machine-map-tunnel.json` stays.

Do not remove a handed-over machine in the portal. The portal then deletes the DNS record that it made, and kitshn uses that record now.

## Guest links through Cloudflare Access

A guest link on a tunnel host needs two more Cloudflare Access applications: an Allow application for the guest page and routes, and a Bypass application for the public web build files. See [Guest links over the tunnel](features.md#guest-links-over-the-tunnel). The machine map portal made them for each machine host. The portal is gone, and the applications stay.

The guest page loads only these paths. A real load of the page and the guest code give the list.

| Path                    | What                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `/guest`                | The page. The server answers with `index.html`.                          |
| `/api/guest/*`          | The guest routes: join, session, messages, stream, items, files, images. |
| `/assets/*`             | The web build: scripts, styles, fonts, workers.                          |
| `/apple-touch-icon.png` | The start screen logo.                                                   |
| `/favicon.ico`          | The tab icon.                                                            |
| `/manifest.webmanifest` | The app manifest. Without it, the browser only logs an error.            |

The page opens no WebSocket and calls no other route. `GuestPage.browser.test.tsx` and `runtime.browser.test.ts` check that it opens no environment connection. When this list changes, change `scripts/fork-guest-access-check.ts` and the Access applications of each host too.

All guest requests go to the same origin, with the browser's cookies. So the Access cookie of the guest login also covers `/api/guest/*`.

The build files (`/assets/*` and the three files in the root) are the public open-source web build and hold no data. The owner page loads the same files. The `CF_Authorization` cookie of a host holds the token of one application at a time, and a script cannot follow a redirect to the Access login. So an Allow application on the build files breaks the owner page, and a Bypass application does not.

The owner Access application "T3 Code servers" keeps every other path of the host. Access uses the application with the most specific path, so the two guest applications apply only to the paths above.

The guest application has its own token, which replaces the owner token in the cookie of the host. If the owner opens a guest link in the owner browser, the next owner page asks for the owner login again. Open guest links in a private window.

### Change it

Change the guest applications and the rate limit rule in the Cloudflare Zero Trust dashboard. Turn on guest links for a machine with `guestSharingEnabled` through `t3.settings` on kitshn.

- The zone rate limit rule `t3_guest_routes` allows 100 requests per 10 seconds per IP address on `/api/guest/`, then blocks for 10 seconds. One open guest page sends one stream request, plus one request for each row or image that the guest opens.

### Check it

1. Without a login, run the check. The build files must be open, and every other path must stop at Access:

   ```sh
   node scripts/fork-guest-access-check.ts https://t3-vps.yarden-zamir.com
   ```

2. Open a guest link in a private window and log in with a one-time PIN. Copy the value of the `CF_Authorization` cookie of the host from the developer tools. Run the check again with it. The owner paths must still stop at Access, and the server must refuse the guest routes with its own 403:

   ```sh
   T3_GUEST_ACCESS_COOKIE='<cookie value>' node scripts/fork-guest-access-check.ts https://t3-vps.yarden-zamir.com
   ```

- If the page says that the link is not valid after the Access login, open the guest link again. The Access login can drop the part of the link after `#`.
- A guest Access login does not open the owner paths. Access checks each application on its own, and the server accepts only the audience tag of the owner login (`T3CODE_CLOUDFLARE_ACCESS_*`) and the kitshn grants.

## Central build caches

Set `T3_FORK_CENTRAL_BUILD_CACHE=1` before running Vite tools or Expo prebuild. It defaults off. Set `XDG_CACHE_HOME` to choose a base outside the checkout; otherwise the base is `~/.cache`.

- Vite uses `t3-vite/<SHA-256 of canonical checkout path>/<app>`. All six owned Vite configs and Astro's embedded Vite config use the same helper; vendored reference configs are unchanged.
- The Expo plugin links only `apps/mobile/android/app/build` to `t3-gradle/workspaces/<hash>/app/<generation>`. A clean prebuild removes the link and creates a fresh generation. It does not reuse the previous app outputs. Gradle's build cache can restore tasks (`org.gradle.caching=true` in `~/.gradle/gradle.properties`). Root `android/build`, dependency codegen and `.cxx` keep their original locations.
- Existing physical `app/build` folders are refused, not migrated. Run `expo prebuild --clean --platform android` when opting in. Turning the variable off leaves existing links alone; a clean prebuild restores local outputs.

```sh
node scripts/fork-build-cache-prune.ts --dry-run
node scripts/fork-build-cache-prune.ts --days 14
```

Prune removes whole central workspace folders for missing checkouts or expired last-use records, and Android generations that the current link no longer names. Current generations are kept until the workspace expires. A later Gradle build recreates an expired link target. The script reports allocated bytes removed (or planned); filesystem clones and compression can change the actual free-space gain. It never removes anything in a checkout, follows payload links, or removes unknown/unregistered folders. It does not clean legacy local outputs.

Vite holds a PID lock for the tool process. Gradle holds one from app configuration through build completion. Live or unrecognized locks block removal; dead-PID locks do not. Builds and pruning share a short `.gate` directory lock. A concurrent setup fails safely: retry it. If a process dies inside that critical section, first confirm no cache operation is running, then remove only the central root's empty `.gate` directory. No background cleanup is installed.

A later T3 storage-cleanup hook can spawn `node scripts/fork-build-cache-prune.ts --days 14` from the checkout, with the build user's `HOME` and `XDG_CACHE_HOME`. Pass `--dry-run` for its preview. Do not add checkout deletion to that hook.

## Android APK build

`.github/workflows/fork-android.yml` ("Fork Android") adds `t3code-<version>-android.apk` to the release after each successful Fork Release of main. It is a local Gradle build with `scripts/fork-android-apk.sh`, so the fork needs no Expo or Google Play account. How users install it: [Android APK](features.md#android-apk).

- It runs outside the Fork Release concurrency group, so the slow Gradle build never delays the next release. A newer run cancels an older one.
- It builds only when the app changed since the newest earlier release with an APK: `apps/mobile/`, `packages/`, `pnpm-lock.yaml`, `patches/`, `scripts/fork-android-apk.sh` or the workflow. Otherwise it skips and names that release in a notice. A skipped release cancels no build.
- To force a build for a release, run Fork Android by hand on main with the input `release_tag`, for example `gh workflow run fork-android.yml -R Yarden-zamir/t3code --ref main -f release_tag=<tag>`.
- It only uploads to an existing release, and never creates one. A failure marks only Fork Android and does not call the repair agent. A run from a branch uploads the APK as a workflow artifact.
- The APK is the nightly ("Preview") app with the package `com.yardenzamir.t3code`. It holds arm64 code only.
- The version name is the fork release version. The version code is the commit time in minutes since 2026-01-01, so it only grows along main.
- The fork key in `_shared/android-signing/` signs every APK. The repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` hold the same key. Only the signing step sees them. Android refuses an update with another key, so do not replace the key.
- Upstream's mobile workflows need Expo, Google Play or Blacksmith runners. They are disabled on the fork. After a sync that adds a `mobile-*` workflow, disable it with `gh workflow disable "<name>" -R Yarden-zamir/t3code`.

## Android emulator on the Mac

1. Use the T3 Device panel first: `device_list`, then `device_open`. Follow its returned AgentDevice command and target arguments.
2. If it reports "Android unavailable", raise the [tool blocker](#tool-blockers) before any fallback. The app can lack `ANDROID_HOME`. Set it, then restart the T3 desktop app with the owner's approval:

   ```sh
   launchctl setenv ANDROID_HOME /opt/homebrew/share/android-commandlinetools
   ```

3. For Gradle and native-client builds, set both SDK variables. Put the worktree's `vp` folder on PATH:

   ```sh
   export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
   export ANDROID_SDK_ROOT="$ANDROID_HOME"
   export PATH="$PWD/node_modules/.bin:$PATH"
   ```

4. Follow `test-t3-mobile` with copied backend data. The test AVD is `t3-android-app`, port `5590`, device `emulator-5590`.

Use these raw-emulator steps only after the owner approves a workaround:

- A failed snapshot can leave a black screen. Stop only the test emulator, then start without a snapshot:

  ```sh
  "$ANDROID_HOME/platform-tools/adb" -s emulator-5590 emu kill < /dev/null
  setopt NO_BG_NICE
  "$ANDROID_HOME/emulator/emulator" -avd t3-android-app -port 5590 -no-snapshot -no-window &
  ```

  `NO_BG_NICE` is a zsh option. It prevents macOS from throttling the background emulator until it freezes.

- Turn off stylus handwriting before typing, or its tutorial can take the input:

  ```sh
  "$ANDROID_HOME/platform-tools/adb" -s emulator-5590 shell settings put secure stylus_handwriting_enabled 0 < /dev/null
  ```

- Close stdin on every `adb shell` command with `< /dev/null`; otherwise agent shells can hang.
- `adb shell input text` drops long strings. Send text in parts of 12 characters.
- Move the floating Expo dev menu button away before tapping a header check button that it covers.

## Secrets and variables

| Name                                                                                    | Kind               | Use                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                                                          | secret             | macOS signing certificate. See [macOS signing](#macos-signing).                                                                                                                           |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`             | secret             | Android signing key. See [Android APK build](#android-apk-build).                                                                                                                         |
| `FORK_SYNC_TOKEN`                                                                       | secret             | Fine-grained token for this repository with Contents and Workflows read and write. Without it, the push fails when upstream changes a workflow file, and the push does not start Fork CI. |
| `T3_AGENT_WEBHOOK_URL`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`                | secret, optional   | Webhook URL of the repair agent task, and the Cloudflare Access service token that the call needs. Without the URL, no agent is notified.                                                 |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID`, `RELAY_URL` | variable, optional | T3 Connect config. Without them, the build has no T3 Connect.                                                                                                                             |
| `T3_FORK_CENTRAL_BUILD_CACHE`, `XDG_CACHE_HOME`                                         | variable, optional | Opt in to [central build caches](#central-build-caches), and choose their base directory.                                                                                                 |
