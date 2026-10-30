/**
 * Fork: the session subjects and MCP namespaces of other machines, and the refusals of calls that
 * must not cross machines. kitshn grants decide what another machine may do (K-706, K-1609).
 */
import { MachineId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";

const MACHINE_SUBJECT_PREFIX = "machine:";
const CLIENT_SUBJECT_PREFIX = "client:";

export const isMachineSubject = (subject: string) => subject.startsWith(MACHINE_SUBJECT_PREFIX);

/** MM-922: the label of a pairing credential that a browser client got with its key (MM-917). */
const BROWSER_CLIENT_LABEL_PREFIX = "browser client ";

/**
 * MM-922: a session that a browser client got through Cloudflare Access with its key lasts 1 day.
 * Known limit: a stolen one works for up to 1 day. Revisit when browser sessions are key-bound.
 */
export const clientBrowserSessionTtl = (grant: {
  readonly subject: string;
  readonly label?: string | undefined;
}): Duration.Duration | undefined =>
  grant.subject.startsWith(CLIENT_SUBJECT_PREFIX) &&
  grant.label?.startsWith(BROWSER_CLIENT_LABEL_PREFIX) === true
    ? Duration.days(1)
    : undefined;

const MACHINE_REQUEST_NAMESPACE_PREFIX = "machine-session:";

/** MM-1902: forwarding must not grant a capability absent from the source credential. */
export const MACHINE_MCP_CAPABILITIES = ["orchestration", "worktree", "pull-requests"] as const;

/**
 * The MCP request namespace of a machine session. The machine tools refuse such callers, so an
 * agent on another machine cannot ask kitshn as this machine or use its links. It names the
 * source machine for `machine_exec` (MM-1908). The id is URI-encoded, so it holds no `:`.
 */
export const machineRequestNamespace = (client: {
  readonly machineId: MachineId;
  readonly sessionId: string;
}) =>
  `${MACHINE_REQUEST_NAMESPACE_PREFIX}${encodeURIComponent(client.machineId)}:${client.sessionId}`;

export const isMachineRequestNamespace = (requestNamespace: string) =>
  requestNamespace.startsWith(MACHINE_REQUEST_NAMESPACE_PREFIX);

/** The source machine of a machine session namespace, or undefined for any other namespace. */
export const machineOfRequestNamespace = (requestNamespace: string): MachineId | undefined => {
  if (!isMachineRequestNamespace(requestNamespace)) return undefined;
  const rest = requestNamespace.slice(MACHINE_REQUEST_NAMESPACE_PREFIX.length);
  const end = rest.indexOf(":");
  return end <= 0 ? undefined : MachineId.make(decodeURIComponent(rest.slice(0, end)));
};

/**
 * MM-1920: the label of the thread-less session that the `t3` CLI issues for the local user when
 * its shell has no thread credential. An OAuth client that names itself so is refused the same way.
 */
export const CLI_LOCAL_USER_LABEL = "CLI (local user)";

export const CLI_LOCAL_USER_REFUSAL =
  "Cross-machine calls need a thread credential: run them from an agent shell that has T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION. The local-user session of the t3 CLI has no thread, so no thread limits could go with the call.";

/** MM-1920: the local-user session of the CLI works on this machine only. */
export const isCliLocalUser = (scope: McpInvocationScope) =>
  scope.thread === undefined && scope.client?.label === CLI_LOCAL_USER_LABEL;

/** `McpSchema.EnabledWhen` of `t3_environment_link` and `t3_environment_unlink`: links come from kitshn. */
export const manualLinkToolsEnabled = (): boolean => false;

/** MM-1921: the answer to a manual link or unlink, from the CLI, Connections or an agent. */
export const MANUAL_LINK_REFUSAL =
  "Links to other machines come from kitshn. The owner shares a machine's T3 app card with this machine on the kitshn map.";

/** K-1609: why no link reaches a machine. */
export const NO_LINK =
  "No kitshn link from this machine reaches it. The owner shares the machine's T3 app card with this machine on the kitshn map.";
