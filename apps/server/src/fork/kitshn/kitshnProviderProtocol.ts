/**
 * Fork: every message of `kitshn provider` (K-702 to K-707), the only copy in T3. Source of truth:
 * kitshn `packages/local/src/provider.ts` and `index.ts`. The child bridges the local socket, so
 * asks and local requests use it too.
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

/** K-717: a setting of each card of a kind, with a closed list of values. */
export const ProviderCardSetting = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  values: Schema.Array(Schema.String),
  default: Schema.String,
});

export const ProviderKind = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  levels: ProviderLevels,
  /** K-719: the Owner circle always holds each card of the kind at its top level. */
  ownerControl: Schema.optionalKey(Schema.Boolean),
  /** K-709: a kind of desired state, with no cards and no levels. */
  state: Schema.optionalKey(Schema.Struct({ schema: Schema.optionalKey(Schema.Unknown) })),
  /** K-717: settings of each card of the kind. */
  settings: Schema.optionalKey(Schema.Array(ProviderCardSetting)),
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

/** K-1625: a list on a card; a row names the commands that the card menu offers for it. */
export const ProviderList = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  columns: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })),
  rows: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      cells: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(200))),
      commands: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type ProviderList = typeof ProviderList.Type;

export const ProviderResource = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["running", "stopped", "deploying", "failed", "unknown"]),
  /** K-508: the card stacks under the card of this resource. */
  parent: Schema.optionalKey(Schema.String),
  facts: Schema.optionalKey(Schema.Array(ProviderFact)),
  stickers: Schema.optionalKey(Schema.Array(ProviderSticker)),
  lists: Schema.optionalKey(Schema.Array(ProviderList)),
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

/** K-707, K-1612: a provider command as a kitshn job; `resource` null is the machine card. */
export const ProviderJobCommand = Schema.Struct({
  kind: Schema.Literal("provider"),
  provider: Schema.String,
  command: Schema.String,
  resource: Schema.NullOr(Schema.String),
  row: Schema.optionalKey(Schema.String),
});

/** K-709: the shared part and this machine's part of one desired state; null where none is set. */
export const DesiredParts = Schema.Struct({ shared: Schema.Unknown, machine: Schema.Unknown });
export type DesiredParts = typeof DesiredParts.Type;

/** K-717: card setting values, by resource id, then by setting id. */
export const CardSettingValues = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.String),
);
export type CardSettingValues = typeof CardSettingValues.Type;

/** K-1609: a card of another machine that this machine reaches. `address` is null for `t3.agents`. */
export const ReachedCard = Schema.Struct({
  machineId: Schema.String,
  machineName: Schema.String,
  kind: Schema.String,
  id: Schema.String,
  address: Schema.NullOr(Schema.String),
  level: Schema.String,
});
export type ReachedCard = typeof ReachedCard.Type;

/** K-1610: what this machine reports of one call on another machine; never arguments or output. */
export const LinkAudit = Schema.Struct({
  kind: Schema.Literals(["exec", "tool"]),
  target: Schema.String.check(Schema.isMaxLength(64)),
  thread: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  /** One word: the first word of the command, or the tool name. */
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
    Schema.makeFilter(
      (name: string) =>
        ![...name].some((char) => char.trim() === "") || "one word, with no arguments",
    ),
  ),
  cwd: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  outcome: Schema.Literals(["succeeded", "refused", "failed"]),
  exitCode: Schema.NullOr(Schema.Int),
  at: Schema.Number,
});
export type LinkAudit = typeof LinkAudit.Type;

/** K-1623: the team domain and the AUD tags of kitshn's Access applications on this provider's hosts. */
export const AccessApp = Schema.Struct({
  teamDomain: Schema.String,
  audiences: Schema.Array(Schema.String),
});
export type AccessApp = typeof AccessApp.Type;

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
  /** K-1612: run a provider command on a machine as this machine, if a circle lets it. */
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("ask"),
    action: Schema.Literal("job"),
    target: Schema.String,
    body: Schema.Struct({ command: ProviderJobCommand }),
  }),
  /** K-709: set the part of a desired state of this machine, or the shared part; null clears it. */
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("desired-set"),
    provider: Schema.Literal(PROVIDER_NAME),
    kind: Schema.String,
    part: Schema.Literals(["shared", "machine"]),
    value: Schema.Unknown,
  }),
  /** K-1610: report one call on another machine. */
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("audit"),
    provider: Schema.Literal(PROVIDER_NAME),
    audit: LinkAudit,
  }),
  /** K-1612: cancels a queued job that this machine queued. */
  Schema.Struct({ id: Schema.String, type: Schema.Literal("job-cancel"), jobId: Schema.Int }),
  /** K-605: the resource sample now and the samples of the last hour. */
  Schema.Struct({ id: Schema.String, type: Schema.Literal("samples") }),
]);
export type Request = typeof Request.Type;
/** The requests that wait for an answer of the same id. */
export type LocalRequest = Extract<
  Request,
  { readonly type: "ask" | "job-cancel" | "samples" | "desired-set" | "audit" }
>;
export type LocalRequestInput = LocalRequest extends infer R
  ? R extends LocalRequest
    ? Omit<R, "id">
    : never
  : never;

/** K-605: one resource sample; each share is between 0 and 1. */
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
    /** K-704: the name of this machine on the map; null before its first connection. */
    machineName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    /** K-709: the saved desired state of each kind, also while kitshn is out of reach. */
    desired: Schema.optionalKey(Schema.Record(Schema.String, DesiredParts)),
    /** K-717: the saved card setting values. */
    settings: Schema.optionalKey(CardSettingValues),
    /** K-1609: the saved reach of this machine. */
    reach: Schema.optionalKey(Schema.Array(ReachedCard)),
    /**
     * K-1609: the link proxy: a Unix socket path, or a `\\.\pipe\` name on Windows. Null while
     * the machine has no link proxy, so it has no outgoing links.
     */
    linkSocket: Schema.optionalKey(Schema.NullOr(Schema.String)),
    /** K-1623: the Access audiences of this provider's hosts; null before kitshn sent them. */
    access: Schema.optionalKey(Schema.NullOr(AccessApp)),
  }),
  /** Pending contract: an event: the Access app of this machine's host changed. */
  Schema.Struct({
    type: Schema.Literal("access"),
    provider: Schema.String,
    access: Schema.NullOr(AccessApp),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("audit") }),
  /** K-1609: an event: the cards of other machines that this machine reaches, on each change. */
  Schema.Struct({
    type: Schema.Literal("reach"),
    provider: Schema.String,
    cards: Schema.Array(ReachedCard),
  }),
  Schema.Struct({ id: Schema.String, type: Schema.Literal("desired-set") }),
  /** K-709: an event: the desired state of one kind, on each change. */
  Schema.Struct({
    type: Schema.Literal("desired"),
    provider: Schema.String,
    kind: Schema.String,
    state: DesiredParts,
  }),
  /** K-717: an event: the card setting values, on each change. */
  Schema.Struct({
    type: Schema.Literal("settings"),
    provider: Schema.String,
    values: CardSettingValues,
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
    /** K-1625: the row of a list that the command is for. */
    row: Schema.optionalKey(Schema.String),
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
