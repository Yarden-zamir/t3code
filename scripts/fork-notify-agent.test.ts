// @effect-diagnostics nodeBuiltinImport:off - plain Node test that runs a bash script against a local HTTP fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Fork: scripts/fork-notify-agent.sh posts a failed run to the repair agent webhook. The job
// must fail when nothing confirms the delivery, else the next failure stays quiet for 90 minutes.
const script = NodePath.join(import.meta.dirname, "fork-notify-agent.sh");

const serve = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(status, headers);
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ url: `http://127.0.0.1:${address.port}/api/hooks/x`, close: () => server.close() });
    });
  });

// A fake gh on PATH: the script asks it for the previous run, and "no previous run" is enough.
const fakeGhDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-notify-"));
  const gh = NodePath.join(dir, "gh");
  NodeFS.writeFileSync(gh, "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(gh, 0o755);
  return dir;
};

// The fixture server answers on this event loop, so the script runs asynchronously.
const run = (url: string) =>
  new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn("bash", [script], {
      env: {
        PATH: `${fakeGhDir()}:${process.env.PATH ?? ""}`,
        WEBHOOK_URL: url,
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
        GH_TOKEN: "x",
        NEEDS_JSON: '{"build":{"result":"failure"}}',
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REF_NAME: "main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_WORKFLOW: "Fork CI",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "1",
      },
      timeout: 20_000,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });

const withServer = async (
  status: number,
  body: string,
  headers: Record<string, string>,
  check: (result: { status: number | null; output: string }) => void,
) => {
  const server = await serve(status, body, headers);
  try {
    check(await run(server.url));
  } finally {
    server.close();
  }
};

describe("fork-notify-agent.sh", () => {
  it("fails on a redirect, which is Cloudflare Access refusing the service token", () =>
    withServer(
      302,
      "<html>302 Found</html>",
      { location: "https://example.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1" },
      (result) => {
        expect(result.status).toBe(1);
        expect(result.output).toContain("answered 302");
        expect(result.output).toContain(
          "https://example.cloudflareaccess.com/cdn-cgi/access/login/x",
        );
        expect(result.output).not.toContain("kid=1");
      },
    ));

  it("fails with its reason when the task is disabled and no Location header exists", () =>
    withServer(
      409,
      '{"error":"hook_disabled"}',
      { "content-type": "application/json" },
      (result) => {
        expect(result.status).toBe(1);
        expect(result.output).toContain("answered 409");
        expect(result.output).toContain("task is disabled");
        expect(result.output).toContain("hook_disabled");
      },
    ));

  it("fails on a 202 without a deliveryId", () =>
    withServer(202, "{}", { "content-type": "application/json" }, (result) => {
      expect(result.status).toBe(1);
      expect(result.output).toContain("answered 202, not 202 with a deliveryId");
    }));

  it("succeeds only on an accepted delivery", () =>
    withServer(202, '{"deliveryId":"d1"}', { "content-type": "application/json" }, (result) => {
      expect(result.status).toBe(0);
      expect(result.output).toContain("delivery d1");
    }));
});
