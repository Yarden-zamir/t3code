import type { McpProviderSessionConfig } from "./mcpSession.ts";

/**
 * Fork (MM-1920): the names under which an agent shell finds its thread's MCP credential. They
 * are the names that provider-acp already sets and that `t3 tool call` and `t3 acp-mcp-call`
 * read. Without them, `t3 tool call` falls back to a full-access session with no thread.
 */
export const THREAD_CREDENTIAL_ENDPOINT_ENV = "T3_ACP_MCP_ENDPOINT";
export const THREAD_CREDENTIAL_AUTHORIZATION_ENV = "T3_ACP_MCP_AUTHORIZATION";
/** kitshn K-1752: `t3:<thread token>`, which kitshn commands send for the daemon to attest. */
export const KITSHN_ATTEST_ENV = "KITSHN_ATTEST";
const BEARER = "Bearer ";

/** Blanks the names in a child whose environment extends the server's; every reader skips "". */
export const NO_THREAD_CREDENTIAL = {
  [THREAD_CREDENTIAL_ENDPOINT_ENV]: "",
  [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: "",
  [KITSHN_ATTEST_ENV]: "",
} as const;

type ThreadCredential = Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader">;

export function threadCredentialEnvironment(
  session: ThreadCredential | undefined,
): Readonly<Record<string, string>> {
  return session === undefined
    ? {}
    : {
        [THREAD_CREDENTIAL_ENDPOINT_ENV]: session.endpoint,
        [THREAD_CREDENTIAL_AUTHORIZATION_ENV]: session.authorizationHeader,
        // "" when there is no bearer token, so an inherited attestation never applies.
        [KITSHN_ATTEST_ENV]: session.authorizationHeader.startsWith(BEARER)
          ? `t3:${session.authorizationHeader.slice(BEARER.length)}`
          : "",
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
    [KITSHN_ATTEST_ENV]: _attest,
    ...rest
  } = environment;
  return { ...rest, ...threadCredentialEnvironment(session) };
}
