import type {
  OrchestrationV2ThreadShell,
  ServerSettings,
  StorageCleanupReportEntry,
  ForkArtifactFolderType,
  ForkArtifactBreakdown,
  TerminalSummary,
} from "@t3tools/contracts";
import { FORK_ARTIFACT_FOLDER_TYPES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveProjectScripts, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Settings from "../serverSettings.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as Processes from "./ForkProcessCwds.ts";
import { makeSetupMarker } from "./forkWorktreeSetup.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Config from "../config.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import { looksGenerated, makeArtifactCandidates } from "./forkArtifactPolicy.ts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";

const DAY_MS = 86_400_000;
export const sameSettings = (left: ServerSettings, right: ServerSettings) =>
  left.worktreeArtifactEviction === right.worktreeArtifactEviction &&
  left.worktreeArtifactEvictionDays === right.worktreeArtifactEvictionDays;
const protectedName = (name: string) => {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env") ||
    /\.(?:pem|key|p12|p8|pfx|jks|keystore|gpg|pgp|asc|mobileprovision|sqlite|sqlite3|db)$/.test(
      lower,
    ) ||
    /(?:^|[._-])(?:secrets?|credentials)(?:[._-]|$)/.test(lower) ||
    [
      ".git",
      "_shared",
      ".t3",
      "userdata",
      "secrets",
      ".secrets",
      ".aws",
      ".ssh",
      ".npmrc",
      ".pypirc",
      ".netrc",
      "id_rsa",
      "id_ed25519",
      ".token",
      "tokens.json",
      "auth.json",
      "key.properties",
      "local.properties",
      "gradle.properties",
      ".repos",
    ].includes(lower)
  );
};
const decodeDependency = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);

export class ForkWorktreeArtifacts extends Context.Service<
  ForkWorktreeArtifacts,
  {
    readonly evict: (input: {
      readonly cwd: string;
      readonly blocked: Effect.Effect<string | null>;
    }) => Effect.Effect<{
      readonly reason: string;
      readonly logicalBytes: number;
      readonly directories: number;
      readonly failed: boolean;
      readonly artifactBreakdown: ForkArtifactBreakdown;
    }>;
  }
>()("t3/fork/ForkWorktreeArtifacts") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.GitVcsDriver;
  const processes = yield* Processes.ForkProcessCwds;
  const markerFor = yield* makeSetupMarker;
  const config = yield* Config.ServerConfig;
  const candidatesFor = yield* makeArtifactCandidates;
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };
  const isLink = (target: string) =>
    fs.readLink(target).pipe(
      Effect.match({
        onSuccess: () => true,
        onFailure: (error) =>
          !(error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL"),
      }),
    );
  const evict: ForkWorktreeArtifacts["Service"]["evict"] = ({ cwd, blocked }) =>
    Effect.suspend(() => {
      let logicalBytes = 0;
      let directories = 0;
      const breakdown = new Map<
        ForkArtifactFolderType,
        { folderType: ForkArtifactFolderType; logicalBytes: number; folders: number }
      >();
      const kept = (reason: string) => ({
        reason: directories > 0 ? `Artifacts removed; ${reason}` : reason,
        logicalBytes,
        directories,
        failed: false,
        artifactBreakdown: [...breakdown.values()],
      });
      return Effect.gen(function* () {
        const root = yield* fs.realPath(cwd);
        if (yield* isLink(cwd)) return kept("Worktree is a symbolic link");
        if ((yield* fs.stat(path.join(root, ".git"))).type !== "File")
          return kept("Not a linked worktree");
        const top = yield* git.execute({
          cwd: root,
          args: ["rev-parse", "--show-toplevel"],
          operation: "inspect artifact checkout",
        });
        if ((yield* fs.realPath(top.stdout.trim())) !== root) return kept("Not the worktree root");
        const processBlock = Effect.gen(function* () {
          const cwds = yield* processes.read;
          if (cwds === null) return "Process working directories could not be inspected";
          for (const cwd of cwds) {
            const resolved = yield* fs.realPath(cwd).pipe(Effect.option);
            if (Option.isNone(resolved)) return "A process working directory could not be read";
            const real = resolved.value;
            // Protects process cwds and T3-known active work; a clean scan is not proof of no external activity.
            // The immediate parent is the container holding this checkout and its siblings.
            // Stop ancestor protection there: a process above it can still use absolute paths.
            // Revisit this bound if a real tool does that; never guess roles from command names.
            if (inside(root, real) || real === path.dirname(root))
              return "A process has its working directory in this worktree or its container";
          }
          return null;
        });
        const initiallyBlocked = (yield* blocked) ?? (yield* processBlock);
        if (initiallyBlocked !== null) return kept(initiallyBlocked);
        const candidates = yield* candidatesFor(cwd);
        let inspected = 0;
        const marker = yield* markerFor(cwd);
        const markerWasPending = yield* marker.pending;
        const refusals = new Set<string>();
        candidates.sort(
          (left, right) =>
            FORK_ARTIFACT_FOLDER_TYPES.indexOf(left.folderType) -
            FORK_ARTIFACT_FOLDER_TYPES.indexOf(right.folderType),
        );
        for (const { relative, folderType } of candidates) {
          const target = path.join(root, relative);
          const linked = yield* fs.readLink(target).pipe(Effect.option);
          if (Option.isSome(linked)) {
            refusals.add(`${relative}: symbolic link`);
            continue;
          }
          if (!(yield* fs.exists(target))) continue;
          const data = yield* fs.realPath(config.stateDir).pipe(
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeed(path.resolve(config.stateDir)),
            ),
          );
          if (inside(target, data) || inside(data, target)) {
            refusals.add(`${relative}: user data`);
            continue;
          }
          const check = Effect.fn("ForkWorktreeArtifacts.checkArtifactPath")(function* () {
            if (
              folderType === "node_modules" &&
              !(yield* candidatesFor(cwd)).some(
                (candidate) =>
                  candidate.folderType === folderType && candidate.relative === relative,
              )
            )
              return false;
            const currentData = yield* fs.realPath(config.stateDir).pipe(
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(path.resolve(config.stateDir)),
              ),
            );
            if (inside(target, currentData) || inside(currentData, target)) return false;
            if ((yield* fs.realPath(target)) !== target || (yield* isLink(target))) return false;
            const ignored = yield* git.execute({
              cwd: root,
              args: ["check-ignore", "--quiet", "--", `${relative}/`],
              allowNonZeroExit: true,
              operation: "check artifact ignore",
            });
            if (ignored.exitCode !== 0) return false;
            const tracked = yield* git.execute({
              cwd: root,
              args: ["ls-files", "-z", "--", `:(literal)${relative}/`],
              maxOutputBytes: 16 * 1024,
              operation: "check tracked artifact files",
            });
            return tracked.stdout === "" && !tracked.stdoutTruncated;
          });
          if (!(yield* check())) {
            refusals.add(`${relative}: tracked, not ignored, or changed path`);
            continue;
          }
          const inspect = Effect.fn("ForkWorktreeArtifacts.inspectArtifact")(function* () {
            let size = 0;
            let rejection: string | null = null;
            const contents = [target];
            const payloads = new Map<string, boolean>();
            // Runs for each file in an artifact walk, so a span per call would be too frequent.
            const dependencyPayload = Effect.fnUntraced(function* (file: string) {
              const start = path.dirname(file);
              if (payloads.has(start)) return payloads.get(start)!;
              for (
                let parent = start;
                parent !== target && inside(target, parent);
                parent = path.dirname(parent)
              ) {
                const manifest = path.join(parent, "package.json");
                if (Option.isSome(yield* fs.readLink(manifest).pipe(Effect.option))) continue;
                if (yield* fs.exists(manifest)) {
                  const valid = yield* fs
                    .readFileString(manifest)
                    .pipe(Effect.flatMap(decodeDependency), Effect.option);
                  if (Option.isSome(valid)) {
                    // An arbitrary source project under node_modules is not an installed payload.
                    const segments = path.relative(target, parent).split(path.sep);
                    const store = segments[0] === ".pnpm" ? segments[1] : undefined;
                    const name = valid.value.name.replaceAll("/", "+");
                    const key = `${name}@${valid.value.version}`;
                    if (
                      !(
                        store === key ||
                        store?.startsWith(`${key}_`) ||
                        store?.startsWith(`${key}(`) ||
                        store?.startsWith(`${name}@file+`)
                      )
                    )
                      continue;
                    payloads.set(start, true);
                    return true;
                  }
                }
              }
              payloads.set(start, false);
              return false;
            });
            while (contents.length > 0 && rejection === null) {
              const entry = contents.pop()!;
              if (++inspected > 2_000_000) return { size, rejection: "inspection limit reached" };
              if (protectedName(path.basename(entry))) {
                rejection = "protected file or directory";
                break;
              }
              const link = yield* fs.readLink(entry).pipe(Effect.option);
              if (Option.isSome(link)) {
                const resolved = yield* fs.realPath(entry).pipe(Effect.option);
                if (Option.isNone(resolved) || !inside(root, resolved.value))
                  rejection = "symbolic link leaves the worktree or is unreadable";
                else if (path.relative(root, resolved.value).split(path.sep).some(protectedName))
                  rejection = "symbolic link targets protected worktree data";
                else if (
                  !looksGenerated(
                    folderType,
                    path.relative(target, entry).split(path.sep).join("/"),
                    folderType === "node_modules",
                  )
                )
                  rejection = `unrecognized file type; example: ${path.relative(target, entry).split(path.sep).join("/")}`;
                continue;
              }
              if ((yield* fs.realPath(entry)) !== entry) {
                rejection = "directory changed during inspection";
                break;
              }
              const stat = yield* fs.stat(entry);
              if (stat.type === "Directory")
                for (const name of yield* fs.readDirectory(entry))
                  contents.push(path.join(entry, name));
              else if (stat.type === "File") {
                const child = path.relative(target, entry).split(path.sep).join("/");
                let payload = folderType === "node_modules" && (yield* dependencyPayload(entry));
                if (
                  !payload &&
                  folderType === "node_modules" &&
                  child.startsWith(".bin/") &&
                  Number(stat.size) < 65_536
                ) {
                  const shim = yield* fs.readFileString(entry);
                  payload =
                    (shim.startsWith("#!") && /(?:basedir=|\$basedir)/i.test(shim)) ||
                    (/^@(?:ECHO|SETLOCAL)/i.test(shim) && shim.includes("%~dp0"));
                }
                if (!looksGenerated(folderType, child, payload)) {
                  rejection = `unrecognized file type; example: ${child}`;
                  break;
                }
                size += Number(stat.size);
              } else rejection = "special filesystem entry";
            }
            return { size, rejection };
          });
          const first = yield* inspect();
          if (first.rejection !== null) {
            refusals.add(`kept ${relative}: ${first.rejection}`);
            continue;
          }
          const reason = (yield* blocked) ?? (yield* processBlock);
          if (reason !== null) return kept(reason);
          if (!(yield* check())) return kept("Artifact eligibility changed during inspection");
          const final = yield* inspect();
          if (final.rejection !== null) {
            refusals.add(`kept ${relative}: ${final.rejection}`);
            continue;
          }
          if (folderType === "node_modules") yield* marker.mark;
          const clearUnusedMarker = () =>
            folderType === "node_modules" && !markerWasPending && !breakdown.has("node_modules")
              ? marker.clear
              : Effect.void;
          const finalBlock = (yield* blocked) ?? (yield* processBlock);
          if (finalBlock !== null) {
            yield* clearUnusedMarker();
            return kept(finalBlock);
          }
          if (!(yield* check())) {
            yield* clearUnusedMarker();
            return kept("Artifact eligibility changed immediately before deletion");
          }
          const lastStateBlock = yield* blocked;
          if (lastStateBlock !== null) {
            yield* clearUnusedMarker();
            return kept(lastStateBlock);
          }
          // Native recursive removal unlinks descendant symlinks; it never traverses their targets.
          yield* fs.remove(target, { recursive: true }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                directories++;
                logicalBytes += final.size;
                const previous = breakdown.get(folderType);
                breakdown.set(folderType, {
                  folderType,
                  logicalBytes: (previous?.logicalBytes ?? 0) + final.size,
                  folders: (previous?.folders ?? 0) + 1,
                });
              }),
            ),
            Effect.uninterruptible,
          );
        }
        return kept(
          directories > 0
            ? refusals.size > 0
              ? `checkout kept; ${[...refusals].join("; ")}`
              : "checkout kept"
            : refusals.size > 0
              ? [...refusals].join("; ")
              : "No allowlisted artifacts",
        );
      }).pipe(
        Effect.timeout("30 seconds"),
        Effect.catch(() =>
          Effect.succeed({
            ...kept("Artifact inspection or removal failed; checkout kept"),
            failed: true,
          }),
        ),
      );
    });
  return ForkWorktreeArtifacts.of({ evict });
});

export const layer = Layer.effect(ForkWorktreeArtifacts, make);
export const layerDefault = layer.pipe(
  Layer.provide(Processes.layer.pipe(Layer.provide(ProcessRunner.layer))),
);

export const makeSweep = Effect.fn("ForkWorktreeArtifacts.makeSweep")(function* (guards: {
  readonly hasTerminal: (cwd: string) => boolean;
  readonly terminals?: () => ReadonlyArray<TerminalSummary>;
  readonly idle: (thread: OrchestrationV2ThreadShell, now: number) => boolean;
  readonly activityAt: (thread: OrchestrationV2ThreadShell) => number;
}) {
  const artifacts = yield* ForkWorktreeArtifacts;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projections.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* Settings.ServerSettingsService;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  const git = yield* Git.GitVcsDriver;
  const setups = yield* SetupTracker.WorktreeSetupTracker;
  const canonical = (cwd: string) =>
    fs.realPath(cwd).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(path.resolve(cwd)),
      ),
    );
  return (settings: ServerSettings, now: number, entries: StorageCleanupReportEntry[]) =>
    Effect.gen(function* () {
      if (!settings.worktreeArtifactEviction) return;
      const report = (entry: StorageCleanupReportEntry) => {
        const index = entries.findIndex(
          (existing) => existing.kind === "worktree" && existing.path === entry.path,
        );
        if (index < 0) {
          entries.push(entry);
          return;
        }
        const previous = entries[index]!;
        entries[index] = {
          ...entry,
          outcome:
            previous.outcome === "failed" || entry.outcome === "failed"
              ? "failed"
              : previous.outcome === "removed" || entry.outcome === "removed"
                ? "removed"
                : previous.outcome,
          reason: `${previous.reason}; ${entry.reason}`,
          projectPath: entry.projectPath ?? previous.projectPath,
          bytes:
            previous.bytes === null && entry.bytes === null
              ? null
              : (previous.bytes ?? 0) + (entry.bytes ?? 0),
        };
      };
      const rows = yield* sql<{
        threadId: string;
        worktreePath: string;
      }>`SELECT thread_id AS "threadId", json_extract(payload_json, '$.worktreePath') AS "worktreePath" FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
      const normalized = yield* Effect.forEach(rows, (row) =>
        canonical(row.worktreePath).pipe(Effect.map((key) => ({ ...row, key }))),
      );
      const groups = Map.groupBy(normalized, (row) => row.key);
      for (const [canonicalCwd, group] of groups) {
        const cwd = path.resolve(group[0]!.worktreePath);
        const thread = yield* projections.getThreadShell(
          group[0]!.threadId as OrchestrationV2ThreadShell["id"],
        );
        const project =
          thread === null
            ? Option.none()
            : yield* projects.get(thread.projectId).pipe(Effect.orElseSucceed(() => Option.none()));
        const entry: StorageCleanupReportEntry = {
          kind: "worktree",
          outcome: "kept",
          reason: "",
          path: cwd,
          projectPath: Option.isSome(project) ? project.value.workspaceRoot : null,
          threadId: thread?.id ?? null,
          threadTitle: thread?.title ?? null,
          bytes: null,
          files: null,
        };
        const keep = (reason: string) => report({ ...entry, reason: `Artifacts kept: ${reason}` });
        if (group.length !== 1) {
          keep(`shared by ${group.length} threads`);
          continue;
        }
        if (thread === null) {
          keep("thread is unavailable");
          continue;
        }
        const workspaceBlock = Effect.gen(function* () {
          if (!(yield* fs.exists(cwd))) return "workspace folder is missing";
          const allProjects = yield* projects.listShells();
          for (const project of allProjects) {
            const real = yield* canonical(project.workspaceRoot);
            const relative = path.relative(canonicalCwd, real);
            if (
              relative === "" ||
              (!path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`))
            )
              return "contains a project checkout";
          }
          const project = yield* projects.get(thread.projectId);
          if (
            Option.isNone(project) ||
            !setupProjectScript(
              resolveProjectScripts(yield* settingsService.getSettings, {
                ...project.value,
                id: project.value.projectId,
              }),
            )
          )
            return "no project setup script is configured";
          const [expected, actual, branch] = yield* Effect.all([
            git.execute({
              cwd: project.value.workspaceRoot,
              args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              operation: "inspect artifact repository",
            }),
            git.execute({
              cwd,
              args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              operation: "inspect artifact worktree",
            }),
            git.execute({
              cwd,
              args: ["symbolic-ref", "HEAD"],
              operation: "inspect artifact branch",
            }),
          ]);
          if (
            (yield* canonical(expected.stdout.trim())) !==
              (yield* canonical(actual.stdout.trim())) ||
            branch.stdout.trim() !== `refs/heads/${thread.branch}`
          )
            return "repository or branch changed";
          return null;
        });
        const blocked = Effect.gen(function* () {
          const checkNow = Math.max(now, yield* Clock.currentTimeMillis);
          const currentSettings = yield* settingsService.getSettings;
          if (!currentSettings.worktreeArtifactEviction) return "setting was switched off";
          const current = yield* projections.getThreadShell(thread.id);
          if (
            current === null ||
            path.resolve(current.worktreePath ?? "") !== cwd ||
            current.branch !== thread.branch
          )
            return "thread workspace changed";
          if (!guards.idle(current, checkNow))
            return "thread is running or has queued or pending work";
          if ((yield* setups.get(current.id))?.phase === "running")
            return "T3-known setup is running for this worktree";
          if (guards.hasTerminal(cwd) || guards.hasTerminal(canonicalCwd)) return "open terminal";
          for (const terminal of guards.terminals?.() ?? []) {
            if (terminal.status !== "running" && terminal.status !== "starting") continue;
            if (
              terminal.worktreePath !== null &&
              (yield* canonical(terminal.worktreePath)) === canonicalCwd
            )
              return "T3 terminal metadata names this worktree";
            const resolved = yield* fs.realPath(terminal.cwd).pipe(Effect.option);
            if (Option.isNone(resolved)) return "terminal working directory could not be read";
            const relative = path.relative(canonicalCwd, resolved.value);
            if (
              resolved.value === path.dirname(canonicalCwd) ||
              relative === "" ||
              (!path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`))
            )
              return "open terminal in worktree or container";
          }
          if (
            current.settledAt === null &&
            guards.activityAt(current) >
              checkNow - currentSettings.worktreeArtifactEvictionDays * DAY_MS
          )
            return `inactive for less than ${currentSettings.worktreeArtifactEvictionDays} days`;
          if (
            current.settledAt !== null &&
            checkNow -
              Math.max(DateTime.toEpochMillis(current.settledAt), guards.activityAt(current)) <
              60_000
          )
            return "settled moments ago";
          const workspaceReason = yield* workspaceBlock;
          if (workspaceReason !== null) return workspaceReason;
          const ownership = yield* sql<{
            worktreePath: string;
          }>`SELECT json_extract(payload_json, '$.worktreePath') AS "worktreePath" FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
          const owners = yield* Effect.filter(ownership, (owner) =>
            canonical(owner.worktreePath).pipe(Effect.map((key) => key === canonicalCwd)),
          );
          if (owners.length !== 1) return "worktree ownership changed";
          const pending =
            yield* sql`SELECT 1 FROM orchestration_v2_effect_outbox WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1`;
          if (pending.length > 0) return "thread has pending work";
          const live = yield* sql<{
            id: string;
            cwd: string;
            worktreePath: string | null;
          }>`SELECT s.provider_session_id AS "id", json_extract(s.payload_json, '$.cwd') AS "cwd",
                json_extract(t.payload_json, '$.worktreePath') AS "worktreePath"
              FROM orchestration_v2_projection_provider_sessions s
              LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_session_id = s.provider_session_id
              LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = COALESCE(p.thread_id, s.thread_id)
              WHERE s.status != 'stopped'`;
          for (const session of live) {
            if (!(yield* sessions.isLive(session.id as Parameters<typeof sessions.isLive>[0])))
              continue;
            if (
              session.worktreePath != null &&
              (yield* canonical(session.worktreePath)) === canonicalCwd
            )
              return "T3 provider metadata names this worktree";
            const resolved = yield* fs.realPath(session.cwd).pipe(Effect.option);
            if (Option.isNone(resolved)) return "provider working directory could not be read";
            const relative = path.relative(canonicalCwd, resolved.value);
            if (
              resolved.value === path.dirname(canonicalCwd) ||
              relative === "" ||
              (!path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`))
            )
              return "provider session is still open";
          }
          return null;
        }).pipe(Effect.orElseSucceed(() => "thread state could not be checked"));
        yield* withWorkspaceLease(
          cwd,
          Effect.gen(function* () {
            const reason = yield* blocked;
            if (reason !== null) return keep(reason);
            const result = yield* artifacts.evict({ cwd, blocked });
            report({
              ...entry,
              outcome: result.failed ? "failed" : result.directories > 0 ? "removed" : "kept",
              reason: result.directories > 0 ? result.reason : `Artifacts kept: ${result.reason}`,
              // Logical size is not physical reclamation, especially for pnpm APFS clones.
              bytes: null,
              artifactBreakdown: result.artifactBreakdown,
            });
          }).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                keep("inspection failed");
              }),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          entries.push({
            kind: "worktree",
            outcome: "failed",
            reason: "Artifact cleanup could not inspect thread ownership",
            path: null,
            projectPath: null,
            threadId: null,
            threadTitle: null,
            bytes: null,
            files: null,
          });
        }),
      ),
    );
});
