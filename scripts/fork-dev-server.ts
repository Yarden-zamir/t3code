#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - plain Node script.
// Fork: starts and stops the worktree dev server (`vp run dev`) as one process group.
// See docs/fork-agents.md.
//
//   node scripts/fork-dev-server.ts start [-- <vp run dev arguments, for example --share>]
//   node scripts/fork-dev-server.ts stop
//   node scripts/fork-dev-server.ts status
//   node scripts/fork-dev-server.ts orphans
//
// `vp run dev` runs dev-runner, Vite+ and `node --watch src/bin.ts`. A stop of the dev-runner
// PID alone leaves the watcher alive under PID 1, and it restarts the server on every file
// change. So `start` puts the whole tree in a new session and process group, and `stop` signals
// that group. `orphans` only reports leftover dev processes. It never kills.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";

export interface DevServerRecord {
  readonly pgid: number;
  readonly pid: number;
  /** The worktree root. */
  readonly cwd: string;
  /** Read from the `[dev-runner]` line. Null until that line appears. */
  readonly ports: { readonly server: number; readonly web: number } | null;
  readonly logFile: string;
  readonly startedAt: string;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly command: string;
}

export interface ProcessHost {
  readonly list: () => ReadonlyArray<ProcessEntry>;
  /** Working directories by PID. A PID that exited or that cannot be read is missing. */
  readonly cwds: (pids: ReadonlyArray<number>) => ReadonlyMap<number, string>;
  readonly signalGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

export type StopResult =
  | { readonly _tag: "NoRecord" }
  | { readonly _tag: "NotRunning" }
  | { readonly _tag: "Stopped"; readonly signal: "SIGTERM" | "SIGKILL" };

const RECORD_FILE = "dev-server.json";
const LOG_FILE = "dev-server.log";
const POLL_MILLISECONDS = 250;
/** dev-runner gives Vite+ 1.5 s after SIGTERM, then removes a tailnet share. */
const TERM_GRACE_MILLISECONDS = 10_000;
const KILL_GRACE_MILLISECONDS = 2_000;
/** A first start can seed the database and warm the bundle. */
const START_WAIT_MILLISECONDS = 300_000;
// Matched against the command line, so a non-T3 project with the same tools also shows up in
// `orphans`. That is acceptable because `orphans` only reports. Revisit if the report gets noisy.
const DEV_COMMAND_MARKERS = [
  "scripts/dev-runner.ts",
  "/vite-plus/bin/vp run",
  " src/bin.ts",
  "/vite-plus-core/dist/vite/",
];

export function recordPath(root: string): string {
  return NodePath.join(root, ".t3", RECORD_FILE);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function parseRecord(text: string): DevServerRecord {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) {
    throw new Error("The dev server record is not a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const ports = record.ports as Record<string, unknown> | null | undefined;
  const portsValid =
    ports === null ||
    (typeof ports === "object" &&
      ports !== undefined &&
      isPositiveInteger(ports.server) &&
      isPositiveInteger(ports.web));
  if (
    !isPositiveInteger(record.pgid) ||
    !isPositiveInteger(record.pid) ||
    typeof record.cwd !== "string" ||
    !portsValid ||
    typeof record.logFile !== "string" ||
    typeof record.startedAt !== "string"
  ) {
    throw new Error(`The dev server record has an unexpected shape: ${text}`);
  }
  return record as unknown as DevServerRecord;
}

export function readRecord(root: string): DevServerRecord | undefined {
  const file = recordPath(root);
  if (!NodeFS.existsSync(file)) return undefined;
  try {
    return parseRecord(NodeFS.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function writeRecord(root: string, record: DevServerRecord): void {
  NodeFS.mkdirSync(NodePath.dirname(recordPath(root)), { recursive: true });
  NodeFS.writeFileSync(recordPath(root), `${JSON.stringify(record, null, 2)}\n`);
}

function removeRecord(root: string): void {
  NodeFS.rmSync(recordPath(root), { force: true });
}

function isInside(directory: string, root: string): boolean {
  return directory === root || directory.startsWith(`${root}/`);
}

function groupMembers(host: ProcessHost, pgid: number): ReadonlyArray<ProcessEntry> {
  return host.list().filter((entry) => entry.pgid === pgid);
}

/**
 * Throws unless the group still belongs to this worktree. The group leader is the `vp` process
 * that `start` spawned in the worktree root. If it exited, every member must be in the worktree.
 * A leader in the worktree proves ownership, so its members elsewhere (for example a provider CLI
 * in a project folder) stop with it.
 */
function assertOwnedGroup(
  host: ProcessHost,
  root: string,
  record: DevServerRecord,
  members: ReadonlyArray<ProcessEntry>,
): void {
  const cwds = host.cwds(members.map((entry) => entry.pid));
  const leaderCwd = cwds.get(record.pgid);
  if (leaderCwd !== undefined) {
    if (isInside(leaderCwd, root)) return;
    throw new Error(
      `Refusing to stop process group ${record.pgid}: its leader runs in ${leaderCwd}, not in ${root}.`,
    );
  }
  const foreign = members.filter((entry) => {
    const cwd = cwds.get(entry.pid);
    return cwd !== undefined && !isInside(cwd, root);
  });
  if (foreign.length > 0) {
    const list = foreign.map((entry) => `${entry.pid} in ${cwds.get(entry.pid)}`).join(", ");
    throw new Error(
      `Refusing to stop process group ${record.pgid}: its leader exited and these processes run outside ${root}: ${list}.`,
    );
  }
}

async function waitForGroupExit(
  host: ProcessHost,
  pgid: number,
  milliseconds: number,
): Promise<boolean> {
  for (let waited = 0; waited < milliseconds; waited += POLL_MILLISECONDS) {
    if (groupMembers(host, pgid).length === 0) return true;
    await host.sleep(POLL_MILLISECONDS);
  }
  return groupMembers(host, pgid).length === 0;
}

export async function stopDevServer(host: ProcessHost, root: string): Promise<StopResult> {
  const record = readRecord(root);
  if (record === undefined) return { _tag: "NoRecord" };
  if (record.cwd !== root) {
    throw new Error(`${recordPath(root)} belongs to ${record.cwd}, not to ${root}.`);
  }
  const members = groupMembers(host, record.pgid);
  if (members.length === 0) {
    removeRecord(root);
    return { _tag: "NotRunning" };
  }
  assertOwnedGroup(host, root, record, members);

  host.signalGroup(record.pgid, "SIGTERM");
  if (await waitForGroupExit(host, record.pgid, TERM_GRACE_MILLISECONDS)) {
    removeRecord(root);
    return { _tag: "Stopped", signal: "SIGTERM" };
  }
  host.signalGroup(record.pgid, "SIGKILL");
  if (await waitForGroupExit(host, record.pgid, KILL_GRACE_MILLISECONDS)) {
    removeRecord(root);
    return { _tag: "Stopped", signal: "SIGKILL" };
  }
  const left = groupMembers(host, record.pgid).map((entry) => entry.pid);
  throw new Error(
    `Process group ${record.pgid} still has processes after SIGKILL: ${left.join(" ")}.`,
  );
}

export interface OrphanGroup {
  readonly pgid: number;
  readonly reason: string;
  readonly members: ReadonlyArray<ProcessEntry & { readonly cwd: string | undefined }>;
}

/** The record of the worktree that holds `directory`, if any. */
function findRecordAbove(directory: string): DevServerRecord | undefined {
  for (let current = directory; ; current = NodePath.dirname(current)) {
    if (NodeFS.existsSync(recordPath(current))) return readRecord(current);
    if (NodePath.dirname(current) === current) return undefined;
  }
}

/**
 * Dev process groups that nothing tracks: a member runs in a deleted folder, or a member has
 * PID 1 as its parent and its worktree has no record of this group.
 */
// On Linux, a subreaper (for example `systemd --user`) adopts orphans instead of PID 1, so the
// PID 1 rule misses them. Revisit if `orphans` runs on such machines.
export function findOrphans(
  host: ProcessHost,
  exists: (path: string) => boolean = NodeFS.existsSync,
  recordFor: (directory: string) => DevServerRecord | undefined = findRecordAbove,
): ReadonlyArray<OrphanGroup> {
  const candidates = host
    .list()
    .filter((entry) => DEV_COMMAND_MARKERS.some((marker) => entry.command.includes(marker)));
  const cwds = host.cwds(candidates.map((entry) => entry.pid));
  const reasons = new Map<number, string>();
  for (const entry of candidates) {
    const cwd = cwds.get(entry.pid);
    if (cwd === undefined || reasons.has(entry.pgid)) continue;
    if (!exists(cwd)) {
      reasons.set(entry.pgid, `folder deleted: ${cwd}`);
    } else if (entry.ppid === 1 && recordFor(cwd)?.pgid !== entry.pgid) {
      reasons.set(entry.pgid, "parent is PID 1 and no dev server record tracks the group");
    }
  }
  return [...reasons].map(([pgid, reason]) => ({
    pgid,
    reason,
    members: candidates
      .filter((entry) => entry.pgid === pgid)
      .map((entry) => ({ ...entry, cwd: cwds.get(entry.pid) })),
  }));
}

export function parsePs(output: string): ReadonlyArray<ProcessEntry> {
  return output
    .split("\n")
    .map((line) =>
      line
        .trim()
        .split(" ")
        .filter((token) => token !== ""),
    )
    .filter((tokens) => tokens.length >= 9)
    .map((tokens) => ({
      pid: Number(tokens[0]),
      ppid: Number(tokens[1]),
      pgid: Number(tokens[2]),
      // `lstart` is five tokens with LC_ALL=C, for example "Thu Oct 23 11:33:00 2026".
      startedAt: tokens.slice(3, 8).join(" "),
      command: tokens.slice(8).join(" "),
    }));
}

/** Parses `lsof -Fpn` output: a `p<pid>` line, then `f` and `n<path>` lines for that PID. */
export function parseLsofCwds(output: string): ReadonlyMap<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

const DELETED_SUFFIX = " (deleted)";

function linuxCwds(pids: ReadonlyArray<number>): ReadonlyMap<number, string> {
  const cwds = new Map<number, string>();
  for (const pid of pids) {
    try {
      const cwd = NodeFS.readlinkSync(`/proc/${pid}/cwd`);
      cwds.set(pid, cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd);
    } catch {
      // The process exited, or it belongs to another user.
    }
  }
  return cwds;
}

const nodeProcessHost: ProcessHost = {
  list: () =>
    parsePs(
      NodeChildProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart=,command="], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 64 * 1024 * 1024,
      }),
    ),
  cwds: (pids) => {
    if (pids.length === 0) return new Map();
    if (NodeProcess.platform === "linux") return linuxCwds(pids);
    // lsof exits 1 when a PID exited; the output still lists the others.
    const result = NodeChildProcess.spawnSync(
      "lsof",
      ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return parseLsofCwds(result.stdout);
  },
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function worktreeRoot(): string {
  const root = NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  return NodeFS.realpathSync(root);
}

/** The value after `key` on a log line, up to the next space or quote. */
function valueAfter(line: string, key: string): string | undefined {
  const start = line.indexOf(key);
  if (start === -1) return undefined;
  const rest = line.slice(start + key.length);
  const ends = [" ", '"', "\\"].map((stop) => rest.indexOf(stop)).filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : undefined).trim();
}

interface StartupOutput {
  readonly ports: { readonly server: number; readonly web: number } | null;
  readonly sharedUrl: string | undefined;
  readonly pairingUrl: string | undefined;
}

export function readStartupOutput(log: string): StartupOutput {
  const lines = log.split("\n");
  const runnerLine = lines.find((line) => line.includes("[dev-runner] mode="));
  const server = runnerLine === undefined ? undefined : valueAfter(runnerLine, "serverPort=");
  const web = runnerLine === undefined ? undefined : valueAfter(runnerLine, "webPort=");
  const pairingLine = lines.find((line) => line.includes("pairingUrl: "));
  const sharedLine = lines.find((line) => line.includes("[dev-runner] shared on tailnet: "));
  return {
    ports:
      server !== undefined && web !== undefined
        ? { server: Number(server), web: Number(web) }
        : null,
    sharedUrl: sharedLine === undefined ? undefined : valueAfter(sharedLine, "shared on tailnet: "),
    pairingUrl: pairingLine === undefined ? undefined : valueAfter(pairingLine, "pairingUrl: "),
  };
}

async function start(host: ProcessHost, root: string, devArgs: ReadonlyArray<string>) {
  const existing = readRecord(root);
  if (existing !== undefined) {
    if (groupMembers(host, existing.pgid).length > 0) {
      throw new Error(
        `A dev server already runs in this worktree (process group ${existing.pgid}). Run \`node scripts/fork-dev-server.ts stop\` first.`,
      );
    }
    removeRecord(root);
  }
  const vp = NodePath.join(root, "node_modules", ".bin", "vp");
  if (!NodeFS.existsSync(vp)) throw new Error(`${vp} is missing. Run \`vp i\` first.`);

  const logFile = NodePath.join(root, ".t3", LOG_FILE);
  NodeFS.mkdirSync(NodePath.dirname(logFile), { recursive: true });
  const logFd = NodeFS.openSync(logFile, "w");
  // detached: true calls setsid(), so the child leads a new session and process group.
  const child = NodeChildProcess.spawn(vp, ["run", "dev", ...devArgs], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  NodeFS.closeSync(logFd);
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Could not start ${vp}. See ${logFile}.`);
  child.unref();

  const record: DevServerRecord = {
    pgid: pid,
    pid,
    cwd: root,
    ports: null,
    logFile,
    startedAt: new Date().toISOString(),
  };
  writeRecord(root, record);
  console.log(`Started process group ${pid}. Log: ${logFile}`);

  let output = readStartupOutput("");
  for (let waited = 0; waited < START_WAIT_MILLISECONDS; waited += POLL_MILLISECONDS) {
    output = readStartupOutput(NodeFS.readFileSync(logFile, "utf8"));
    if (output.ports !== null && output.pairingUrl !== undefined) break;
    if (groupMembers(host, pid).length === 0) {
      removeRecord(root);
      throw new Error(`The dev server exited during startup. See ${logFile}.`);
    }
    await host.sleep(POLL_MILLISECONDS);
  }
  writeRecord(root, { ...record, ports: output.ports });
  if (output.ports !== null) {
    console.log(`Server port ${output.ports.server}, web port ${output.ports.web}.`);
  }
  if (output.sharedUrl !== undefined) console.log(`Shared on tailnet: ${output.sharedUrl}`);
  if (output.pairingUrl === undefined) {
    console.log(`No pairingUrl line yet. The server still starts. Follow ${logFile}.`);
  } else {
    console.log(`pairingUrl: ${output.pairingUrl}`);
  }
}

function status(host: ProcessHost, root: string): void {
  const record = readRecord(root);
  if (record === undefined) {
    console.log("No dev server record in this worktree.");
    return;
  }
  const members = groupMembers(host, record.pgid);
  const ports =
    record.ports === null
      ? "ports unknown"
      : `server port ${record.ports.server}, web port ${record.ports.web}`;
  console.log(
    members.length === 0
      ? `Not running. The record of process group ${record.pgid} is stale; \`stop\` removes it.`
      : `Running: process group ${record.pgid}, ${members.length} processes, ${ports}, started ${record.startedAt}. Log: ${record.logFile}`,
  );
}

function printOrphans(host: ProcessHost): void {
  const groups = findOrphans(host);
  if (groups.length === 0) {
    console.log("No orphaned T3 dev processes.");
    return;
  }
  for (const group of groups) {
    console.log(`Process group ${group.pgid}: ${group.reason}`);
    for (const member of group.members) {
      const command =
        member.command.length > 100 ? `${member.command.slice(0, 97)}...` : member.command;
      console.log(
        `  ${member.pid}  ${member.startedAt}  ${member.cwd ?? "(folder unknown)"}  ${command}`,
      );
    }
    console.log(`  To stop it: kill ${group.members.map((member) => member.pid).join(" ")}`);
  }
  console.log("This command only reports. Check each process before you stop it.");
}

async function main(args: ReadonlyArray<string>): Promise<void> {
  if (NodeProcess.platform === "win32") {
    throw new Error("fork-dev-server supports macOS and Linux only, not Windows.");
  }
  const [command, ...rest] = args;
  const host = nodeProcessHost;
  switch (command) {
    case "start": {
      const separator = rest.indexOf("--");
      return start(host, worktreeRoot(), separator === -1 ? rest : rest.slice(separator + 1));
    }
    case "stop": {
      const result = await stopDevServer(host, worktreeRoot());
      console.log(
        result._tag === "NoRecord"
          ? "No dev server record in this worktree."
          : result._tag === "NotRunning"
            ? "Not running. Removed the stale record."
            : `Stopped the process group with ${result.signal}. No process of the group is left.`,
      );
      return;
    }
    case "status":
      return status(host, worktreeRoot());
    case "orphans":
      return printOrphans(host);
    default:
      throw new Error(
        "Usage: node scripts/fork-dev-server.ts start [-- <args>] | stop | status | orphans",
      );
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
