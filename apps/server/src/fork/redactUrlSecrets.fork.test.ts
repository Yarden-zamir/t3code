import { assert, describe, it } from "@effect/vitest";
import {
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  redactTurnItemUrlSecrets,
  redactUrlSecrets,
  redactUrlSecretsInText,
} from "./redactUrlSecrets.ts";

// Fake values only.
describe("redactUrlSecrets", () => {
  it("hides known secret query values and keeps the others", () => {
    assert.strictEqual(
      redactUrlSecrets("https://example.test/cb?code=fake-code&state=s1&Access_Token=fake&page=2"),
      "https://example.test/cb?code=REDACTED&state=s1&Access_Token=REDACTED&page=2",
    );
  });

  it("hides the pairing token in the fragment", () => {
    assert.strictEqual(
      redactUrlSecrets("http://127.0.0.1:5733/pair#token=fake-dev-token"),
      "http://127.0.0.1:5733/pair#token=REDACTED",
    );
    assert.strictEqual(
      redactUrlSecrets("https://app.example.test/#/pair?key=fake&tab=1"),
      "https://app.example.test/#/pair?key=REDACTED&tab=1",
    );
    // The `?` sits inside a fragment value, not after a hash route.
    assert.notInclude(
      redactUrlSecrets("https://example.test/#token=fake&next=/page?tab=1"),
      "fake",
    );
  });

  it("keeps a plain anchor and a URL without secrets exactly as given", () => {
    assert.strictEqual(
      redactUrlSecrets("https://example.test#section"),
      "https://example.test#section",
    );
    assert.strictEqual(
      redactUrlSecrets("https://example.test?q=a%20b"),
      "https://example.test?q=a%20b",
    );
  });

  it("hides user and password credentials", () => {
    assert.strictEqual(
      redactUrlSecrets("https://alice:fake-pass@example.test/repo"),
      "https://REDACTED:REDACTED@example.test/repo",
    );
  });

  it("keeps strings that are not URLs", () => {
    assert.strictEqual(redactUrlSecrets("token=fake"), "token=fake");
    assert.strictEqual(redactUrlSecrets(""), "");
  });

  it("is stable on its own output", () => {
    const once = redactUrlSecrets("https://a:b@example.test/?token=fake#secret=fake");
    assert.strictEqual(redactUrlSecrets(once), once);
  });
});

describe("redactUrlSecretsInText", () => {
  it("keeps brackets and credential characters that belong to the URL", () => {
    assert.strictEqual(
      redactUrlSecretsInText("http://[::1]:5733/pair#token=fake"),
      "http://[::1]:5733/pair#token=REDACTED",
    );
    assert.notInclude(redactUrlSecretsInText("https://alice:fake)pass@example.test/"), "fake");
    assert.strictEqual(
      redactUrlSecretsInText("[pair](http://localhost/pair#token=fake)"),
      "[pair](http://localhost/pair#token=REDACTED)",
    );
    assert.strictEqual(
      redactUrlSecretsInText(
        "[docs](https://example.test),[pair](http://localhost/pair#token=fake)",
      ),
      "[docs](https://example.test),[pair](http://localhost/pair#token=REDACTED)",
    );
    const adjacent = redactUrlSecretsInText(
      "[a](https://example.test/?token=fake-one&safe=1),[b](http://example.test/pair?token=fake-two)",
    );
    assert.notInclude(adjacent, "fake-one");
    assert.notInclude(adjacent, "fake-two");
    assert.strictEqual(
      redactUrlSecretsInText(
        "[a](http://a/?token=fake-one&safe=://placeholder),[b](http://b/?token=fake-two)",
      ),
      "[a](http://a/?token=REDACTED&safe=://placeholder),[b](http://b/?token=REDACTED)",
    );
    for (const value of ["://placeholder", "123://placeholder"]) {
      assert.notInclude(
        redactUrlSecretsInText(`https://example.test/?safe=${value}&token=fake`),
        "fake",
      );
    }
  });

  it("keeps an apostrophe inside a URL and drops a closing one", () => {
    assert.strictEqual(
      redactUrlSecretsInText('{"url":"http://example.test/#token=fake\'token"}'),
      '{"url":"http://example.test/#token=REDACTED"}',
    );
    assert.notInclude(
      redactUrlSecretsInText('{"url":"https://alice:fake\'pass@example.test/"}'),
      "fake",
    );
    assert.strictEqual(
      redactUrlSecretsInText("open 'http://example.test/?token=fake' now"),
      "open 'http://example.test/?token=REDACTED' now",
    );
  });

  it("hides URLs inside prose and JSON text and keeps the text around them", () => {
    assert.strictEqual(
      redactUrlSecretsInText("Opened http://localhost:5733/pair#token=fake. Done"),
      "Opened http://localhost:5733/pair#token=REDACTED. Done",
    );
    assert.strictEqual(
      redactUrlSecretsInText('{"url":"http://localhost/x?token=fake","title":"T"}'),
      '{"url":"http://localhost/x?token=REDACTED","title":"T"}',
    );
  });
});

describe("redactTurnItemUrlSecrets", () => {
  const now = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
  const base = {
    id: TurnItemId.make("item:tool"),
    threadId: ThreadId.make("thread:tool"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;
  const toolItem = (
    toolName: string,
    input: unknown,
    output?: unknown,
  ): OrchestrationV2TurnItem => ({
    ...base,
    type: "dynamic_tool",
    toolName,
    input,
    ...(output === undefined ? {} : { output }),
  });

  it("hides URL fields and result text of preview tools under each adapter's tool name", () => {
    const item = redactTurnItemUrlSecrets(
      toolItem(
        "t3-code.preview_navigate",
        { target: { kind: "url", url: "localhost:5733/pair#token=fake-one" } },
        {
          content: [{ type: "text", text: '{"url":"http://localhost:5733/pair#token=fake-two"}' }],
        },
      ),
    );
    assert.notInclude(JSON.stringify(item), "fake-");
    const credentials = redactTurnItemUrlSecrets(
      toolItem("mcp__t3-code__preview_open", { url: "alice:fake-pass@example.test/?key=fake-key" }),
    );
    assert.notInclude(JSON.stringify(credentials), "fake");
    const listed = redactTurnItemUrlSecrets(
      toolItem("mcp__t3-code__t3_preview_list", {}, { tabs: [{ url: "http://x.test/?key=fake" }] }),
    );
    assert.notInclude(JSON.stringify(listed), "fake");
  });

  it("keeps the data of other tools", () => {
    const item = toolItem(
      "WebFetch",
      { url: "https://docs.test/?code=x" },
      "see https://docs.test/?code=x",
    );
    assert.strictEqual(redactTurnItemUrlSecrets(item), item);
  });

  it("hides a preview URL in an approval prompt only", () => {
    const approval = (prompt: string): OrchestrationV2TurnItem => ({
      ...base,
      type: "approval_request",
      requestId: RuntimeRequestId.make("request:tool"),
      requestKind: "command",
      prompt,
    });
    for (const url of ["http://h.test/pair#token=fake", "localhost:5733/pair#token=fake"]) {
      const preview = approval(`mcp__t3-code__preview_open: {"url":"${url}"}`);
      assert.notInclude(JSON.stringify(redactTurnItemUrlSecrets(preview)), "fake");
    }
    const other = approval('Bash: curl "https://api.test/?key=x"');
    assert.strictEqual(redactTurnItemUrlSecrets(other), other);
  });
});
