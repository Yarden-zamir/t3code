import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setRequestHeadersInCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});

describe("ConnectionCatalogDocument", () => {
  it("decodes stored request headers and reads a document without them as none", () => {
    const document = {
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    };
    expect(decodeCatalogDocument(document).requestHeaders).toEqual([]);

    const requestHeaders = [
      {
        origin: "https://remote.example.test",
        headers: [{ name: "CF-Access-Client-Id", value: "id" }],
      },
    ];
    const decoded = decodeCatalogDocument({ ...document, requestHeaders });

    expect(decoded.requestHeaders).toEqual(requestHeaders);
  });

  it("replaces and removes the request headers of one origin", () => {
    const origin = "https://remote.example.test";
    const other = { origin: "https://other.example.test", headers: [{ name: "X-A", value: "a" }] };
    const withOther = setRequestHeadersInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      other.origin,
      other.headers,
    );
    const first = setRequestHeadersInCatalog(withOther, origin, [{ name: "X-B", value: "1" }]);
    const second = setRequestHeadersInCatalog(first, origin, [{ name: "X-B", value: "2" }]);

    expect(second.requestHeaders).toEqual([
      other,
      { origin, headers: [{ name: "X-B", value: "2" }] },
    ]);
    expect(setRequestHeadersInCatalog(second, origin, []).requestHeaders).toEqual([other]);
  });

  it("forgets request headers with the last environment that uses their origin", () => {
    const headers = [{ name: "X-A", value: "a" }];
    const otherId = EnvironmentId.make("environment-2");
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const sharedOrigin = registerConnectionInCatalog(
      registered,
      new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          ...BEARER_TARGET,
          environmentId: otherId,
          connectionId: "bearer-2",
        }),
        profile: new BearerConnectionProfile({
          ...BEARER_PROFILE,
          environmentId: otherId,
          connectionId: "bearer-2",
        }),
        credential: BEARER_CREDENTIAL,
      }),
    );
    const document = setRequestHeadersInCatalog(
      setRequestHeadersInCatalog(sharedOrigin, "https://remote.example.test", headers),
      "https://unrelated.example.test",
      headers,
    );

    const afterFirst = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
    expect(afterFirst.requestHeaders.map((value) => value.origin)).toEqual([
      "https://remote.example.test",
      "https://unrelated.example.test",
    ]);
    expect(
      removeConnectionFromCatalog(afterFirst, otherId).requestHeaders.map((value) => value.origin),
    ).toEqual(["https://unrelated.example.test"]);
  });
});
