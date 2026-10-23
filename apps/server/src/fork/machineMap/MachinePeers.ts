/**
 * Fork: machine map. This server as a client of other machines. It pairs with a peer through the
 * tunnel hostname of the peer, with this machine's token as request headers, the same way the
 * desktop app does (MM-306). The peer gives the session the scopes of the arrow (MM-1305) and the
 * link access of its level (MM-302).
 *
 * MM-1921: the arrows out of this machine with agent tools are its only linked environments. This
 * module gives upstream's `PeerLinks` those arrows instead of the table of manual links, which the
 * fork never creates (docs/fork/operations.md "Migrations"). It gives upstream's `PeerMcpClient` a
 * client that adds the machine token and pairs again once when the peer ends the session.
 */
import {
  ARROW_LINK_NO_EXPIRY,
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthPairingCredentialResult,
  AuthTokenExchangeGrantType,
  type EnvironmentId,
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
  type PeerMachine,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import {
  type ArrowLinkTarget,
  arrowAllowsExec,
  arrowLinkTargets,
  isMachineRequestNamespace,
  MANUAL_LINK_REFUSAL,
} from "./machineAccess.ts";
import { historyCaller, requireMachineExecCaller } from "./machineCallerAccess.ts";
import { type ExecSocket, openExecSocket, streamUrl } from "./machineExecStream.ts";
import * as MachineMapState from "./MachineMapState.ts";

const REQUEST_TIMEOUT = Duration.seconds(15);
// An offline peer must not hold up the `@` menu of every client for the full request timeout.
const DESCRIPTOR_TIMEOUT = Duration.seconds(5);
const NO_EXPIRY = DateTime.makeUnsafe(ARROW_LINK_NO_EXPIRY);

export class MachinePeerError extends Schema.TaggedError<MachinePeerError>()("MachinePeerError", {
  reason: Schema.Literals([
    "not-on-map",
    "unknown-machine",
    "no-exec",
    "caller-refused",
    "no-hostname",
    "unreachable",
  ]),
  /** A message safe to show to the agent or the portal. */
  detail: Schema.String,
  /** MM-1908: the machine that the call was for, once the call named one on the map. */
  target: Schema.optional(MachineId),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** MM-307: the result of `testArrow`, for the portal. */
export interface ArrowTestResult {
  readonly to: MachineId;
  readonly reachable: boolean;
  /** The round trip of the pairing request, through Cloudflare Access and the tunnel. */
  readonly roundTripMs: number | null;
  readonly scopes: ReadonlyArray<string>;
  readonly error: string | null;
}

interface PeerSession {
  readonly accessToken: string;
  readonly scopes: ReadonlyArray<string>;
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
    /** MM-307: pair with the target of an arrow from this machine and report what it granted. */
    readonly testArrow: (to: MachineId) => Effect.Effect<ArrowTestResult>;
    /**
     * MM-1908: `machine_exec` on a peer whose arrow allows exec, over its link. The peer checks
     * the arrow again, runs the command and reports it to the portal.
     */
    readonly exec: (
      input: MachineExecInput,
    ) => Effect.Effect<
      MachineExecResult,
      MachinePeerError | OrchestratorMcpFailure,
      CallerServices
    >;
    /**
     * MM-1919: opens the exec stream of `t3 machine exec` on a peer whose arrow allows exec, with
     * the same checks as `exec`, and sends its start. The peer runs the command and reports it.
     */
    readonly openExec: (
      input: MachineExecStreamStart,
    ) => Effect.Effect<
      ExecSocket,
      MachinePeerError | OrchestratorMcpFailure,
      CallerServices | Scope.Scope | Socket.WebSocketConstructor
    >;
    /** MM-1907: the linked machines that answer now, with their environment ids. */
    readonly readableEnvironments: Effect.Effect<ReadonlyArray<ReadableEnvironment>>;
    /** MM-1922: the machine that answered as this environment id, once a lookup reached it. */
    readonly machineOf: (environmentId: EnvironmentId) => MachineId | undefined;
  }
>()("t3/fork/machineMap/MachinePeers") {}

/** What the descriptor of a linked machine says. */
interface PeerIdentity {
  readonly environmentId: EnvironmentId;
  /** MM-1904: it narrows a linked caller to `T3-Mode-Limit` and fences its work. */
  readonly holdsLimits: boolean;
}

/** An arrow link with the identity that its machine answers with. */
interface ArrowLink extends PeerIdentity {
  readonly target: ArrowLinkTarget;
  /** Whether the descriptor of the machine answered on this look. */
  readonly answered: boolean;
}

/** `ws` names the HTTP status of a refused upgrade only in the message of its error event. */
const refusedUpgrade = (cause: unknown) =>
  Predicate.isTagged(cause, "SocketError") &&
  Predicate.hasProperty(cause, "reason") &&
  Predicate.hasProperty(cause.reason, "cause") &&
  Predicate.hasProperty(cause.reason.cause, "message") &&
  cause.reason.cause.message === "Unexpected server response: 401";

const describeFailure = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    return cause.response === undefined ? cause.reason._tag : `HTTP ${cause.response.status}`;
  }
  return Predicate.isTagged(cause, "TimeoutError") ? "timed out" : "unexpected response";
};

const make = Effect.gen(function* () {
  const state = yield* MachineMapState.MachineMapState;
  const httpClient = yield* HttpClient.HttpClient;
  // One session per peer address, so repeated calls do not pile up sessions there, and a new
  // hostname never gets the session of the old one. A level change on the peer revokes it
  // (MM-1306); the link client then pairs again once.
  const sessions = new Map<string, PeerSession>();
  // What each peer address answered as. A peer keeps its environment id across restarts.
  const identities = new Map<string, PeerIdentity>();
  // The machine that each environment id answered for, at any of its addresses.
  const machineOfEnvironment = new Map<EnvironmentId, MachineId>();
  // The links of the last look outside a pause. A pause sets every arrow to `none` and keeps the
  // levels only in the portal, so these say which links the pause holds (MM-1914).
  let lastLinks: ReadonlyArray<ArrowLink> = [];
  const firstSeen = new Map<EnvironmentId, DateTime.Utc>();
  const outcomes = new Map<
    EnvironmentId,
    { readonly lastReachedAt: DateTime.Utc | null; readonly lastError: string | null }
  >();

  /**
   * The desired state and token while this machine is on the map, else undefined. Each lookup
   * reads it once, so one call never sees two maps.
   */
  const onMap = state.snapshot.pipe(
    Effect.map((local) => {
      const desired = local.enabled ? local.saved.desired : null;
      return desired === null || local.token === null ? undefined : { desired, token: local.token };
    }),
  );

  const pair = Effect.fn("MachinePeers.pair")(function* (
    machine: PeerMachine,
    origin: string,
    token: MachineMapState.MachineToken,
    selfName: string,
  ) {
    const headers = MachineMapState.tokenHeaders(token);
    const credential = yield* HttpClientRequest.post(
      `${origin}/api/auth/cloudflare-access/pairing-credential`,
    ).pipe(
      HttpClientRequest.setHeaders(headers),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthPairingCredentialResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const exchanged = yield* HttpClientRequest.post(`${origin}/oauth/token`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: `machine ${selfName}`,
        client_device_type: "bot",
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AuthAccessTokenResult)),
      Effect.timeout(REQUEST_TIMEOUT),
    );
    const session: PeerSession = {
      accessToken: exchanged.access_token,
      scopes: exchanged.scope.split(" ").filter((scope) => scope.length > 0),
    };
    sessions.set(origin, session);
    return session;
  });

  const identityOf = Effect.fn("MachinePeers.identityOf")(function* (
    target: ArrowLinkTarget,
    token: MachineMapState.MachineToken,
  ) {
    const descriptor = yield* HttpClientRequest.get(
      `${target.origin}/.well-known/t3/environment`,
    ).pipe(
      HttpClientRequest.setHeaders(MachineMapState.tokenHeaders(token)),
      httpClient.execute,
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
    identities.set(target.origin, identity);
    machineOfEnvironment.set(identity.environmentId, target.machine.id);
    return identity;
  });

  /**
   * The arrow links now. `refresh` asks each machine for its environment id again. `unknown`
   * counts the machines that did not answer and have no known environment id.
   */
  const arrowLinks = Effect.fn("MachinePeers.arrowLinks")(function* (
    local: Effect.Success<typeof onMap>,
    refresh: boolean,
  ) {
    if (local === undefined) return { links: [], unknown: 0, paused: false };
    if (local.desired.paused === true) return { links: lastLinks, unknown: 0, paused: true };
    const nowMs = yield* Clock.currentTimeMillis;
    const looked = yield* Effect.forEach(
      arrowLinkTargets(local.desired, nowMs),
      (target) => {
        const cached = identities.get(target.origin);
        const probe =
          cached !== undefined && !refresh
            ? Effect.succeed(Option.some(cached))
            : identityOf(target, local.token).pipe(Effect.option);
        return probe.pipe(
          Effect.map((found) => {
            const identity = Option.getOrUndefined(found) ?? cached;
            return identity === undefined
              ? undefined
              : ({ ...identity, target, answered: Option.isSome(found) } satisfies ArrowLink);
          }),
        );
      },
      { concurrency: "unbounded" },
    );
    const links = looked.filter((link) => link !== undefined);
    lastLinks = links;
    return { links, unknown: looked.length - links.length, paused: false };
  });

  const toPeerLink = Effect.fn("MachinePeers.toPeerLink")(function* (link: ArrowLink) {
    const now = yield* DateTime.now;
    const linkedAt = firstSeen.get(link.environmentId) ?? now;
    firstSeen.set(link.environmentId, linkedAt);
    const outcome = outcomes.get(link.environmentId);
    return {
      environmentId: link.environmentId,
      label: link.target.machine.name,
      urls: [link.target.origin],
      access: link.target.access,
      linkedAt,
      expiresAt:
        link.target.endsAtMs === null ? NO_EXPIRY : DateTime.makeUnsafe(link.target.endsAtMs),
      lastReachedAt: outcome?.lastReachedAt ?? null,
      lastError: outcome?.lastError ?? null,
    } satisfies PeerLink;
  });

  const findLink = Effect.fn("MachinePeers.findLink")(function* (
    local: Effect.Success<typeof onMap>,
    environmentId: EnvironmentId,
  ) {
    const cached = yield* arrowLinks(local, false);
    const found = cached.links.find((link) => link.environmentId === environmentId);
    if (found !== undefined || cached.paused) return { ...cached, found };
    const fresh = yield* arrowLinks(local, true);
    return {
      ...fresh,
      found: fresh.links.find((link) => link.environmentId === environmentId),
    };
  });

  const manualRefused = Effect.fail(
    new PeerLinkError({ reason: "incompatible", message: MANUAL_LINK_REFUSAL }),
  );

  const linkError = (reason: PeerLinkError["reason"], message: string) =>
    new PeerLinkError({ reason, message });

  const peerLinks = PeerLinks.PeerLinks.of({
    link: () => manualRefused,
    unlink: () => manualRefused,
    list: Effect.gen(function* () {
      const looked = yield* arrowLinks(yield* onMap, true);
      return yield* Effect.forEach(looked.links, (link) =>
        toPeerLink(link).pipe(
          Effect.map((peerLink): PeerLinkSummary => ({
            ...peerLink,
            status: !looked.paused && link.answered ? "reachable" : "unreachable",
            lastError: looked.paused ? "The machine map is paused." : peerLink.lastError,
          })),
        ),
      );
    }).pipe(Effect.withSpan("MachinePeers.listLinks")),
    get: (environmentId) =>
      onMap.pipe(
        Effect.flatMap((local) => findLink(local, environmentId)),
        Effect.flatMap(({ found }) =>
          found === undefined ? Effect.succeedNone : Effect.map(toPeerLink(found), Option.some),
        ),
      ),
    resolve: Effect.fn("MachinePeers.resolveLink")(function* (environmentId) {
      // MM-1904: a session of another machine never lends it the arrows of this machine.
      const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
      if (Option.isSome(scope) && isMachineRequestNamespace(scope.value.requestNamespace)) {
        return yield* linkError(
          "incompatible",
          "Work from another machine cannot use the arrows of this machine.",
        );
      }
      const local = yield* onMap;
      if (local === undefined) {
        return yield* linkError(
          "unknown_link",
          "This machine is not on the machine map, so it reaches no other machine.",
        );
      }
      const looked = yield* findLink(local, environmentId);
      // MM-1914: the pause holds the work. Resume lets it go on.
      if (looked.paused) {
        return yield* linkError(
          "unreachable",
          "The machine map is paused. Work on other machines waits until the owner resumes it in the portal.",
        );
      }
      if (looked.found === undefined) {
        // A machine that answered as this id before is unknown once it has no arrow, and only
        // offline while it keeps one, also at a new hostname. Known limit: an id that never
        // answered, while a machine with an arrow is offline and was never reached, reads as
        // unreachable, so its work retries instead of failing. Revisit if the portal gives each
        // machine its environment id.
        const machine = machineOfEnvironment.get(environmentId);
        const arrowed =
          machine !== undefined &&
          arrowLinkTargets(local.desired, yield* Clock.currentTimeMillis).some(
            (target) => target.machine.id === machine,
          );
        return yield* arrowed || (machine === undefined && looked.unknown > 0)
          ? linkError(
              "unreachable",
              `No machine with an arrow from this one answers as ${environmentId} now. A machine may be offline.`,
            )
          : linkError(
              "unknown_link",
              `No arrow with agent tools from this machine reaches ${environmentId}. Set the arrow in the portal.`,
            );
      }
      const { target } = looked.found;
      // The session goes only to an address that answers as this peer now, with the limits held
      // (upstream `PeerLinks.resolve` probes the same way), so a moved hostname or a peer that went
      // back to an older version never gets it.
      const now = yield* identityOf(target, local.token).pipe(Effect.option);
      if (Option.isNone(now) || now.value.environmentId !== environmentId) {
        return yield* linkError(
          "unreachable",
          `${target.machine.name} does not answer as ${environmentId} at ${target.origin} now.`,
        );
      }
      if (!now.value.holdsLimits) {
        return yield* linkError(
          "incompatible",
          `${target.machine.name} runs a T3 Code version that cannot keep the limits of an agent from another machine. Update it.`,
        );
      }
      const session =
        sessions.get(target.origin) ??
        (yield* pair(target.machine, target.origin, local.token, local.desired.self.name).pipe(
          Effect.mapError((cause) => {
            const detail = describeFailure(cause);
            // A refusal: the peer may not have the new arrow yet. Both kinds try again.
            return detail === "HTTP 401" || detail === "HTTP 403"
              ? linkError(
                  "pairing_rejected",
                  `${target.machine.name} refused the pairing: ${detail}.`,
                )
              : linkError("unreachable", `${target.machine.name} did not answer: ${detail}.`);
          }),
        ));
      return {
        link: yield* toPeerLink(looked.found),
        url: target.origin,
        token: session.accessToken,
      };
    }),
    recordOutcome: (environmentId, outcome) =>
      DateTime.now.pipe(
        Effect.map((now) => {
          const previous = outcomes.get(environmentId);
          outcomes.set(
            environmentId,
            outcome.error === null
              ? { lastReachedAt: now, lastError: null }
              : { lastReachedAt: previous?.lastReachedAt ?? null, lastError: outcome.error },
          );
        }),
      ),
  });

  /**
   * The client of `PeerMcpClient`. Each request to a linked machine carries the machine token
   * for Cloudflare Access and the current session. The peer ends the sessions of this machine on
   * every level change (MM-1306), and upstream reads a 401 as a revoked link, so a 401 pairs
   * again once and sends the request again. When the peer still refuses, its arrow changed before
   * this machine saw the change: that fails as a dropped route, which delegation retries, and the
   * next lookup reads the reason from this machine's map (MM-1914).
   */
  const linkHttpClient = HttpClient.transform(httpClient, (_unchanged, request) =>
    Effect.gen(function* () {
      const link = lastLinks.find((candidate) =>
        request.url.startsWith(`${candidate.target.origin}/`),
      );
      const local = yield* onMap;
      // Only a linked machine gets the machine token; anything else goes as it is.
      if (link === undefined || local === undefined) return yield* httpClient.execute(request);
      const { machine, origin } = link.target;
      const send = (session: PeerSession | undefined) =>
        httpClient.execute(
          HttpClientRequest.setHeaders(request, {
            ...MachineMapState.tokenHeaders(local.token),
            ...(session === undefined ? {} : { authorization: `Bearer ${session.accessToken}` }),
          }),
        );
      const response = yield* send(sessions.get(origin));
      if (response.status !== 401) return response;
      sessions.delete(origin);
      const refused = (description: string) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description }),
        });
      const renewed = yield* pair(machine, origin, local.token, local.desired.self.name).pipe(
        Effect.mapError((cause) =>
          refused(`${machine.name} refused to pair again: ${describeFailure(cause)}`),
        ),
      );
      const again = yield* send(renewed);
      return again.status === 401
        ? yield* refused(`${machine.name} refused this machine after it paired again`)
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

  /** A peer of the map by id or name, with the arrow from this machine to it. */
  const resolvePeer = Effect.fn("MachinePeers.resolvePeer")(function* (machine: string) {
    const local = yield* onMap;
    if (local === undefined) {
      return yield* new MachinePeerError({
        reason: "not-on-map",
        detail: "This machine is not on the machine map. Join it first.",
      });
    }
    const { desired } = local;
    const wanted = machine.trim().toLowerCase();
    const peer = desired.peers.find(
      (candidate) => candidate.id === machine || candidate.name.toLowerCase() === wanted,
    );
    if (peer === undefined || peer.id === desired.self.id) {
      return yield* new MachinePeerError({
        reason: "unknown-machine",
        detail: `No other machine named "${machine}" is on the map.`,
      });
    }
    if (peer.hostname === null) {
      return yield* new MachinePeerError({
        reason: "no-hostname",
        detail: `${peer.name} has not reported its tunnel hostname yet.`,
        target: peer.id,
      });
    }
    const arrow = desired.arrowsOut.find(
      (candidate) => candidate.from === desired.self.id && candidate.to === peer.id,
    );
    return { peer, origin: `https://${peer.hostname}`, arrow, local };
  });

  const testArrow: MachinePeers["Service"]["testArrow"] = Effect.fn("MachinePeers.testArrow")(
    function* (to) {
      const resolved = yield* resolvePeer(to);
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* pair(
        resolved.peer,
        resolved.origin,
        resolved.local.token,
        resolved.local.desired.self.name,
      ).pipe(
        Effect.flatMap((session) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => ({
              to,
              reachable: true,
              roundTripMs: endedAt - startedAt,
              scopes: session.scopes,
              error: null,
            })),
          ),
        ),
        Effect.catch((cause) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((endedAt): ArrowTestResult => {
              const detail = describeFailure(cause);
              // Access answers 403 and the peer answers 401 when the arrow grants nothing.
              const refused = detail === "HTTP 401" || detail === "HTTP 403";
              return {
                to,
                reachable: refused,
                roundTripMs: refused ? endedAt - startedAt : null,
                scopes: [],
                error: refused ? `${detail}: the arrow grants no access` : detail,
              };
            }),
          ),
        ),
      );
    },
    (effect, to) =>
      effect.pipe(
        Effect.catchTags({
          MachinePeerError: (error) =>
            Effect.succeed({
              to,
              reachable: false,
              roundTripMs: null,
              scopes: [],
              error: error.detail,
            } satisfies ArrowTestResult),
        }),
      ),
  );

  /** MM-1908: the checks of this machine before a command goes to a peer. */
  const admitExec = Effect.fn("MachinePeers.admitExec")(function* (machine: string) {
    // The peer is resolved first, so a refused call names its target for the History.
    const resolved = yield* resolvePeer(machine);
    const refused = (reason: MachinePeerError["reason"], detail: string) =>
      new MachinePeerError({ reason, detail, target: resolved.peer.id });
    // One read of the caller: its limits go out with the call (`T3-Mode-Limit`), and the target
    // refuses exec for limits below full-access/default.
    const { limits } = yield* requireMachineExecCaller().pipe(
      Effect.mapError((failure) => refused("caller-refused", failure.message)),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    if (resolved.arrow === undefined || !arrowAllowsExec(resolved.arrow, nowMs)) {
      return yield* refused(
        "no-exec",
        `The arrow from this machine to ${resolved.peer.name} does not allow exec. It needs exec, agent tools and the level standard or admin. The owner can turn exec on in the machine map.`,
      );
    }
    const link = (yield* arrowLinks(resolved.local, false)).links.find(
      (candidate) => candidate.target.machine.id === resolved.peer.id,
    );
    if (link === undefined) {
      return yield* refused("unreachable", `${resolved.peer.name} does not answer now.`);
    }
    // MM-806: the portal names the calling thread. An agent cannot set it through this path.
    const caller = yield* historyCaller();
    return { resolved, refused, limits, link, caller };
  });

  const exec: MachinePeers["Service"]["exec"] = Effect.fn("MachinePeers.exec")(function* (input) {
    const { resolved, limits, link, caller } = yield* admitExec(input.machine);
    const { caller: _ignored, ...command } = input;
    return yield* peerMcp.call({
      environmentId: link.environmentId,
      tool: "machine_exec",
      arguments: { ...command, machine: resolved.peer.id, caller },
      limits,
      success: MachineExecResult,
    });
  });

  const openExec: MachinePeers["Service"]["openExec"] = Effect.fn("MachinePeers.openExec")(
    function* (input) {
      const { resolved, refused, limits, link, caller } = yield* admitExec(input.machine);
      // The same session, Access headers and limits as a forwarded tool call (`linkHttpClient`).
      const open = peerLinks.resolve(link.environmentId).pipe(
        Effect.flatMap((target) =>
          openExecSocket(streamUrl(target.url, MACHINE_EXEC_STREAM_PATH), {
            ...MachineMapState.tokenHeaders(resolved.local.token),
            authorization: `Bearer ${target.token}`,
            [McpInvocationContext.MODE_LIMIT_HEADER]: `${limits.runtimeMode}/${limits.interactionMode}`,
          }),
        ),
      );
      // The peer ends the sessions of this machine on each level change (MM-1306), so a refused
      // upgrade pairs again once. An older peer without the route answers 404 and pairs no more.
      const socket = yield* open.pipe(
        Effect.catchIf(refusedUpgrade, () =>
          Effect.sync(() => sessions.delete(link.target.origin)).pipe(Effect.andThen(open)),
        ),
        Effect.mapError((cause) =>
          refused(
            "unreachable",
            `${resolved.peer.name} did not open the exec stream: ${cause.message} It may run a T3 Code version without \`t3 machine exec\`.`,
          ),
        ),
      );
      const { caller: _ignored, type: _start, ...command } = input;
      yield* socket
        .message({ type: "start", ...command, machine: resolved.peer.id, caller })
        .pipe(
          Effect.mapError((cause) =>
            refused(
              "unreachable",
              `${resolved.peer.name} closed the exec stream: ${cause.message}`,
            ),
          ),
        );
      return socket;
    },
  );

  const readableEnvironments: MachinePeers["Service"]["readableEnvironments"] = onMap.pipe(
    Effect.flatMap((local) => arrowLinks(local, false)),
    Effect.map(({ links, paused }) =>
      paused
        ? []
        : links.map((link) => ({
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
      testArrow,
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

/** `MachinePeers`, and upstream's `PeerLinks` and `PeerMcpClient` over the arrows (MM-1921). */
export const layer = Layer.effectContext(make);
