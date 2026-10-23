import { assert, it } from "@effect/vitest";

import { migrationRegistryProblems, parseMigrationRegistry } from "./fork-check-migrations.ts";

const registry = (entries: ReadonlyArray<string>) =>
  ["const migrationEntries = [", ...entries, "] as const;"].join("\n");

const upstream = parseMigrationRegistry(
  registry([
    '  [66, "RepairClientSettlementTimestamps", Migration0066],',
    '  [67, "WebhookDedupe", Migration0067],',
  ]),
);

it("passes a registry that upstream main has, also when upstream is ahead", () => {
  const fork = parseMigrationRegistry(
    registry([
      "  // Preserve this migration's schema.",
      '  [66, "RepairClientSettlementTimestamps", Migration0066],',
    ]),
  );
  assert.deepStrictEqual(migrationRegistryProblems(fork, upstream), []);
});

it("fails on an id that upstream main lacks or names differently", () => {
  const fork = parseMigrationRegistry(
    registry([
      '  [66, "RepairClientSettlementTimestamps", Migration0066],',
      '  [67, "PeerEnvironmentLinks", Migration0067],',
      '  [68, "PeerEnvironmentLinks", Migration0068],',
    ]),
  );
  const problems = migrationRegistryProblems(fork, upstream);
  assert.strictEqual(problems.length, 2);
  assert.include(problems[0], '"WebhookDedupe"');
  assert.include(problems[1], "no migration 68");
});

it("refuses an entry it cannot read instead of skipping it", () => {
  assert.throws(() =>
    parseMigrationRegistry(registry(["  [", "    69,", '    "Wrapped",', "  ],"])),
  );
  assert.throws(() => parseMigrationRegistry("const other = [];"));
});
