import { assert, describe, it } from "@effect/vitest";

import {
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
