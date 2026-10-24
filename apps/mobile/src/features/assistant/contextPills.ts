/**
 * Fork: context pills of the Android assistant panel. Each pill is one piece of context from the
 * screen or the phone. A tap attaches or leaves it out; a hold opens it to read and edit.
 */
export type ImageContextPillKind = "screenshot" | "sharedImage" | "recentPhoto";
export type TextContextPillKind =
  | "sharedText"
  | "selection"
  | "screenText"
  | "link"
  | "location"
  | "clipboard";
export type ContextPillKind = ImageContextPillKind | TextContextPillKind;

/** What the user handed over on purpose comes first, then the screen, then the phone. */
export const CONTEXT_PILL_ORDER: ReadonlyArray<ContextPillKind> = [
  "sharedText",
  "sharedImage",
  "selection",
  "screenshot",
  "screenText",
  "link",
  "recentPhoto",
  "location",
  "clipboard",
];

const SELECTION_LABEL_LENGTH = 24;

export function isImageContextPill(kind: ContextPillKind): kind is ImageContextPillKind {
  return kind === "screenshot" || kind === "sharedImage" || kind === "recentPhoto";
}

function nonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function linkHost(link: string): string {
  try {
    return new URL(link).host || link;
  } catch {
    return link;
  }
}

function quotedLabel(value: string): string {
  const flat = value.split("\n").join(" ").trim();
  return flat.length > SELECTION_LABEL_LENGTH
    ? `“${flat.slice(0, SELECTION_LABEL_LENGTH).trimEnd()}…”`
    : `“${flat}”`;
}

export function contextPillLabel(kind: ContextPillKind, value: string): string {
  switch (kind) {
    case "screenshot":
      return "Screenshot";
    case "sharedImage":
      return "Shared image";
    case "recentPhoto":
      return "Recent photo";
    case "screenText":
      return `Screen text · ${nonEmptyLines(value)} lines`;
    case "sharedText":
    case "selection":
      return quotedLabel(value);
    case "link":
      return linkHost(value);
    case "location":
      return value.includes(" (") ? (value.split(" (")[0] ?? "Location") : "Location";
    case "clipboard":
      return "Clipboard";
  }
}

/** "Tel Aviv, Israel (32.08530, 34.78180, ±1200 m)", or the coordinates without a place name. */
export function locationText(location: {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyMeters: number;
  readonly place: string | null;
}): string {
  const coordinates = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}, ±${Math.round(location.accuracyMeters)} m`;
  return location.place ? `${location.place} (${coordinates})` : coordinates;
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The context that goes into the message body: short, so a file attachment would only hide it. */
export function inlineContextText(input: {
  readonly sharedText: string | null;
  readonly selection: string | null;
  readonly link: string | null;
  readonly location: string | null;
  readonly clipboard: string | null;
}): string {
  return [
    input.sharedText?.trim() ? `Shared text:\n${quote(input.sharedText)}` : null,
    input.link?.trim() ? `Link: ${input.link.trim()}` : null,
    input.selection?.trim() ? `Selected text:\n${quote(input.selection)}` : null,
    input.location?.trim() ? `Location: ${input.location.trim()}` : null,
    input.clipboard?.trim() ? `Clipboard:\n${quote(input.clipboard)}` : null,
  ]
    .filter((block) => block !== null)
    .join("\n\n");
}

/** The screen text file, headed by the app it came from. */
export function screenTextDocument(sourcePackage: string | null, text: string): string {
  return sourcePackage ? `App: ${sourcePackage}\n\n${text}` : text;
}

export function joinMessageText(userText: string, contextText: string): string {
  return [userText.trim(), contextText].filter((part) => part.length > 0).join("\n\n");
}
