import { assert, it } from "@effect/vitest";

import { threadCredentialEnvironment, withThreadCredential } from "./forkThreadCredential.ts";

const session = { endpoint: "http://127.0.0.1:43123/mcp", authorizationHeader: "Bearer thread-a" };

it("puts the thread credential in the shell environment and keeps the rest", () => {
  assert.deepStrictEqual(withThreadCredential({ PATH: "/usr/bin" }, session), {
    PATH: "/usr/bin",
    T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp",
    T3_ACP_MCP_AUTHORIZATION: "Bearer thread-a",
    KITSHN_ATTEST: "t3:thread-a",
  });
});

it("never passes on a credential that the server inherited from another thread", () => {
  const inherited = {
    PATH: "/usr/bin",
    T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:9999/mcp",
    T3_ACP_MCP_AUTHORIZATION: "Bearer outer-thread",
    KITSHN_ATTEST: "t3:outer-thread",
  };
  assert.deepStrictEqual(withThreadCredential(inherited, undefined), { PATH: "/usr/bin" });
  assert.strictEqual(
    withThreadCredential(inherited, session).T3_ACP_MCP_AUTHORIZATION,
    "Bearer thread-a",
  );
  // Callers that spread the result over the server environment must not keep its attestation.
  const noBearer = { ...session, authorizationHeader: "Basic thread-a" };
  assert.strictEqual({ ...inherited, ...threadCredentialEnvironment(noBearer) }.KITSHN_ATTEST, "");
});
