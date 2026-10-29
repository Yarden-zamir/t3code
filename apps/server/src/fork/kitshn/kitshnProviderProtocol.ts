/**
 * Fork: every message of `kitshn provider` (kitshn K-702 to K-707), the only copy in T3. The
 * source of truth is `packages/local/src/provider.ts` and `index.ts` of kitshn. One JSON value
 * per line: T3 writes requests to stdin, and reads answers and events from stdout.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PROVIDER_NAME = "t3";
/** K-707: the longest `output` of a command result. */
export const MAX_COMMAND_OUTPUT_LENGTH = 64 * 1024;

export const ProviderLevels = Schema.Struct({
  view: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  control: Schema.optionalKey(Schema.String),
});

export const ProviderKind = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  levels: ProviderLevels,
});

export const ProviderCommand = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kinds: Schema.Array(Schema.String),
  confirm: Schema.Boolean,
});
export type ProviderCommand = typeof ProviderCommand.Type;

export const ProviderFact = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  role: Schema.optionalKey(Schema.Literals(["version", "busy"])),
});

const RESERVED_SITE_NAMES: ReadonlySet<string> = new Set(["pages", "files", "kit", "www"]);

export const ProviderResource = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["running", "stopped", "deploying", "failed", "unknown"]),
  facts: Schema.optionalKey(Schema.Array(ProviderFact)),
  /** K-1104: the card as a live site. Phase A sends none. kitshn refuses its own names (K-817). */
  site: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(
        Schema.makeFilter(
          (name: string) => !RESERVED_SITE_NAMES.has(name) || `${name} is a site name of kitshn`,
        ),
      ),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    }),
  ),
});
export type ProviderResource = typeof ProviderResource.Type;

export const Request = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("register"),
    provider: Schema.Literal(PROVIDER_NAME),
    kinds: Schema.Array(ProviderKind),
    commands: Schema.Array(ProviderCommand),
    // K-704: a card that a register leaves out goes offline, so a register is never empty.
    resources: Schema.NonEmptyArray(ProviderResource),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("upsert"),
    provider: Schema.Literal(PROVIDER_NAME),
    resources: Schema.Array(ProviderResource),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("command-result"),
    provider: Schema.Literal(PROVIDER_NAME),
    commandId: Schema.Int,
    ok: Schema.Boolean,
    output: Schema.String.check(Schema.isMaxLength(MAX_COMMAND_OUTPUT_LENGTH)),
  }),
]);
export type Request = typeof Request.Type;

export const GrantRule = Schema.Union([
  Schema.Struct({ email: Schema.String }),
  Schema.Struct({ domain: Schema.String }),
  Schema.Struct({ ip: Schema.String }),
  Schema.Struct({ device: Schema.Struct({ clientId: Schema.String, name: Schema.String }) }),
  Schema.Struct({ machine: Schema.Struct({ machineId: Schema.String, clientId: Schema.String }) }),
  Schema.Struct({ everyone: Schema.Literal(true) }),
  // A rule type that this T3 does not know still decodes, so the rest of the table stays usable.
  // It never matches, and it fails an `all` circle, so a new rule type cannot widen access.
  Schema.Record(Schema.String, Schema.Unknown),
]);

export const Grant = Schema.Struct({
  circle: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    match: Schema.Literals(["any", "all"]),
    needsPasskey: Schema.Boolean,
    rules: Schema.Array(GrantRule),
  }),
  level: Schema.String,
  endsAt: Schema.NullOr(Schema.Number),
});

/** K-706: the grants of each resource, by the provider's resource id. */
export const GrantTables = Schema.Record(Schema.String, Schema.Array(Grant));
export type GrantTables = typeof GrantTables.Type;

export const Answer = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("register"),
    machineId: Schema.String,
    grants: GrantTables,
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("upsert") }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("command-result") }),
  Schema.Struct({
    id: Schema.NullOr(Schema.String),
    type: Schema.Literal("error"),
    error: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("grants"), provider: Schema.String, tables: GrantTables }),
  Schema.Struct({
    type: Schema.Literal("command"),
    provider: Schema.String,
    commandId: Schema.Int,
    command: Schema.String,
    resource: Schema.NullOr(Schema.String),
  }),
]);
export type Answer = typeof Answer.Type;

const decodeAnswerOption = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));

/** One stdout line, or none when it is not a known answer or event. */
export const decodeAnswer = (line: string): Option.Option<Answer> => decodeAnswerOption(line);

/** One stdin line, with its newline. It throws on a request that breaks its own schema. */
export const requestLine = (request: Request): string => `${encodeRequest(request)}\n`;

export const grantCount = (tables: GrantTables): number =>
  Object.values(tables).reduce((sum, grants) => sum + grants.length, 0);
