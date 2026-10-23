// @effect-diagnostics nodeBuiltinImport:off - plain Node tests on temporary folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";

import {
  type DevServerRecord,
  type ProcessEntry,
  type ProcessHost,
  findOrphans,
  parseRecord,
  readRecord,
  readStartupOutput,
  recordPath,
  stopDevServer,
  writeRecord,
} from "./fork-dev-server.ts";

function makeRoot(): string {
  return NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-dev-server-")),
  );
}

function makeRecord(root: string, pgid = 500): DevServerRecord {
  return {
    pgid,
    pid: pgid,
    cwd: root,
    ports: { server: 13773, web: 5733 },
    logFile: NodePath.join(root, ".t3", "dev-server.log"),
    startedAt: "2026-10-23T10:00:00.000Z",
  };
}

function entry(pid: number, pgid: number, ppid = pgid): ProcessEntry {
  return {
    pid,
    ppid,
    pgid,
    startedAt: "Thu Oct 23 10:00:00 2026",
    command: "node --watch src/bin.ts",
  };
}

/**
 * A fake process table. A group exits on the first signal in `exitsOn`; with an empty list it
 * never exits.
 */
function fakeHost(input: {
  readonly processes: ReadonlyArray<ProcessEntry>;
  readonly cwds: Readonly<Record<number, string>>;
  readonly exitsOn?: ReadonlyArray<"SIGTERM" | "SIGKILL">;
}) {
  let processes = input.processes;
  const signals: Array<string> = [];
  const host: ProcessHost = {
    list: () => processes,
    cwds: (pids) =>
      new Map(pids.flatMap((pid) => (pid in input.cwds ? [[pid, input.cwds[pid]!] as const] : []))),
    signalGroup: (pgid, signal) => {
      signals.push(`${signal} ${pgid}`);
      if ((input.exitsOn ?? ["SIGTERM"]).includes(signal)) {
        processes = processes.filter((process) => process.pgid !== pgid);
      }
    },
    sleep: () => Promise.resolve(),
  };
  return { host, signals };
}

it("writes and reads the record, and rejects a record with a wrong shape", () => {
  const root = makeRoot();
  assert.strictEqual(readRecord(root), undefined);
  const record = makeRecord(root);
  writeRecord(root, record);
  assert.deepStrictEqual(readRecord(root), record);
  assert.deepStrictEqual(parseRecord(JSON.stringify({ ...record, ports: null })).ports, null);

  NodeFS.writeFileSync(recordPath(root), JSON.stringify({ ...record, pgid: "500" }));
  assert.throws(() => readRecord(root), /unexpected shape/);
  NodeFS.writeFileSync(recordPath(root), JSON.stringify({ ...record, ports: { server: 1 } }));
  assert.throws(() => readRecord(root), /unexpected shape/);
});

it("stops the whole group, escalates to SIGKILL, and removes the record", async () => {
  const root = makeRoot();
  writeRecord(root, makeRecord(root));
  const { host, signals } = fakeHost({
    processes: [entry(500, 500), entry(501, 500, 500), entry(900, 900)],
    cwds: { 500: root, 501: `${root}/apps/server`, 900: "/elsewhere" },
    exitsOn: ["SIGKILL"],
  });
  assert.deepStrictEqual(await stopDevServer(host, root), { _tag: "Stopped", signal: "SIGKILL" });
  assert.deepStrictEqual(signals, ["SIGTERM 500", "SIGKILL 500"]);
  assert.strictEqual(readRecord(root), undefined);
});

it("refuses a group whose leader runs outside the worktree and keeps the record", async () => {
  const root = makeRoot();
  writeRecord(root, makeRecord(root));
  const { host, signals } = fakeHost({
    processes: [entry(500, 500)],
    cwds: { 500: "/Users/someone/other-project" },
  });
  await expect(stopDevServer(host, root)).rejects.toThrow(/Refusing to stop process group 500/);
  assert.deepStrictEqual(signals, []);
  assert.notStrictEqual(readRecord(root), undefined);
});

it("refuses a leaderless group with a member outside the worktree", async () => {
  const root = makeRoot();
  writeRecord(root, makeRecord(root));
  const { host, signals } = fakeHost({
    processes: [entry(501, 500, 1), entry(502, 500, 501)],
    cwds: { 501: `${root}/apps/server`, 502: "/tmp/reused" },
  });
  await expect(stopDevServer(host, root)).rejects.toThrow(/leader exited/);
  assert.deepStrictEqual(signals, []);
});

it("removes a stale record without signals when the group is gone", async () => {
  const root = makeRoot();
  writeRecord(root, makeRecord(root));
  const { host, signals } = fakeHost({ processes: [], cwds: {} });
  assert.deepStrictEqual(await stopDevServer(host, root), { _tag: "NotRunning" });
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(readRecord(root), undefined);
});

it("reports dev groups in deleted folders or under PID 1 without a record, and never signals", () => {
  const root = makeRoot();
  const { host, signals } = fakeHost({
    processes: [
      // Under PID 1, tracked by the record of `root`.
      entry(500, 500, 1),
      // Under PID 1, untracked.
      entry(600, 600, 1),
      entry(601, 600, 600),
      // Folder deleted.
      entry(700, 700, 42),
      // Normal parent and folder.
      entry(800, 800, 42),
      { ...entry(900, 900, 1), command: "/usr/sbin/sshd" },
    ],
    cwds: {
      500: root,
      600: "/live/a",
      601: "/live/a/apps/server",
      700: "/gone",
      800: "/live/b",
      900: "/",
    },
  });
  const orphans = findOrphans(
    host,
    (path) => path !== "/gone",
    (directory) => (directory === root ? makeRecord(root) : undefined),
  );
  assert.deepStrictEqual(
    orphans.map((group) => [group.pgid, group.members.map((member) => member.pid)]),
    [
      [600, [600, 601]],
      [700, [700]],
    ],
  );
  assert.deepStrictEqual(signals, []);
});

it("reads ports and the pairing URL from the dev-runner log", () => {
  const log = [
    'timestamp=2026-10-23T10:00:00Z level=INFO fiber=#0 message="[dev-runner] mode=dev source=worktree serverPort=13773 webPort=5733 baseDir=/w/.t3"',
    "t3#dev:   pairingUrl: http://localhost:5733/pair#token=abc",
  ].join("\n");
  assert.deepStrictEqual(readStartupOutput(log), {
    ports: { server: 13773, web: 5733 },
    sharedUrl: undefined,
    pairingUrl: "http://localhost:5733/pair#token=abc",
  });
  assert.deepStrictEqual(readStartupOutput("").ports, null);
});
