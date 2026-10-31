/**
 * Fork: the labels that T3 vouches for when the kitshn daemon asks who holds a thread token
 * (K-1752, protocol 2). Names are bare; the daemon adds the registered prefix `t3.`.
 */
import type { ForkThreadIdentity } from "@t3tools/contracts";

const VALUE_LIMIT = 256;

/** The labels of an active thread; kitshn keys its per-thread token cache by `thread.id`. */
export const attestedLabels = (
  identity: Extract<ForkThreadIdentity, { readonly active: true }>,
): Readonly<Record<string, string>> => {
  const labels: Record<string, string> = {
    "thread.id": identity.threadId,
    "thread.title": identity.threadTitle,
    "project.id": identity.projectId,
    "project.name": identity.projectName,
    "environment.id": identity.environmentId,
    provider: identity.providerInstanceId,
    runtime: identity.runtimeMode,
    interaction: identity.interactionMode,
    subagent: String(identity.subagent),
    "thread.parent": identity.parentThreadId ?? "",
    "thread.parent.environment": identity.parentEnvironmentId ?? "",
  };
  return Object.fromEntries(
    Object.entries(labels).map(([name, value]) => [name, value.slice(0, VALUE_LIMIT)]),
  );
};
