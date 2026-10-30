import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Fork: which thread holds an MCP credential, for kitshn's attestation (K-1752). It is the current
 * state of the thread, not the state when the credential was issued.
 */
export const ForkThreadIdentityActive = Schema.Struct({
  active: Schema.Literal(true),
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectId: ProjectId,
  projectName: Schema.String,
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  subagent: Schema.Boolean,
  parentThreadId: Schema.NullOr(ThreadId),
  /** Null when the parent thread is in this environment. */
  parentEnvironmentId: Schema.NullOr(EnvironmentId),
  checkedAt: IsoDateTime,
});

/** RFC 7662 shape: an unknown, revoked or idle credential gives no reason. */
export const ForkThreadIdentityInactive = Schema.Struct({ active: Schema.Literal(false) });

export const ForkThreadIdentity = Schema.Union([
  ForkThreadIdentityActive,
  ForkThreadIdentityInactive,
]);
export type ForkThreadIdentity = typeof ForkThreadIdentity.Type;
