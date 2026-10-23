#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node script.
// Fork: fork main registers only the migration ids and names that upstream main has. A database
// skips every migration id up to its highest recorded one, whatever the name, so a fork-only id
// that upstream later gives to another migration stops every fork machine at startup.
// See docs/fork/operations.md "Migrations".
//
//   node scripts/fork-check-migrations.ts [upstream ref, default upstream/main]
//
// It reads the registry of the working tree, so uncommitted changes count.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const REGISTRY_PATH = "apps/server/src/persistence/Migrations.ts";
const LIST_START = "const migrationEntries = [";
const LIST_END = "] as const;";

export interface MigrationEntry {
  readonly id: number;
  readonly name: string;
}

/** Throws on a line it cannot read, so that a format change cannot hide an entry. */
export function parseMigrationRegistry(source: string): ReadonlyArray<MigrationEntry> {
  const lines = source.split("\n");
  const start = lines.indexOf(LIST_START);
  const end = lines.indexOf(LIST_END, start);
  if (start === -1 || end === -1) {
    throw new Error(`No "${LIST_START}" ... "${LIST_END}" list in ${REGISTRY_PATH}.`);
  }
  return lines.slice(start + 1, end).flatMap((raw) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("//")) return [];
    // An entry is one line: `[67, "WebhookDedupe", Migration0067],`.
    const parts = line.startsWith("[") && line.endsWith("],") ? line.slice(1, -2).split(",") : [];
    const [idText = "", quotedName = ""] = parts.map((part) => part.trim());
    const id = Number(idText);
    if (
      parts.length !== 3 ||
      idText === "" ||
      !Number.isSafeInteger(id) ||
      quotedName.length < 3 ||
      !quotedName.startsWith('"') ||
      !quotedName.endsWith('"')
    ) {
      throw new Error(`Cannot read the migration entry "${line}" in ${REGISTRY_PATH}.`);
    }
    return [{ id, name: quotedName.slice(1, -1) }];
  });
}

/** Each fork entry that upstream main lacks or names differently. */
export function migrationRegistryProblems(
  fork: ReadonlyArray<MigrationEntry>,
  upstream: ReadonlyArray<MigrationEntry>,
): ReadonlyArray<string> {
  const upstreamNames = new Map(upstream.map((entry) => [entry.id, entry.name]));
  return fork.flatMap(({ id, name }) => {
    const upstreamName = upstreamNames.get(id);
    if (upstreamName === undefined) return [`${id} ${name}: upstream main has no migration ${id}.`];
    return upstreamName === name
      ? []
      : [`${id} ${name}: upstream main names migration ${id} "${upstreamName}".`];
  });
}

function main(upstreamRef: string): void {
  let upstreamSource: string;
  try {
    upstreamSource = NodeChildProcess.execFileSync(
      "git",
      ["show", `${upstreamRef}:${REGISTRY_PATH}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    console.error(
      `Cannot read ${REGISTRY_PATH} at ${upstreamRef}. Run \`git fetch upstream main\` and try again.`,
    );
    process.exit(2);
  }
  const fork = parseMigrationRegistry(NodeFS.readFileSync(REGISTRY_PATH, "utf8"));
  const upstream = parseMigrationRegistry(upstreamSource);
  const problems = migrationRegistryProblems(fork, upstream);
  if (problems.length > 0) {
    console.error(
      `The fork registers migrations that ${upstreamRef} does not have. Remove them; Fork Sync brings each one back at the number that upstream merges it with.`,
    );
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`${fork.length} migrations, all in ${upstreamRef}.`);
}

if (import.meta.main) {
  main(process.argv[2] ?? "upstream/main");
}
