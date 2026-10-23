import { assert, describe, it } from "@effect/vitest";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  redactTurnItemUrlSecrets,
  redactUrlSecrets,
  redactUrlSecretsDeep,
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
    const afterSchemeless = redactUrlSecretsInText(
      "[a](http://a/?token=fake-one&safe=://placeholder),[b](http://b/?token=fake-two)",
    );
    assert.notInclude(afterSchemeless, "fake-one");
    assert.notInclude(afterSchemeless, "fake-two");
    for (const value of ["://placeholder", "123://placeholder"]) {
      assert.notInclude(
        redactUrlSecretsInText(`https://example.test/?safe=${value}&token=fake`),
        "fake",
      );
    }
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

describe("redactUrlSecretsDeep", () => {
  it("returns the same reference when nothing changes", () => {
    const value = { url: "https://example.test/?page=1", list: ["plain"] };
    assert.strictEqual(redactUrlSecretsDeep(value), value);
  });
});

describe("redactTurnItemUrlSecrets", () => {
  const toolItem = (toolName: string, output: unknown): OrchestrationV2TurnItem => {
    const now = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
    return {
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
      type: "dynamic_tool",
      toolName,
      input: { url: "https://example.test/?token=fake" },
      output,
    };
  };

  it("keeps the data of an MCP app call, which the app gets as live input", () => {
    const item = toolItem("weather.get_weather", {
      t3McpApp: {
        attachmentId: "thread-1-abc-html",
        server: "weather",
        tool: "get_weather",
        resourceUri: "ui://weather/dashboard",
      },
    });
    assert.strictEqual(redactTurnItemUrlSecrets(item), item);
  });
});
