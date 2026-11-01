/**
 * Fork parts of `EnvironmentAuth`: the kitshn Access login and the trusted peer origins. `EnvironmentAuth.ts` keeps one-line hooks into this file.
 */
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  type AuthPairingCredentialResult,
  MACHINE_LEVEL_LINK_ACCESS,
  MachineId,
  machineSessionSubject,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { ServerAuthInternalError } from "../auth/EnvironmentAuth.ts";
import { APP_RESOURCE_ID, appLevelScopes, levelFor } from "./kitshn/kitshnGrantRules.ts";
import {
  type AccessVisitor,
  KitshnGrants,
  KITSHN_SESSION_SUBJECT_PREFIX,
} from "./kitshn/KitshnGrants.ts";

type Grants = Option.Option<KitshnGrants["Service"]>;

/** MM-1311: the pages of linked machines are trusted like the explicit list (K-1609). */
export const withPeerOrigins = (
  trustedOrigins: ReadonlySet<string>,
  grants: Grants,
): Pick<ReadonlySet<string>, "has"> => ({
  has: (origin) =>
    trustedOrigins.has(origin) || (Option.isSome(grants) && grants.value.trustsPeerOrigin(origin)),
});

/**
 * A one-use pairing credential for a request whose kitshn visitor holds a `t3.app` level (K-721),
 * or undefined. Another machine gets the session `machine:<id>`; a person or device
 * `kitshn:<type>:<id>`. Without kitshn 2 there is no Access login (K-712).
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
    visitor: AccessVisitor,
  ) {
    const level = levelFor("t3.app", APP_RESOURCE_ID, visitor.levels);
    if (level === null) return undefined;
    const { subject } = visitor;
    return yield* issuePairingCredentialForSubject({
      scopes: appLevelScopes(level),
      ...(subject.type === "machine"
        ? {
            subject: machineSessionSubject(MachineId.make(subject.id)),
            label: `machine ${subject.name}`,
          }
        : {
            subject: `${KITSHN_SESSION_SUBJECT_PREFIX}${subject.type}:${subject.id}`,
            label: `kitshn ${subject.name}`,
          }),
      ttl: Duration.minutes(2),
    });
  });

  return (request) =>
    Option.isNone(kitshnGrants)
      ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        Effect.succeed(undefined)
      : kitshnGrants.value.visitor(request).pipe(
          Effect.flatMap((result) =>
            result._tag === "visitor"
              ? kitshnCredential(result.visitor)
              : // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                Effect.succeed(undefined),
          ),
          Effect.withSpan("EnvironmentAuth.issueCloudflareAccessPairingCredential"),
        );
};

/**
 * MM-1307 on kitshn: the MCP client of another machine's session: its kitshn subject is that
 * machine, with the link access of its `t3.app` level (K-1609). Bearer tokens only.
 */
export const kitshnMachineMcpClient = Effect.fn("kitshnMachineMcpClient")(function* (
  request: HttpServerRequest.HttpServerRequest,
  session: {
    readonly subject: string;
    readonly method: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  },
) {
  const grants = yield* Effect.serviceOption(KitshnGrants);
  if (Option.isNone(grants) || session.method !== "bearer-access-token") return undefined;
  const result = yield* grants.value.visitor(request);
  if (result._tag !== "visitor" || result.visitor.subject.type !== "machine") return undefined;
  const machineId = MachineId.make(result.visitor.subject.id);
  if (session.subject !== machineSessionSubject(machineId)) return undefined;
  const app = levelFor("t3.app", APP_RESOURCE_ID, result.visitor.levels);
  if (app === null) return undefined;
  return {
    sessionId: machineSessionSubject(machineId),
    label: `machine ${result.visitor.subject.name}`,
    access: session.scopes.includes(AuthOrchestrationOperateScope)
      ? MACHINE_LEVEL_LINK_ACCESS[app]
      : ("read-only" as const),
    peerLink: true as const,
    machineId,
  };
});
