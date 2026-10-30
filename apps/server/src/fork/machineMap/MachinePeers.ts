/**
 * Fork: this server as a client of other machines through kitshn links (K-1609): a link to B holds
 * while the reach has B's `t3.app` card. Calls go through the daemon's link proxy, which adds this
 * machine's token. Upstream `PeerLinks` and `PeerMcpClient` run over the links. Commands on B go
 * through kitshn instead (`MachineExec`, K-722).
 */
import * as NodeModule from "node:module";

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
  MachineId,
  type PeerLink,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import type * as UndiciModule from "undici";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";
import type { ReachedCard } from "@kitshn/local";

import * as KitshnGrants from "../kitshn/KitshnGrants.ts";
import { PROVIDER_NAME } from "../kitshn/KitshnProvider.ts";
import * as KitshnProvider from "../kitshn/KitshnProvider.ts";
import {
  CLI_LOCAL_USER_REFUSAL,
  isCliLocalUser,
  isMachineRequestNamespace,
  MANUAL_LINK_REFUSAL,
  NO_LINK,
} from "./machineAccess.ts";

// undici is external to the CLI bundle; a Node single-executable loads it from disk only with require.
const Undici = NodeModule.createRequire(import.meta.url)("undici") as typeof UndiciModule;

// One dispatcher per proxy path: a Unix socket, or a named pipe on Windows.
const dispatchers = new Map<string, UndiciModule.Agent>();
const dispatcherFor = (socketPath: string) => {
  let agent = dispatchers.get(socketPath);
  if (agent === undefined) {
    agent = new Undici.Agent({ connect: { socketPath } });
    dispatchers.set(socketPath, agent);
  }
  return agent;
};

/**
 * A client that sends each request through a Unix socket or named pipe (the kitshn link proxy). It
 * calls undici with the dispatcher itself, so no `Fetch` or `RequestInit` from the fiber context can
 * replace it: in the desktop server, the context-based setup sent `http://link/...` to DNS.
 */
export const socketClient = (socketPath: string) =>
  HttpClient.make((request, url, signal) =>
    Effect.tryPromise({
      try: () =>
        Undici.fetch(url, {
          method: request.method,
          headers: request.headers,
          ...(request.body._tag === "Uint8Array" || request.body._tag === "Raw"
            ? { body: request.body.body as NonNullable<UndiciModule.RequestInit["body"]> }
            : {}),
          signal,
          dispatcher: dispatcherFor(socketPath),
        }),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(
      Effect.map((response) =>
        HttpClientResponse.fromWeb(request, response as unknown as globalThis.Response),
      ),
    ),
  );

const REQUEST_TIMEOUT = Duration.seconds(15);
// Short, as the probe of upstream `PeerLinks.resolve`: a linked machine answers its descriptor fast.
const DESCRIPTOR_TIMEOUT = Duration.seconds(5);
const NO_EXPIRY = DateTime.makeUnsafe(ARROW_LINK_NO_EXPIRY);

/**
 * K-1609, K-1610: the tool that a link call is for. The link proxy records it from the
 * `Kitshn-Audit-Name` header and drops the header; the call never names its arguments.
 */
export const KitshnAuditName = Context.Reference<string | undefined>(
  "t3/fork/machineMap/KitshnAuditName",
  { defaultValue: () => undefined },
);
const AUDIT_NAME_HEADER = "kitshn-audit-name";

/** A link call with the tool name that `KitshnAuditName` holds, if any. */
export const withAuditName = Effect.fnUntraced(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const name = yield* KitshnAuditName;
  return name === undefined
    ? request
    : HttpClientRequest.setHeader(request, AUDIT_NAME_HEADER, name);
});

interface PeerSession {
  readonly accessToken: string;
}

/** MM-1907: a machine whose threads this machine can read, for the `@` menu of its clients. */
export interface ReadableEnvironment {
  readonly environmentId: EnvironmentId;
  readonly machineId: MachineId;
  readonly name: string;
}

export class MachinePeers extends Context.Service<
  MachinePeers,
  {
    /** MM-1907: the linked machines that answer now, with their environment ids. */
    readonly readableEnvironments: Effect.Effect<ReadonlyArray<ReadableEnvironment>>;
    /** MM-1922: the machine that answered as this environment id, once a lookup reached it. */
    readonly machineOf: (environmentId: EnvironmentId) => MachineId | undefined;
  }
>()("t3/fork/machineMap/MachinePeers") {}

/** K-1609: one link from the reach: B's `t3.app` card. */
export interface LinkTarget {
  readonly machine: { readonly id: MachineId; readonly name: string };
  /** K-1609: the link proxy address of B, `/<provider>/<machine id>`, on the daemon's socket. */
  readonly origin: string;
  readonly access: AuthMcpClientAccess;
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

/** K-1609: the links of a reach: one per machine whose `t3.app` card this machine reaches. */
export const linkTargets = (reach: ReadonlyArray<ReachedCard>): ReadonlyArray<LinkTarget> =>
  reach.flatMap((card) => {
    const access = card.kind === "t3.app" ? LINK_ACCESS[card.level] : undefined;
    if (access === undefined) return [];
    return [
      {
        machine: { id: MachineId.make(card.machineId), name: card.machineName },
        origin: `http://link/${PROVIDER_NAME}/${encodeURIComponent(card.machineId)}`,
        access,
      },
    ];
  });

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

const describeFailure = (cause: unknown): string => {
  if (HttpClientError.isHttpClientError(cause)) {
    return cause.response === undefined ? cause.reason._tag : `HTTP ${cause.response.status}`;
  }
  return Predicate.isTagged(cause, "TimeoutError") ? "timed out" : "unexpected response";
};

const make = Effect.gen(function* () {
  const provider = yield* KitshnProvider.KitshnProvider;
  const grants = yield* KitshnGrants.KitshnGrants;
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

  /**
   * The reach and the link proxy now; no proxy (Windows for now) means no links, not an error. A
   * kitshn pause empties the reach (K-721).
   */
  const current = Effect.all([provider.state.pipe(Stream.runHead), provider.linkSocket]).pipe(
    Effect.map(([state, socket]) =>
      socket === null || Option.isNone(state)
        ? { targets: [] as ReadonlyArray<LinkTarget>, socket: null }
        : { targets: linkTargets(state.value.reach), socket },
    ),
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
          : withAuditName(request).pipe(Effect.flatMap(socketClient(socket).execute)),
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
