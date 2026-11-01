import {
  isCloudflareAccessChallenge,
  type OriginRequestHeaders,
  requestHeaderOrigin,
  requestHeadersError,
  requestHeadersForUrl,
} from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import * as Electron from "electron";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The main window uses the default session. The renderer cannot set headers
// on a WebSocket handshake, and custom headers on fetch trigger CORS
// preflights, so the main process adds them to every request instead.

const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));

let rules: ReadonlyArray<OriginRequestHeaders> = [];
// Origins whose last response was a Cloudflare Access login challenge.
const accessChallengedOrigins = new Set<string>();
// Preflights that this process answers, by webRequest id, with the response headers to send.
const answeredPreflights = new Map<number, Record<string, Array<string>>>();
let installed = false;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}

/**
 * The CORS response headers for a preflight that the app's own page sends to an origin with
 * request header rules, or null for any other request. Cloudflare Access refuses a preflight
 * unless the Access app passes OPTIONS through, even with the service token that this process
 * adds. The real request still goes to the server, and the server's CORS headers decide it.
 */
export function preflightAnswer(input: {
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly appOrigin: string;
  readonly rules: ReadonlyArray<OriginRequestHeaders>;
}): Record<string, Array<string>> | null {
  const requestedMethod = headerValue(input.requestHeaders, "access-control-request-method");
  if (
    input.method !== "OPTIONS" ||
    requestedMethod === null ||
    headerValue(input.requestHeaders, "origin") !== input.appOrigin ||
    requestHeadersForUrl(input.rules, input.url).length === 0
  ) {
    return null;
  }
  const requestedHeaders = headerValue(input.requestHeaders, "access-control-request-headers");
  return {
    "Access-Control-Allow-Origin": [input.appOrigin],
    "Access-Control-Allow-Methods": [requestedMethod],
    ...(requestedHeaders === null ? {} : { "Access-Control-Allow-Headers": [requestedHeaders] }),
    Vary: ["Origin"],
  };
}

function install(appOrigin: string): void {
  if (installed) return;
  installed = true;
  const webRequest = Electron.session.defaultSession.webRequest;
  webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = requestHeadersForUrl(rules, details.url);
    if (headers.length === 0) {
      callback({});
      return;
    }
    const answer = preflightAnswer({
      method: details.method,
      url: details.url,
      requestHeaders: details.requestHeaders,
      appOrigin,
      rules,
    });
    if (answer !== null) answeredPreflights.set(details.id, answer);
    const requestHeaders = { ...details.requestHeaders };
    for (const { name, value } of headers) requestHeaders[name] = value;
    callback({ requestHeaders });
  });
  webRequest.onHeadersReceived((details, callback) => {
    const answer = answeredPreflights.get(details.id);
    if (answer !== undefined) {
      answeredPreflights.delete(details.id);
      // A refused preflight says nothing about the token, so it sets no challenge.
      callback({ statusLine: "HTTP/1.1 204 No Content", responseHeaders: answer });
      return;
    }
    const origin = requestHeaderOrigin(details.url);
    if (origin !== null) {
      if (isCloudflareAccessChallenge(details.statusCode, details.responseHeaders ?? {})) {
        accessChallengedOrigins.add(origin);
      } else {
        accessChallengedOrigins.delete(origin);
      }
    }
    callback({});
  });
  webRequest.onErrorOccurred((details) => {
    answeredPreflights.delete(details.id);
  });
}

/**
 * Replaces the header rules with the ones in a raw connection catalog. A catalog that does not
 * decode clears them. Returns the origins whose rules were invalid and skipped. Never returns or
 * logs header values. Only preflights from `appOrigin`, the app's own page, get an answer.
 */
export function applyConnectionCatalog(
  raw: string | null,
  appOrigin: string,
): ReadonlyArray<string> {
  install(appOrigin);
  const document = raw === null ? Option.none() : decodeCatalog(raw);
  const all = Option.match(document, {
    onNone: () => [],
    onSome: (value) => value.requestHeaders,
  });
  const skipped: string[] = [];
  rules = all.filter((rule) => {
    const valid =
      requestHeaderOrigin(rule.origin) === rule.origin &&
      requestHeadersError(rule.headers) === null;
    if (!valid) skipped.push(rule.origin);
    return valid;
  });
  return skipped;
}

/** True when the last response from the origin of `url` was a Cloudflare Access challenge. */
export function isCloudflareAccessChallenged(url: string): boolean {
  const origin = requestHeaderOrigin(url);
  return origin !== null && accessChallengedOrigins.has(origin);
}
