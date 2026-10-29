/**
 * Fork parts of `EnvironmentAuth`: the Cloudflare Access login and the machine map pause lock and
 * peer origins. `EnvironmentAuth.ts` keeps one-line hooks into this file.
 */
import {
  MACHINE_LEVEL_SCOPES,
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import { makeCloudflareAccessVerifier } from "../auth/CloudflareAccess.ts";
import type { ServerAuthInternalError } from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { CloudflareAccessConfig } from "../config.ts";
import { APP_RESOURCE_ID, type AccessVisitor, appLevelScopes } from "./kitshn/kitshnGrantRules.ts";
import { type KitshnGrants, KITSHN_SESSION_SUBJECT_PREFIX } from "./kitshn/KitshnGrants.ts";
import { type ClientPending, ownerBrowserAccess } from "./machineMap/browserAccess.ts";
import { isMachineSubject } from "./machineMap/machineAccess.ts";
import { CLOUDFLARE_ACCESS_LABEL_PREFIX } from "./forkSessions.ts";
import type * as MachineMapState from "./machineMap/MachineMapState.ts";

type MachineMap = Option.Option<MachineMapState.MachineMapState["Service"]>;
type Grants = Option.Option<KitshnGrants["Service"]>;

const visitorName = (visitor: AccessVisitor) => visitor.email ?? visitor.clientId ?? "visitor";

/** Fork: MM-718. A valid session that the machine map pause locks. */
export class ServerAuthMachinePausedError extends Schema.TaggedError<ServerAuthMachinePausedError>()(
  "ServerAuthMachinePausedError",
  {},
) {
  override get message(): string {
    return "The machine map pause locks this client.";
  }
}

/** Machine map (MM-718): fails a session that the pause locks. Absent outside the server. */
export const rejectWhilePaused =
  (machineMap: MachineMap) =>
  <S extends { readonly subject: string }>(session: S) =>
    Option.isNone(machineMap)
      ? Effect.succeed(session)
      : machineMap.value
          .lockedFor(session.subject)
          .pipe(
            Effect.flatMap((locked) =>
              locked ? Effect.fail(new ServerAuthMachinePausedError({})) : Effect.succeed(session),
            ),
          );

/** Machine map (MM-1311): the pages of peer machines are trusted like the explicit list. */
export const withPeerOrigins = (
  trustedOrigins: ReadonlySet<string>,
  machineMap: MachineMap,
): Pick<ReadonlySet<string>, "has"> => ({
  has: (origin) =>
    trustedOrigins.has(origin) ||
    (Option.isSome(machineMap) && machineMap.value.trustsPeerOrigin(origin)),
});

/**
 * A one-use pairing credential for a request that carries a valid Cloudflare Access JWT, or
 * undefined when the login is off or the JWT fails. It fails while the machine map pause locks
 * every Access subject (MM-718). `ClientPending` (MM-918): `enforce` refuses this browser until
 * the owner approves its key.
 */
export type IssueCloudflareAccessPairingCredential = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<
  AuthPairingCredentialResult | ClientPending | undefined,
  ServerAuthInternalError | ServerAuthMachinePausedError
>;

export const makeIssueCloudflareAccessPairingCredential = (input: {
  readonly cloudflareAccess: CloudflareAccessConfig | undefined;
  readonly machineMap: MachineMap;
  readonly kitshnGrants: Grants;
  readonly secretStore: ServerSecretStore.ServerSecretStore["Service"];
  readonly crypto: Crypto.Crypto;
  readonly issuePairingCredentialForSubject: (grant: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly label?: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
}): IssueCloudflareAccessPairingCredential => {
  const { machineMap, kitshnGrants, issuePairingCredentialForSubject } = input;
  const verifyCloudflareAccess =
    input.cloudflareAccess === undefined
      ? undefined
      : makeCloudflareAccessVerifier(input.cloudflareAccess);

  // MM-917, MM-918: see `ownerBrowserAccess`.
  const ownerBrowserAccessFor = (request: HttpServerRequest.HttpServerRequest, subject: string) =>
    ownerBrowserAccess(machineMap, request, subject).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, input.secretStore),
      Effect.provideService(Crypto.Crypto, input.crypto),
    );

  // K-706: the arrow of a map machine stays; any other visitor gets its `t3.app` level, or nothing.
  const kitshnCredential = Effect.fn("EnvironmentAuth.kitshnCredential")(function* (
    grants: KitshnGrants["Service"],
    visitor: AccessVisitor,
  ) {
    if (visitor.clientId !== null && Option.isSome(machineMap)) {
      const grant = yield* machineMap.value.machineGrant(visitor.clientId);
      if (grant !== undefined && isMachineSubject(grant.subject)) {
        return yield* issuePairingCredentialForSubject({ ...grant, ttl: Duration.minutes(2) });
      }
    }
    const level = yield* grants.level("t3.app", APP_RESOURCE_ID, visitor);
    if (level === null) return undefined;
    return yield* issuePairingCredentialForSubject({
      scopes: appLevelScopes(level),
      subject: `${KITSHN_SESSION_SUBJECT_PREFIX}${visitorName(visitor)}`,
      label: `kitshn ${visitorName(visitor)}`,
      ttl: Duration.minutes(2),
    });
  });

  const rejectWhileLocked = Option.isNone(machineMap)
    ? Effect.void
    : machineMap.value
        .lockedFor("one-time-token")
        .pipe(
          Effect.flatMap((locked) =>
            locked ? Effect.fail(new ServerAuthMachinePausedError({})) : Effect.void,
          ),
        );

  const kitshnVisitor = (request: HttpServerRequest.HttpServerRequest) =>
    Option.isNone(kitshnGrants) ? Effect.succeed(null) : kitshnGrants.value.visitor(request);

  return (request) =>
    kitshnVisitor(request).pipe(
      Effect.flatMap((visitor) =>
        visitor === null || Option.isNone(kitshnGrants)
          ? accessCredential(request)
          : rejectWhileLocked.pipe(
              Effect.andThen(kitshnCredential(kitshnGrants.value, visitor)),
              Effect.withSpan("EnvironmentAuth.issueKitshnPairingCredential"),
            ),
      ),
    );

  function accessCredential(request: HttpServerRequest.HttpServerRequest) {
    return verifyCloudflareAccess === undefined
      ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        Effect.succeed(undefined)
      : verifyCloudflareAccess(request).pipe(
          // MM-718: an Access subject is never the local desktop app, so the pause locks it.
          // A session made now would only be refused on its first use.
          Effect.tap((identity) => (identity === undefined ? Effect.void : rejectWhileLocked)),
          Effect.flatMap((identity) =>
            identity === undefined
              ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                Effect.succeed(undefined)
              : identity.kind === "owner"
                ? ownerBrowserAccessFor(request, identity.subject).pipe(
                    Effect.flatMap((access) =>
                      access._tag === "ClientPending"
                        ? Effect.succeed<ClientPending | AuthPairingCredentialResult>(access)
                        : issuePairingCredentialForSubject({
                            ...(access._tag === "client"
                              ? access.grant
                              : {
                                  // A Cloudflare Access cookie must not mint pairing links or relay
                                  // grants that outlive it (MM-922), so no upstream default here.
                                  scopes: MACHINE_LEVEL_SCOPES.standard,
                                  subject: "one-time-token",
                                  label: `${CLOUDFLARE_ACCESS_LABEL_PREFIX}${identity.subject}`,
                                }),
                            ttl: Duration.minutes(2),
                          }),
                    ),
                  )
                : Option.isNone(machineMap)
                  ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                    Effect.succeed(undefined)
                  : machineMap.value.machineGrant(identity.commonName).pipe(
                      Effect.flatMap((grant) =>
                        grant === undefined
                          ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                            Effect.succeed(undefined)
                          : issuePairingCredentialForSubject({
                              ...grant,
                              ttl: Duration.minutes(2),
                            }),
                      ),
                    ),
          ),
          Effect.withSpan("EnvironmentAuth.issueCloudflareAccessPairingCredential"),
        );
  }
};
