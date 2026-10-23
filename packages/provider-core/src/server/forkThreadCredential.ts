import type { McpProviderSessionConfig } from "./mcpSession.ts";

/**
 * Fork (MM-1920): the names under which an agent shell finds its thread's MCP credential. They
 * are the names that provider-acp already sets and that `t3 tool call` and `t3 acp-mcp-call`
 * read. Without them, `t3 tool call` falls back to a full-access session with no thread.
 */
export const THREAD_CREDENTIAL_ENDPOINT_ENV = "T3_ACP_MCP_ENDPOINT";
export const THREAD_CREDENTIAL_AUTHORIZATION_ENV = "T3_ACP_MCP_AUTHORIZATION";

type ThreadCredential = Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">;

export function threadCredentialEnvironment(
  session: ThreadCredential | undefined,
): Readonly<Record<string, string>> {
  return session === undefined
    ? {}
    : {
        [THREAD_CREDENTIAL_ENDPOINT_ENV]: session.endpoint,
        [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: session.authorizationHeader,
      };
}

/**
 * Without a session it removes the names instead: a server that an agent shell started inherits
 * that agent's credential, and its own agents must not act as that other thread.
 */
export function withThreadCredential(
  environment: NodeJS.ProcessEnv,
  session: ThreadCredential | undefined,
): NodeJS.ProcessEnv {
  const {
    [THREAD_CREDENTIAL_ENDPOINT_ENV]: _endpoint,
    [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: _authorization,
    ...rest
  } = environment;
  return { ...rest, ...threadCredentialEnvironment(session) };
}
