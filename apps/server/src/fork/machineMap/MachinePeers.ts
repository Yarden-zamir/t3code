/**
 * Fork: this server as a client of other machines through kitshn links (K-1609): a link to B holds
 * while the reach has B's `t3.app` and `t3.agents` cards. Calls go through the daemon's link proxy,
 * which adds this machine's token. Upstream `PeerLinks` and `PeerMcpClient` run over the links.
 */
import {
  ARROW_LINK_NO_EXPIRY,
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  type AuthMcpClientAccess,
  AuthPairingCredentialResult,
  AuthTokenExchangeGrantType,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MACHINE_EXEC_STREAM_PATH,
  type MachineExecInput,
  MachineExecResult,
  type MachineExecStreamStart,
  MachineId,
  type OrchestratorMcpFailure,
  type PeerLink,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Undici from "undici";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import { execName } from "../kitshn/KitshnAudit.ts";
import * as KitshnAudit from "../kitshn/KitshnAudit.ts";
import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { PROVIDER_NAME, type ReachedCard } from "../kitshn/kitshnProviderProtocol.ts";
import * as KitshnProvider from "../kitshn/KitshnProvider.ts";
import {
  CLI_LOCAL_USER_REFUSAL,
  isCliLocalUser,
  isMachineRequestNamespace,
  MANUAL_LINK_REFUSAL,
} from "./machineAccess.ts";
import { historyCaller, requireMachineExecCaller } from "./machineCallerAccess.ts";
import { type ExecSocket, openExecSocket, streamUrl } from "./machineExecStream.ts";

const REQUEST_TIMEOUT = Duration.seconds(15);
// Short, as the probe of upstream `PeerLinks.resolve`: a linked machine answers its descriptor fast.
const DESCRIPTOR_TIMEOUT = Duration.seconds(5);
const NO_EXPIRY = DateTime.makeUnsafe(ARROW_LINK_NO_EXPIRY);

export class MachinePeerError extends Schema.TaggedError<MachinePeerError>()("MachinePeerError", {
  reason: Schema.Literals([
    "no-links",
    "unknown-machine",
    "no-exec",
    "caller-refused",
    "unreachable",
  ]),
  /** A message safe to show to the agent. */
  detail: Schema.String,
  /** MM-1908: the machine that the call was for, once the call named one in the reach. */
  target: Schema.optional(MachineId),
}) {
  override get message(): string {
    return this.detail;
  }
}

interface PeerSession {
  readonly accessToken: string;
}

/** MM-1907: a machine whose threads this machine can read, for the `@` menu of its clients. */
export interface ReadableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly machineId: MachineId;
  readonly name: string;
}

type CallerServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagement.ThreadManagementService;

export class MachinePeers extends Context.Service<
  MachinePeers,
  {
    /** MM-1908: `machine_exec` on a machine whose link allows exec. B checks its grants again. */
    readonly exec: (
      input: MachineExecInput,
    ) => Effect.Effect<
      MachineExecResult,
      MachinePeerError | OrchestratorMcpFailure,
      CallerServices
    >;
    /** MM-1919: opens the exec stream of `t3 machine exec`, with the same checks as `exec`. */
    readonly openExec: (
      input: MachineExecStreamStart,
    ) => Effect.Effect<
      ExecSocket,
      MachinePeerError | OrchestratorMcpFailure,
      CallerServices | Scope.Scope
    >;
    /** MM-1907: the linked machines that answer now, with their environment ids. */
    readonly readableEnvironments: Effect.Effect<ReadonlyArray<ReadableEnvironment>>;
    /** MM-1922: the machine that answered as this environment id, once a lookup reached it. */
    readonly machineOf: (environmentId: EnvironmentId) => MachineId | undefined;
  }
>()("t3/fork/machineMap/MachinePeers") {}

/** K-1609: one link from the reach: B's `t3.app` and `t3.agents` cards. */
export interface LinkTarget {
  readonly machine: { readonly id: MachineId; readonly name: string };
  /** K-1609: the link proxy address of B, `/<provider>/<machine id>`, on the daemon's socket. */
  readonly origin: string;
  readonly access: AuthMcpClientAccess;
  /** `t3.agents` at exec, and `t3.app` at use or control (MM-1908). */
  readonly exec: boolean;
}

/** The `t3.app` level names, by kitshn level or provider level, and their link access (MM-302). */
const LINK_ACCESS: Readonly<Record<string, AuthMcpClientAccess>> = {
  view: "read-only",
  read: "read-only",
  use: "auto",
  standard: "auto",
  control: "full-access",
  admin: "full-access",
};

/** K-1609: the links of a reach. A machine without both cards has no link. */
export const linkTargets = (reach: ReadonlyArray<ReachedCard>): ReadonlyArray<LinkTarget> => {
  const machines = new Map<string, { app?: ReachedCard; agents?: ReachedCard }>();
  for (const card of reach) {
    const entry = machines.get(card.machineId) ?? {};
    if (card.kind === "t3.app") entry.app = card;
    if (card.kind === "t3.agents") entry.agents = card;
    machines.set(card.machineId, entry);
  }
  return [...machines].flatMap(([machineId, { app, agents }]) => {
    const access = app === undefined ? undefined : LINK_ACCESS[app.level];
    if (app === undefined || agents === undefined || access === undefined) return [];
    return [
      {
        machine: { id: MachineId.make(machineId), name: app.machineName },
        origin: `http://link/${PROVIDER_NAME}/${encodeURIComponent(machineId)}`,
        access,
        exec: agents.level === "exec" && access !== "read-only",
      },
    ];
  });
};

/** What the descriptor of a linked machine says. */
interface PeerIdentity {
  readonly environmentId: EnvironmentId;
  /** MM-1904: it narrows a linked caller to `T3-Mode-Limit` and fences its work. */
  readonly holdsLimits: boolean;
}

interface Link extends PeerIdentity {
  readonly target: LinkTarget;
  readonly answered: boolean;
}

/** A refused WebSocket upgrade: the session of this machine on B ended. */
const refusedUpgrade = (cause: unknown) =>
  Predicate.isTagged(cause, "SocketError") &&
  Predicate.hasProperty(cause, "reason") &&
  Predicate.hasProperty(cause.reason, "cause") &&
  Predicate.hasProperty(cause.reason.cause, "message") &&
  String(cause.reason.cause.message).includes("401");

/**
 * MM-1921: the environment id of a link whose machine has not answered since this server started.
 * It only names the link in the list: `resolve` never sends work with it.
 */
const UNANSWERED_ID_PREFIX = "machine:";
const unansweredEnvironmentId = (machine: MachineId) =>
  EnvironmentId.make(`${UNANSWERED_ID_PREFIX}${machine}`);
const machineOfUnanswered = (environmentId: EnvironmentId) =>
  environmentId.startsWith(UNANSWERED_ID_PREFIX)
    ? MachineId.make(environmentId.slice(UNANSWERED_ID_PREFIX.length))
    : undefined;
const notAnswered = (target: LinkTarget) =>
  `${target.machine.name} has not answered since this server started. It may be offline, or run a T3 Code version without kitshn links.`;
const NO_LINK =
  "No kitshn link from this machine reaches it. The owner shares the machine's T3 app and T3 agents cards with this machine on the kitshn map.";

const describeFailure = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    return cause.response === undefined ? cause.reason._tag : `HTTP ${cause.response.status}`;
  }
  return Predicate.isTagged(cause, "TimeoutError") ? "timed out" : "unexpected response";
};

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const grants = yield* KitshnGrants.KitshnGrants;
  const audit = yield* KitshnAudit.KitshnAudit;
  // One session per linked machine. B ends it when the grants of this machine change (K-706);
  // the link client then pairs again once.
  const sessions = new Map<string, PeerSession>();
  const identities = new Map<string, PeerIdentity>();
  const machineOfEnvironment = new Map<EnvironmentId, MachineId>();
  let lastLinks: ReadonlyArray<Link> = [];
  const firstSeen = new Map<EnvironmentId, DateTime.Utc>();
  const outcomes = new Map<
    EnvironmentId,
    { readonly lastReachedAt: DateTime.Utc | null; readonly lastError: string | null }
  >();

  /** The reach and the link proxy now; no proxy (Windows for now) means no links, not an error. */
  const current = Effect.all([provider.state.pipe(Stream.runHead), provider.linkSocket]).pipe(
    Effect.map(([state, socket]) =>
      socket === null || Option.isNone(state)
        ? { targets: [] as ReadonlyArray<LinkTarget>, socket: null }
        : { targets: linkTargets(state.value.reach), socket },
    ),
  );

  // One dispatcher per proxy path: a Unix socket, or a named pipe on Windows.
  const dispatchers = new Map<string, Undici.Agent>();
  const dispatcherFor = (socketPath: string) => {
    let agent = dispatchers.get(socketPath);
    if (agent === undefined) {
      agent = new Undici.Agent({ connect: { socketPath } });
      dispatchers.set(socketPath, agent);
    }
    return agent;
  };
  const proxyClient = (socketPath: string) =>
    HttpClient.HttpClient.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        FetchHttpClient.RequestInit,
        // undici's fetch reads `dispatcher`; the DOM type does not name it.
        { dispatcher: dispatcherFor(socketPath) } as unknown as globalThis.RequestInit,
      ),
      Effect.provideService(FetchHttpClient.Fetch, Undici.fetch as unknown as typeof fetch),
    );
  /** Sends a request through the link proxy of the current socket. */
  const viaProxy = (request: HttpClientRequest.HttpClientRequest) =>
    current.pipe(
      Effect.flatMap(({ socket }) =>
        socket === null
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: "This machine has no kitshn link proxy.",
                }),
              }),
            )
          : proxyClient(socket).pipe(
              Effect.flatMap((client) => client.execute(request)),
              // A connection error: the next use checks the socket with `kitshn link-check` again.
              Effect.tapError((error) =>
                error.reason._tag === "TransportError"
                  ? provider.linkSocketFailed(socket)
                  : Effect.void,
              ),
            ),
      ),
    );

  const selfName = grants.machine.pipe(Effect.map((machine) => machine?.name ?? "machine"));

  const pair = Effect.fn("MachinePeers.pair")(function* (target: LinkTarget) {
    const credential = yield* HttpClientRequest.post(
      `${target.origin}/api/auth/cloudflare-access/pairing-credential`,
    ).pipe(
      viaProxy,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const exchanged = yield* HttpClientRequest.post(`${target.origin}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: `machine ${yield* selfName}`,
        client_device_type: "bot",
      }),
      viaProxy,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const session: PeerSession = { accessToken: exchanged.access_token };
    sessions.set(target.machine.id, session);
    return session;
  });

  const identityOf = Effect.fn("MachinePeers.identityOf")(function* (target: LinkTarget) {
    const descriptor = yield* HttpClientRequest.get(
      `${target.origin}/.well-known/t3/environment`,
    ).pipe(
      viaProxy,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.timeout(DESCRIPTOR_TIMEOUT),
    );
    const identity: PeerIdentity = {
      environmentId: descriptor.environmentId,
      holdsLimits:
        descriptor.capabilities.mcpModeLimitHeader === true &&
        descriptor.capabilities.linkFence === true,
    };
    identities.set(target.machine.id, identity);
    machineOfEnvironment.set(identity.environmentId, target.machine.id);
    return identity;
  });

  /** The links now. `refresh` asks each machine for its environment id again. */
  const looks = Effect.fn("MachinePeers.looks")(function* (refresh: boolean) {
    const { targets } = yield* current;
    const looked = yield* Effect.forEach(
      targets,
      (target) => {
        const cached = identities.get(target.machine.id);
        const probe =
          cached !== undefined && !refresh
            ? Effect.succeedSome(cached)
            : identityOf(target).pipe(Effect.option);
        return probe.pipe(
          Effect.map((found) => {
            const identity = Option.getOrUndefined(found) ?? cached;
            return {
              target,
              link:
                identity === undefined
                  ? undefined
                  : ({ ...identity, target, answered: Option.isSome(found) } satisfies Link),
            };
          }),
        );
      },
      { concurrency: "unbounded" },
    );
    const links = looked.flatMap(({ link }) => (link === undefined ? [] : [link]));
    // A link that came back: the error of its absence is stale.
    for (const link of links) {
      const outcome = outcomes.get(link.environmentId);
      if (
        !lastLinks.some((last) => last.environmentId === link.environmentId) &&
        outcome !== undefined &&
        outcome.lastError !== null
      ) {
        outcomes.set(link.environmentId, { ...outcome, lastError: null });
      }
    }
    lastLinks = links;
    return {
      links,
      unanswered: looked.flatMap(({ target, link }) => (link === undefined ? [target] : [])),
    };
  });

  const toPeerLink = Effect.fn("MachinePeers.toPeerLink")(function* (
    environmentId: EnvironmentId,
    target: LinkTarget,
  ) {
    const now = yield* DateTime.now;
    const linkedAt = firstSeen.get(environmentId) ?? now;
    firstSeen.set(environmentId, linkedAt);
    const outcome = outcomes.get(environmentId);
    return {
      environmentId,
      label: target.machine.name,
      urls: [target.origin],
      access: target.access,
      linkedAt,
      expiresAt: NO_EXPIRY,
      lastReachedAt: outcome?.lastReachedAt ?? null,
      lastError: outcome?.lastError ?? null,
    } satisfies PeerLink;
  });

  const findLink = Effect.fn("MachinePeers.findLink")(function* (environmentId: EnvironmentId) {
    const cached = yield* looks(false);
    const found = cached.links.find((link) => link.environmentId === environmentId);
    if (found !== undefined) return { ...cached, found };
    const fresh = yield* looks(true);
    return { ...fresh, found: fresh.links.find((link) => link.environmentId === environmentId) };
  });

  const manualRefused = Effect.fail(
    new PeerLinkError({ reason: "incompatible", message: MANUAL_LINK_REFUSAL }),
  );
  const linkError = (reason: PeerLinkError["reason"], message: string) =>
    new PeerLinkError({ reason, message });

  const peerLinks = PeerLinks.PeerLinks.of({
    // The reach is the switch: a machine without reach has no links.
    enabled: Effect.succeed(true),
    describe: Effect.fn("MachinePeers.describe")(function* () {
      return Option.none();
    }),
    link: Effect.fn("MachinePeers.link")(function () {
      return manualRefused;
    }),
    unlink: Effect.fn("MachinePeers.unlink")(function () {
      return manualRefused;
    }),
    list: Effect.gen(function* () {
      const looked = yield* looks(true);
      const linked = yield* Effect.forEach(looked.links, (link) =>
        toPeerLink(link.environmentId, link.target).pipe(
          Effect.map((peerLink): PeerLinkSummary => ({
            ...peerLink,
            status: link.answered ? "reachable" : "unreachable",
          })),
        ),
      );
      const unanswered = yield* Effect.forEach(looked.unanswered, (target) =>
        toPeerLink(unansweredEnvironmentId(target.machine.id), target).pipe(
          Effect.map((peerLink): PeerLinkSummary => ({
            ...peerLink,
            lastError: notAnswered(target),
            status: "unreachable",
          })),
        ),
      );
      return [...linked, ...unanswered];
    }).pipe(Effect.withSpan("MachinePeers.listLinks")),
    get: Effect.fn("MachinePeers.getLink")(function (environmentId) {
      return findLink(environmentId).pipe(
        Effect.flatMap(({ found }) =>
          found === undefined
            ? Effect.succeedNone
            : Effect.asSome(toPeerLink(found.environmentId, found.target)),
        ),
      );
    }),
    resolve: Effect.fn("MachinePeers.resolveLink")(function* (environmentId) {
      // MM-1904: a session of another machine never lends it the links of this machine.
      const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
      if (Option.isSome(scope) && isMachineRequestNamespace(scope.value.requestNamespace)) {
        return yield* linkError(
          "incompatible",
          "Work from another machine cannot use the links of this machine.",
        );
      }
      // MM-1920: the local-user session of the CLI has no thread limits to send along.
      if (Option.isSome(scope) && isCliLocalUser(scope.value)) {
        return yield* linkError("incompatible", CLI_LOCAL_USER_REFUSAL);
      }
      const unansweredMachine = machineOfUnanswered(environmentId);
      if (unansweredMachine !== undefined) {
        const fresh = yield* looks(true);
        const answered = fresh.links.find((link) => link.target.machine.id === unansweredMachine);
        const waiting = fresh.unanswered.find((target) => target.machine.id === unansweredMachine);
        return yield* answered !== undefined
          ? linkError(
              "unknown_link",
              `${answered.target.machine.name} answers now as ${answered.environmentId}. Use that environmentId.`,
            )
          : waiting === undefined
            ? linkError("unknown_link", `${environmentId}: ${NO_LINK}`)
            : linkError("unreachable", notAnswered(waiting));
      }
      const looked = yield* findLink(environmentId);
      if (looked.found === undefined) {
        const machine = machineOfEnvironment.get(environmentId);
        const linked =
          machine !== undefined &&
          (yield* current).targets.some((target) => target.machine.id === machine);
        return yield* linked || (machine === undefined && looked.unanswered.length > 0)
          ? linkError(
              "unreachable",
              `No linked machine answers as ${environmentId} now. A machine may be offline.`,
            )
          : linkError("unknown_link", `${environmentId}: ${NO_LINK}`);
      }
      const { target } = looked.found;
      // The session goes only to a machine that answers as this id now, with the limits held.
      const now = yield* identityOf(target).pipe(Effect.option);
      if (Option.isNone(now) || now.value.environmentId !== environmentId) {
        return yield* linkError(
          "unreachable",
          `${target.machine.name} does not answer as ${environmentId} now.`,
        );
      }
      if (!now.value.holdsLimits) {
        return yield* linkError(
          "incompatible",
          `${target.machine.name} runs a T3 Code version that cannot keep the limits of an agent from another machine. Update it.`,
        );
      }
      const session =
        sessions.get(target.machine.id) ??
        (yield* pair(target).pipe(
          Effect.mapError((cause) => {
            const detail = describeFailure(cause);
            return detail === "HTTP 401" || detail === "HTTP 403"
              ? linkError(
                  "pairing_rejected",
                  `${target.machine.name} refused the pairing: ${detail}.`,
                )
              : linkError("unreachable", `${target.machine.name} did not answer: ${detail}.`);
          }),
        ));
      return {
        link: yield* toPeerLink(looked.found.environmentId, target),
        url: target.origin,
        token: session.accessToken,
      };
    }),
    recordOutcome: Effect.fn("MachinePeers.recordOutcome")(function (environmentId, outcome) {
      return DateTime.now.pipe(
        Effect.map((now) => {
          const previous = outcomes.get(environmentId);
          outcomes.set(
            environmentId,
            outcome.error === null
              ? { lastReachedAt: now, lastError: null }
              : { lastReachedAt: previous?.lastReachedAt ?? null, lastError: outcome.error },
          );
        }),
      );
    }),
  });

  /**
   * The client of `PeerMcpClient`: link calls go through the proxy with the session. B ends the
   * session when this machine's grants change, so a 401 pairs again and retries once.
   */
  const linkHttpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      const link = lastLinks.find((candidate) =>
        request.url.startsWith(`${candidate.target.origin}/`),
      );
      if (link === undefined) return yield* viaProxy(request);
      const { target } = link;
      const send = (session: PeerSession | undefined) =>
        viaProxy(
          session === undefined
            ? request
            : HttpClientRequest.setHeader(
                request,
                "authorization",
                `Bearer ${session.accessToken}`,
              ),
        );
      const response = yield* send(sessions.get(target.machine.id));
      if (response.status !== 401) return response;
      sessions.delete(target.machine.id);
      const refused = (description: string) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description }),
        });
      const renewed = yield* pair(target).pipe(
        Effect.mapError((cause) =>
          refused(`${target.machine.name} refused to pair again: ${describeFailure(cause)}`),
        ),
      );
      const again = yield* send(renewed);
      return again.status === 401
        ? yield* refused(`${target.machine.name} refused this machine after it paired again`)
        : again;
    }),
  );

  const peerMcp = Context.get(
    yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(Layer.succeed(PeerLinks.PeerLinks, peerLinks)),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, linkHttpClient)),
      ),
    ),
    PeerMcpClient.PeerMcpClient,
  );

  /** A linked machine by id or name. */
  const resolvePeer = Effect.fn("MachinePeers.resolvePeer")(function* (machine: string) {
    const { targets, socket } = yield* current;
    if (socket === null) {
      return yield* new MachinePeerError({
        reason: "no-links",
        detail: `No link to ${machine}: this machine has no checked kitshn link proxy now.`,
      });
    }
    const wanted = machine.trim().toLowerCase();
    const target = targets.find(
      (candidate) =>
        candidate.machine.id === machine || candidate.machine.name.toLowerCase() === wanted,
    );
    if (target === undefined) {
      return yield* new MachinePeerError({
        reason: "unknown-machine",
        detail: `No machine named "${machine}" is linked: ${NO_LINK}`,
      });
    }
    return { target, socket };
  });

  /** MM-1908: the checks of this machine before a command goes to a peer. */
  const admitExec = Effect.fn("MachinePeers.admitExec")(function* (machine: string) {
    const resolved = yield* resolvePeer(machine);
    const refused = (reason: MachinePeerError["reason"], detail: string) =>
      new MachinePeerError({ reason, detail, target: resolved.target.machine.id });
    // One read of the caller: its limits go out with the call (`T3-Mode-Limit`).
    const { limits } = yield* requireMachineExecCaller().pipe(
      Effect.mapError((failure) => refused("caller-refused", failure.message)),
    );
    if (!resolved.target.exec) {
      return yield* refused(
        "no-exec",
        `The link to ${resolved.target.machine.name} does not allow exec. It needs its T3 agents card at exec and its T3 app card at use or control, shared with this machine on the kitshn map.`,
      );
    }
    const link = (yield* looks(false)).links.find(
      (candidate) => candidate.target.machine.id === resolved.target.machine.id,
    );
    if (link === undefined) {
      return yield* refused("unreachable", `${resolved.target.machine.name} does not answer now.`);
    }
    const caller = yield* historyCaller();
    return { resolved, refused, limits, link, caller };
  });

  /** K-1610: this machine reports each run on another machine; the target reports nothing. */
  const reportExec = (
    input: { readonly command: string; readonly cwd?: string | undefined },
    target: MachineId,
    outcome: "succeeded" | "refused" | "failed",
    exitCode: number | null,
  ) =>
    historyCaller().pipe(
      Effect.flatMap((caller) =>
        audit.report({
          kind: "exec",
          target,
          thread: caller.threadId,
          name: execName(input.command),
          cwd: input.cwd ?? null,
          outcome,
          exitCode,
        }),
      ),
    );
  const reportRefusal =
    (input: { readonly command: string; readonly cwd?: string | undefined }) =>
    (error: MachinePeerError) =>
      error.target === undefined
        ? Effect.void
        : reportExec(
            input,
            error.target,
            error.reason === "unreachable" ? "failed" : "refused",
            null,
          );

  const exec: MachinePeers["Service"]["exec"] = Effect.fn("MachinePeers.exec")(function* (input) {
    const { resolved, limits, link, caller } = yield* admitExec(input.machine).pipe(
      Effect.tapError(reportRefusal(input)),
    );
    const { caller: _ignored, ...command } = input;
    return yield* peerMcp
      .call({
        environmentId: link.environmentId,
        tool: "machine_exec",
        arguments: { ...command, machine: resolved.target.machine.id, caller },
        limits,
        success: MachineExecResult,
      })
      .pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? reportExec(
                input,
                resolved.target.machine.id,
                exit.value.outcome === "exited" ? "succeeded" : "failed",
                exit.value.exitCode,
              )
            : reportExec(input, resolved.target.machine.id, "failed", null),
        ),
      );
  });

  const openExec: MachinePeers["Service"]["openExec"] = Effect.fn("MachinePeers.openExec")(
    function* (input) {
      const { resolved, refused, limits, link, caller } = yield* admitExec(input.machine).pipe(
        Effect.tapError(reportRefusal(input)),
      );
      // Known limit: a stream is reported when it opens, without its exit code. Revisit when the
      // stream end reaches this machine as a frame that names the exit code.
      yield* reportExec(input, resolved.target.machine.id, "succeeded", null);
      const dispatcher = dispatcherFor(resolved.socket);
      // The stream goes through the link proxy too, as undici WebSocket on its dispatcher.
      const makeWebSocket: Socket.WebSocketConstructor["Service"] = (url, options) =>
        new Undici.WebSocket(url, {
          dispatcher,
          ...(typeof options === "object" &&
          !Array.isArray(options) &&
          options.headers !== undefined
            ? { headers: { ...options.headers } }
            : {}),
        }) as unknown as Socket.WebSocketLike;
      const open = peerLinks.resolve(link.environmentId).pipe(
        Effect.flatMap((target) =>
          openExecSocket(streamUrl(target.url, MACHINE_EXEC_STREAM_PATH), {
            authorization: `Bearer ${target.token}`,
            [McpInvocationContext.MODE_LIMIT_HEADER]: `${limits.runtimeMode}/${limits.interactionMode}`,
          }),
        ),
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
      );
      // B ends the sessions of this machine when its grants change, so a refused upgrade pairs
      // again once.
      const socket = yield* open.pipe(
        Effect.catchIf(refusedUpgrade, () =>
          Effect.sync(() => sessions.delete(resolved.target.machine.id)).pipe(Effect.andThen(open)),
        ),
        Effect.mapError((cause) =>
          refused(
            "unreachable",
            `${resolved.target.machine.name} did not open the exec stream: ${cause.message}`,
          ),
        ),
      );
      const { caller: _ignored, type: _start, ...command } = input;
      yield* socket
        .message({ type: "start", ...command, machine: resolved.target.machine.id, caller })
        .pipe(
          Effect.mapError((cause) =>
            refused(
              "unreachable",
              `${resolved.target.machine.name} closed the exec stream: ${cause.message}`,
            ),
          ),
        );
      return socket;
    },
  );

  const readableEnvironments: MachinePeers["Service"]["readableEnvironments"] = looks(false).pipe(
    Effect.map(({ links }) =>
      links.map((link) => ({
        environmentId: link.environmentId,
        machineId: link.target.machine.id,
        name: link.target.machine.name,
      })),
    ),
    Effect.withSpan("MachinePeers.readableEnvironments"),
  );

  return Context.make(
    MachinePeers,
    MachinePeers.of({
      exec,
      openExec,
      readableEnvironments,
      machineOf: (environmentId) => machineOfEnvironment.get(environmentId),
    }),
  ).pipe(
    Context.add(PeerLinks.PeerLinks, peerLinks),
    Context.add(PeerMcpClient.PeerMcpClient, peerMcp),
  );
});

/** `MachinePeers`, and upstream's `PeerLinks` and `PeerMcpClient` over the kitshn links (K-1609). */
export const layer = Layer.effectContext(make);
