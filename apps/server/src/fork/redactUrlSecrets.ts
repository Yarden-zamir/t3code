import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

// Always on, no setting: a stored secret leaks to every client and copy of the thread.
// Only preview tool calls get this. Known limit: other tools keep secrets in stored URLs, because
// a change would show output that the tool never returned. Revisit when another tool leaks one.
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
const URL_TERMINATORS: ReadonlySet<string> = new Set(['"', "`", "<", ">", "\\"]);

const isSchemeChar = (char: string) =>
  (char >= "a" && char <= "z") ||
  (char >= "A" && char <= "Z") ||
  (char >= "0" && char <= "9") ||
  char === "+" ||
  char === "-" ||
  char === ".";

const isUrlEnd = (char: string) => char.trim() === "" || URL_TERMINATORS.has(char);

// Sentence punctuation after a URL in prose belongs to the sentence. A `'` can sit inside a
// URL, so only a trailing one ends it, as in `'http://x'`.
const TRAILING_PUNCTUATION: ReadonlySet<string> = new Set([".", ",", ";", ":", "!", "?", "'"]);
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

// A URL in text can run on into the text after it, as in `[a](http://a/?token=x),[b](…)`.
// Known limit: a secret value that holds a bracket keeps the part after it. Revisit if a
// real token format uses these characters.
function textAfterValue(value: string): string {
  const ends = [")", "]", "}", "(", "[", "{"]
    .map((char) => value.indexOf(char))
    .filter((index) => index >= 0);
  return ends.length === 0 ? "" : value.slice(Math.min(...ends));
}

const isSecretEntry = ([name, value]: [string, string]) =>
  value !== REDACTED && SECRET_KEYS.has(name.toLowerCase());

/**
 * Returns the params text with secret values replaced, or undefined when none holds a secret.
 * Other params keep their exact text, so text that runs on after a URL is not re-encoded.
 */
function redactParams(text: string): string | undefined {
  let changed = false;
  const pieces = (text.startsWith("?") ? text.slice(1) : text).split("&").map((piece) => {
    const [entry] = new URLSearchParams(piece);
    const valueStart = piece.indexOf("=") + 1;
    if (entry === undefined || valueStart === 0 || !isSecretEntry(entry)) return piece;
    const redacted = `${piece.slice(0, valueStart)}${REDACTED}${textAfterValue(piece.slice(valueStart))}`;
    if (redacted !== piece) changed = true;
    return redacted;
  });
  return changed ? pieces.join("&") : undefined;
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

const isLetter = (char: string) => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");

const schemeStart = (text: string, marker: number, floor: number) => {
  let start = marker;
  while (start > floor && isSchemeChar(text[start - 1]!)) start -= 1;
  // A scheme starts with a letter, so `1http` starts at `h` and `123` is no scheme.
  while (start < marker && !isLetter(text[start]!)) start += 1;
  return start;
};

/** Applies {@link redactUrlSecrets} to every URL inside free text. */
export function redactUrlSecretsInText(text: string): string {
  let result = "";
  let copiedUpTo = 0;
  let marker = text.indexOf("://");
  while (marker >= 0) {
    const start = schemeStart(text, marker, copiedUpTo);
    let end = marker + 3;
    while (end < text.length && !isUrlEnd(text[end]!)) end += 1;
    // Each URL gets its own pass, as in `[a](http://x),[b](http://y)`. Known limit: in
    // `http://a/?u=http://b&token=x` the token parses as part of `http://b` and stays.
    // Revisit if agents pass such unencoded nested URLs with secrets.
    const next = text.indexOf("://", marker + 3);
    // A `://` without a scheme, as in `?a=://b&token=x`, stays part of this URL.
    for (let later = next; later >= 0 && later < end; later = text.indexOf("://", later + 3)) {
      const laterStart = schemeStart(text, later, marker + 3);
      if (laterStart < later) {
        end = laterStart;
        break;
      }
    }
    while (end > marker + 3 && belongsToSurroundingText(text.slice(start, end))) end -= 1;
    if (start < marker) {
      const candidate = text.slice(start, end);
      const redacted = redactUrlSecrets(candidate);
      if (redacted !== candidate) {
        result += text.slice(copiedUpTo, start) + redacted;
        copiedUpTo = end;
      }
    }
    marker = next;
  }
  return copiedUpTo === 0 ? text : result + text.slice(copiedUpTo);
}

// URL fields of the preview tool inputs and results (packages/contracts/src/previewAutomation.ts).
const PREVIEW_URL_KEYS: ReadonlySet<string> = new Set(["url", "requestedUrl", "resolvedUrl"]);

/** `preview_*` and `t3_preview_*`, under any adapter's name for the T3 MCP server. */
function isPreviewTool(toolName: string): boolean {
  // Cheap check first: this runs for each stored update of every tool call.
  if (!toolName.includes("preview_")) return false;
  const id = resolveT3McpToolId(toolName);
  return id !== null && (id.startsWith("preview_") || id.startsWith("t3_preview_"));
}

/** A preview `url` input can be schemeless, such as `localhost:5173/pair#token=…`. */
function redactPreviewUrl(value: string): string {
  // Normalize first: `alice:pass@host` would otherwise parse with `alice:` as its scheme.
  let normalized: string;
  try {
    normalized = normalizePreviewUrl(value);
  } catch {
    return redactUrlSecrets(value);
  }
  const redacted = redactUrlSecrets(normalized);
  return redacted === normalized ? value : redacted;
}

/** Walks JSON-like data. Returns the same reference when nothing changed. */
function redactStrings(
  value: unknown,
  redactString: (text: string, key: string | undefined) => string,
  key?: string,
): unknown {
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) {
    const next = value.map((entry) => redactStrings(entry, redactString, key));
    return next.some((entry, index) => entry !== value[index]) ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const next = Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => {
        const redacted = redactStrings(entry, redactString, entryKey);
        if (redacted !== entry) changed = true;
        return [entryKey, redacted];
      }),
    );
    return changed ? next : value;
  }
  return value;
}

const redactInputUrl = (text: string, key: string | undefined) =>
  key !== undefined && PREVIEW_URL_KEYS.has(key) ? redactPreviewUrl(text) : text;

// Results also repeat URLs in text, such as MCP text content or page text.
const redactOutputText = (text: string, key: string | undefined) =>
  key !== undefined && PREVIEW_URL_KEYS.has(key)
    ? redactPreviewUrl(text)
    : redactUrlSecretsInText(text);

/**
 * Claude asks with `<tool name>: <input JSON>` when no SDK title is set, and cuts a long input.
 * So find the URL fields by their JSON key, which also works on cut JSON.
 */
function redactApprovalPrompt(prompt: string): string {
  const separator = prompt.indexOf(": ");
  if (separator < 0 || !isPreviewTool(prompt.slice(0, separator))) return prompt;
  let result = prompt;
  for (const key of PREVIEW_URL_KEYS) {
    const field = `"${key}":"`;
    for (let start = result.indexOf(field); start >= 0; start = result.indexOf(field, start)) {
      start += field.length;
      const quote = result.indexOf('"', start);
      const end = quote < 0 ? result.length : quote;
      const redacted = redactPreviewUrl(result.slice(start, end));
      result = result.slice(0, start) + redacted + result.slice(end);
    }
  }
  // The scan also covers URLs outside the URL fields, as in a `preview_evaluate` expression.
  return redactUrlSecretsInText(result);
}

/**
 * Hides URL secrets of preview tool calls before the item is stored or sent to clients, as when
 * an agent opens a pairing URL in a preview tab. The tab itself still opens the real URL.
 */
export function redactTurnItemUrlSecrets(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "dynamic_tool":
      if (item.toolName === null || !isPreviewTool(item.toolName)) return item;
      return {
        ...item,
        title: item.title === null ? null : redactUrlSecretsInText(item.title),
        input: redactStrings(item.input, redactInputUrl),
        ...(item.output === undefined
          ? {}
          : { output: redactStrings(item.output, redactOutputText) }),
      };
    case "approval_request": {
      const prompt = item.prompt === undefined ? undefined : redactApprovalPrompt(item.prompt);
      return prompt === item.prompt ? item : { ...item, prompt };
    }
    default:
      return item;
  }
}
