/**
 * Fork: every message of `kitshn provider` (K-702 to K-707), the only copy in T3. Source of truth:
 * kitshn `packages/local/src/provider.ts` and `index.ts`. The child bridges the local socket, so
 * asks and local requests use it too. "cutover" marks a shape that kitshn has not merged yet.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

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
  /** K-719 (cutover): the Owner circle always holds each card of the kind at its top level. */
  ownerControl: Schema.optionalKey(Schema.Boolean),
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

export const ProviderSticker = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(24)),
  tone: Schema.Literals(["info", "good", "warn", "bad"]),
  link: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});

const RESERVED_SITE_NAMES: ReadonlySet<string> = new Set(["pages", "files", "kit", "www"]);

export const ProviderResource = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["running", "stopped", "deploying", "failed", "unknown"]),
  /** K-508: the card stacks under the card of this resource. */
  parent: Schema.optionalKey(Schema.String),
  facts: Schema.optionalKey(Schema.Array(ProviderFact)),
  stickers: Schema.optionalKey(Schema.Array(ProviderSticker)),
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
    type: Schema.Literal("remove"),
    provider: Schema.Literal(PROVIDER_NAME),
    ids: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("command-result"),
    provider: Schema.Literal(PROVIDER_NAME),
    commandId: Schema.Int,
    ok: Schema.Boolean,
    output: Schema.String.check(Schema.isMaxLength(MAX_COMMAND_OUTPUT_LENGTH)),
  }),
  /** K-1710, K-1711: an ask as this machine. T3 sends only `state`. */
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("ask"),
    action: Schema.Literal("state"),
    target: Schema.String,
  }),
  /** K-1612 (cutover): cancels a queued job that runs on this machine or that it queued. */
  Schema.Struct({ id: Schema.String, type: Schema.Literal("job-cancel"), jobId: Schema.Int }),
  /** K-605 (cutover): the resource sample now and the samples of the last hour. */
  Schema.Struct({ id: Schema.String, type: Schema.Literal("samples") }),
]);
export type Request = typeof Request.Type;
/** The requests that wait for an answer of the same id. */
export type LocalRequest = Extract<Request, { readonly type: "ask" | "job-cancel" | "samples" }>;
export type LocalRequestInput = LocalRequest extends infer R
  ? R extends LocalRequest
    ? Omit<R, "id">
    : never
  : never;

/** K-605 (cutover): one resource sample; each share is between 0 and 1. */
export const Sample = Schema.Struct({
  at: Schema.Number,
  cpu: Schema.Number,
  memory: Schema.Number,
  disk: Schema.Number,
});

const KnownRule = Schema.Union([
  Schema.Struct({ email: Schema.String }),
  Schema.Struct({ domain: Schema.String }),
  Schema.Struct({ ip: Schema.String }),
  Schema.Struct({ device: Schema.Struct({ clientId: Schema.String, name: Schema.String }) }),
  Schema.Struct({ machine: Schema.Struct({ machineId: Schema.String, clientId: Schema.String }) }),
  Schema.Struct({ everyone: Schema.Literal(true) }),
]);
const isKnownRule = Schema.is(KnownRule);

/**
 * K-706: a rule of a type that this T3 does not know decodes as `{ unknown: <its key> }`, as in
 * `@kitshn/local`, so the rest of the table stays usable. It never matches and fails an `all`
 * circle, so a new rule type cannot widen access.
 */
export const GrantRule = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Union([KnownRule, Schema.Struct({ unknown: Schema.String })]), {
    decode: SchemaGetter.transform((value: unknown) =>
      isKnownRule(value)
        ? value
        : {
            unknown:
              typeof value === "object" && value !== null
                ? (Object.keys(value)[0] ?? "")
                : typeof value,
          },
    ),
    encode: SchemaGetter.transform((rule) => rule),
  }),
);
export type GrantRule = typeof GrantRule.Type;

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
export type Grant = typeof Grant.Type;

/** K-706: the grants of each resource, by the provider's resource id. */
export const GrantTables = Schema.Record(Schema.String, Schema.Array(Grant));
export type GrantTables = typeof GrantTables.Type;

export const Answer = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("register"),
    machineId: Schema.String,
    grants: GrantTables,
    /** K-704 (cutover): the name of this machine on the map; null before its first connection. */
    machineName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  /** K-1710: kitshn ran the ask (`done`), holds it for the owner, or refused it. */
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("ask"),
    outcome: Schema.Literals(["done", "waiting", "refused", "not-kitshn"]),
    result: Schema.optionalKey(Schema.Unknown),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("job-cancel") }),
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("samples"),
    newest: Sample,
    history: Schema.Array(Sample),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("upsert") }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("remove") }),
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
