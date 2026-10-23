import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { mcpAppFromToolItem } from "@t3tools/shared/toolOutput";

// Always on, no setting: a stored secret leaks to every client and copy of the thread.
// `token` is also the fragment key of the T3 pairing URL (packages/shared/src/remote.ts).
const SECRET_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "code",
  "key",
  "api_key",
  "apikey",
  "secret",
  "client_secret",
  "password",
  "pairing",
]);

const REDACTED = "REDACTED";

// Free text and JSON text put these characters around a URL.
const URL_TERMINATORS: ReadonlySet<string> = new Set(['"', "'", "`", "<", ">", "\\"]);

const isSchemeChar = (char: string) =>
  (char >= "a" && char <= "z") ||
  (char >= "A" && char <= "Z") ||
  (char >= "0" && char <= "9") ||
  char === "+" ||
  char === "-" ||
  char === ".";

const isUrlEnd = (char: string) => char.trim() === "" || URL_TERMINATORS.has(char);

// Sentence punctuation after a URL in prose belongs to the sentence.
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", ";", ":", "!", "?"]);
// A closing bracket belongs to the URL only when the URL opened it, as in `http://[::1]/`.
const BRACKET_PAIRS: ReadonlyMap<string, string> = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

const count = (text: string, char: string) => text.split(char).length - 1;

function belongsToSurroundingText(candidate: string): boolean {
  const last = candidate.at(-1)!;
  if (TRAILING_PUNCTUATION.has(last)) return true;
  const opener = BRACKET_PAIRS.get(last);
  return opener !== undefined && count(candidate, last) > count(candidate, opener);
}

const isSecretEntry = ([name, value]: [string, string]) =>
  value !== REDACTED && SECRET_KEYS.has(name.toLowerCase());

/** Returns the params text with secret values replaced, or undefined when none holds a secret. */
function redactParams(text: string): string | undefined {
  const entries = [...new URLSearchParams(text)];
  if (!entries.some(isSecretEntry)) return undefined;
  return new URLSearchParams(
    entries.map(([name, value]): [string, string] => [
      name,
      isSecretEntry([name, value]) ? REDACTED : value,
    ]),
  ).toString();
}

/** Plain anchors (`#section`) stay; `#a=b` and hash routes (`#/pair?a=b`) hold params. */
function redactFragment(fragment: string): string | undefined {
  const queryStart = fragment.indexOf("?");
  const route = queryStart >= 0 ? fragment.slice(0, queryStart) : fragment;
  // `#token=a&next=/p?x=1` is all params: the `?` sits inside a value.
  if (route.includes("=")) return redactParams(fragment);
  if (queryStart < 0) return undefined;
  const params = redactParams(fragment.slice(queryStart + 1));
  return params && `${route}?${params}`;
}

/** Hides credentials and secret query or fragment values. A string that is not a URL stays. */
export function redactUrlSecrets(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let changed = false;
  if (url.username !== "" && url.username !== REDACTED) {
    url.username = REDACTED;
    changed = true;
  }
  if (url.password !== "" && url.password !== REDACTED) {
    url.password = REDACTED;
    changed = true;
  }
  const search = redactParams(url.search);
  if (search !== undefined) {
    url.search = search;
    changed = true;
  }
  const fragment = redactFragment(url.hash.slice(1));
  if (fragment !== undefined) {
    url.hash = fragment;
    changed = true;
  }
  // Return the input untouched when nothing is secret, so parsing never reformats it.
  return changed ? url.href : value;
}

/** Applies {@link redactUrlSecrets} to every URL inside free text. */
export function redactUrlSecretsInText(text: string): string {
  let result = "";
  let copiedUpTo = 0;
  let marker = text.indexOf("://");
  while (marker >= 0) {
    let start = marker;
    while (start > copiedUpTo && isSchemeChar(text[start - 1]!)) start -= 1;
    let end = marker + 3;
    while (end < text.length && !isUrlEnd(text[end]!)) end += 1;
    while (end > marker + 3 && belongsToSurroundingText(text.slice(start, end))) end -= 1;
    if (start < marker) {
      const candidate = text.slice(start, end);
      const redacted = redactUrlSecrets(candidate);
      if (redacted !== candidate) {
        result += text.slice(copiedUpTo, start) + redacted;
        copiedUpTo = end;
      }
    }
    marker = text.indexOf("://", end);
  }
  return copiedUpTo === 0 ? text : result + text.slice(copiedUpTo);
}

/** Walks JSON-like data. Returns the same reference when nothing changed. */
export function redactUrlSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactUrlSecretsInText(value);
  if (Array.isArray(value)) {
    const next = value.map(redactUrlSecretsDeep);
    return next.some((entry, index) => entry !== value[index]) ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const redacted = redactUrlSecretsDeep(entry);
        if (redacted !== entry) changed = true;
        return [key, redacted];
      }),
    );
    return changed ? next : value;
  }
  return value;
}

/**
 * Tool calls and approval prompts carry agent-chosen URLs, such as a preview tab on a pairing
 * URL. Hide their secrets before the item is stored or sent to clients.
 */
export function redactTurnItemUrlSecrets(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "dynamic_tool":
      // An MCP app gets its call's stored input and output as live data, so keep them intact.
      if (mcpAppFromToolItem(item) !== undefined) return item;
      return {
        ...item,
        title: item.title === null ? null : redactUrlSecretsInText(item.title),
        input: redactUrlSecretsDeep(item.input),
        ...(item.output === undefined ? {} : { output: redactUrlSecretsDeep(item.output) }),
      };
    case "approval_request":
      return item.prompt === undefined
        ? item
        : { ...item, prompt: redactUrlSecretsInText(item.prompt) };
    default:
      return item;
  }
}
