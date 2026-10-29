/**
 * Fork parts of `EnvironmentAuth`: the kitshn Access login and the trusted peer origins. `EnvironmentAuth.ts` keeps one-line hooks into this file.
 */
import {
  type AuthEnvironmentScope,
  type AuthPairingCredentialResult,
  machineSessionSubject,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { ServerAuthInternalError } from "../auth/EnvironmentAuth.ts";
import { APP_RESOURCE_ID, type AccessVisitor, appLevelScopes } from "./kitshn/kitshnGrantRules.ts";
import { kitshnMachineOf } from "./kitshn/kitshnAgents.ts";
import { KitshnGrants, KITSHN_SESSION_SUBJECT_PREFIX } from "./kitshn/KitshnGrants.ts";

type Grants = Option.Option<KitshnGrants["Service"]>;

const visitorName = (visitor: AccessVisitor) => visitor.email ?? visitor.clientId ?? "visitor";

/** MM-1311: the pages of linked machines are trusted like the explicit list (K-1609). */
export const withPeerOrigins = (
  trustedOrigins: ReadonlySet<string>,
  grants: Grants,
): Pick<ReadonlySet<string>, "has"> => ({
  has: (origin) =>
    trustedOrigins.has(origin) || (Option.isSome(grants) && grants.value.trustsPeerOrigin(origin)),
});

/**
 * A one-use pairing credential for a request with a verified Access JWT whose visitor holds a
 * `t3.app` grant (K-706), or undefined. A machine's token gets the session `machine:<id>`; any
 * other visitor `kitshn:<email or token>`. Without kitshn 2 there is no Access login (K-712).
 */
export type IssueCloudflareAccessPairingCredential = (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<AuthPairingCredentialResult | undefined, ServerAuthInternalError>;

export const makeIssueCloudflareAccessPairingCredential = (input: {
  readonly kitshnGrants: Grants;
  readonly issuePairingCredentialForSubject: (grant: {
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly subject: string;
    readonly label?: string;
    readonly ttl: Duration.Duration;
  }) => Effect.Effect<AuthPairingCredentialResult, ServerAuthInternalError>;
}): IssueCloudflareAccessPairingCredential => {
  const { kitshnGrants, issuePairingCredentialForSubject } = input;

  const kitshnCredential = Effect.fn("EnvironmentAuth.kitshnCredential")(function* (
    grants: KitshnGrants["Service"],
    visitor: AccessVisitor,
  ) {
    const level = yield* grants.level("t3.app", APP_RESOURCE_ID, visitor);
    if (level === null) return undefined;
    const machineId = yield* kitshnMachineOf(visitor).pipe(
      Effect.provideService(KitshnGrants, grants),
    );
    return yield* issuePairingCredentialForSubject({
      scopes: appLevelScopes(level),
      ...(machineId === null
        ? {
            subject: `${KITSHN_SESSION_SUBJECT_PREFIX}${visitorName(visitor)}`,
            label: `kitshn ${visitorName(visitor)}`,
          }
        : { subject: machineSessionSubject(machineId), label: `machine ${machineId}` }),
      ttl: Duration.minutes(2),
    });
  });

  return (request) =>
    Option.isNone(kitshnGrants)
      ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        Effect.succeed(undefined)
      : kitshnGrants.value.visitor(request).pipe(
          Effect.flatMap((visitor) =>
            visitor === null
              ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                Effect.succeed(undefined)
              : kitshnCredential(kitshnGrants.value, visitor),
          ),
          Effect.withSpan("EnvironmentAuth.issueCloudflareAccessPairingCredential"),
        );
};
