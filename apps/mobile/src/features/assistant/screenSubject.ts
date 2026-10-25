/**
 * Fork: what the screen under the assistant panel shows, from what Android reports about it.
 * App categories and window titles are not used: phones report them wrong or as class names.
 */
export type ScreenSubject =
  | {
      readonly type: "video";
      readonly app: string;
      readonly positionSeconds: number | null;
      readonly durationSeconds: number | null;
      readonly hasCaptions: boolean;
      /** A link that opens the video at the position, when the app reported one. */
      readonly linkAtPosition: string | null;
    }
  | { readonly type: "chat"; readonly app: string; readonly group: boolean }
  | { readonly type: "music"; readonly app: string; readonly title: string | null }
  | { readonly type: "page"; readonly host: string }
  | { readonly type: "home" }
  | { readonly type: "screen"; readonly app: string };

export interface ScreenReport {
  readonly appLabel: string | null;
  readonly sourcePackage: string | null;
  readonly activityClass: string | null;
  readonly webUri: string | null;
  /** JSON from the app. Android asks for schema.org JSON-LD; apps send their own keys too. */
  readonly structuredData: string | null;
  readonly clipMimeType: string | null;
  readonly clipLabel: string | null;
  readonly isHomeApp: boolean;
}

const VIDEO_HOSTS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "twitch.tv",
  "dailymotion.com",
  "tiktok.com",
];
const YOUTUBE_HOSTS = ["youtube.com", "youtu.be"];
const CHAT_HOSTS = ["t.me", "wa.me", "signal.me", "discord.com"];

/** "www.theverge.com" → "theverge.com", or null for a link that is not http(s). */
function webHost(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
  } catch {
    return null;
  }
}

const isOnHost = (host: string, hosts: ReadonlyArray<string>) =>
  hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { ...value }
      : null;
  } catch {
    return null;
  }
}

/** Seconds of an ISO 8601 duration such as "PT1H6M52.6S"; null when it is not one. */
export function isoDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !value.startsWith("PT")) return null;
  let seconds = 0;
  let number = "";
  for (const char of value.slice(2)) {
    if ((char >= "0" && char <= "9") || char === ".") {
      number += char;
      continue;
    }
    const amount = Number(number);
    if (number === "" || Number.isNaN(amount)) return null;
    if (char === "H") seconds += amount * 3600;
    else if (char === "M") seconds += amount * 60;
    else if (char === "S") seconds += amount;
    else return null;
    number = "";
  }
  return number === "" && value.length > 2 && Number.isFinite(seconds) ? seconds : null;
}

/** "6:52" or "1:06:52". */
export function clockTime(totalSeconds: number): string {
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** The first match wins: an app can send a link for a chat, so chats come before pages. */
export function screenSubject(report: ScreenReport): ScreenSubject {
  const app = report.appLabel ?? report.sourcePackage ?? "this app";
  const data = parseObject(report.structuredData);
  const host = webHost(report.webUri);
  const reportedId = data?.["@videoId"];
  const videoId = typeof reportedId === "string" && reportedId.trim() ? reportedId.trim() : null;
  if (videoId !== null || (host !== null && isOnHost(host, VIDEO_HOSTS))) {
    const positionSeconds = isoDurationSeconds(data?.["@videoTimeStamp"]);
    return {
      type: "video",
      app,
      positionSeconds,
      durationSeconds: isoDurationSeconds(data?.["@videoDuration"]),
      hasCaptions: data?.["@videoHasCaptions"] === true,
      linkAtPosition:
        // A video id alone does not say which site it belongs to.
        videoId !== null &&
        positionSeconds !== null &&
        host !== null &&
        isOnHost(host, YOUTUBE_HOSTS)
          ? `https://youtu.be/${encodeURIComponent(videoId)}?t=${Math.floor(positionSeconds)}`
          : null,
    };
  }
  const conversationType = data?.["conversation_type"];
  const activity = report.activityClass?.split(".").at(-1)?.toLowerCase() ?? "";
  if (
    typeof conversationType === "string" ||
    (host !== null && isOnHost(host, CHAT_HOSTS)) ||
    activity.includes("conversation") ||
    activity.includes("chat")
  ) {
    return { type: "chat", app, group: conversationType === "Group" };
  }
  if (report.clipMimeType?.startsWith("audio/")) {
    return { type: "music", app, title: report.clipLabel?.trim() || null };
  }
  if (host !== null) return { type: "page", host };
  if (report.isHomeApp) return { type: "home" };
  return { type: "screen", app };
}

/** The label of the screen text pill. */
export function screenSubjectLabel(subject: ScreenSubject): string {
  switch (subject.type) {
    case "video":
      return subject.positionSeconds === null
        ? `Video · ${subject.app}`
        : `Video · ${subject.app} · ${clockTime(subject.positionSeconds)}`;
    case "chat":
      return `${subject.group ? "Group chat" : "Chat"} · ${subject.app}`;
    case "music":
      return subject.title ? `Music · ${subject.title}` : `Music · ${subject.app}`;
    case "page":
      return `Page · ${subject.host}`;
    case "home":
      return "Home screen";
    case "screen":
      return `Screen · ${subject.app}`;
  }
}

/** The lines that head the screen text the agent gets. */
export function screenSubjectHeader(
  subject: ScreenSubject,
  report: Pick<ScreenReport, "appLabel" | "sourcePackage">,
): string {
  const app = [report.appLabel, report.sourcePackage ? `(${report.sourcePackage})` : null]
    .filter((part) => part !== null)
    .join(" ");
  const lines = [app ? `App: ${app}` : null, `Screen: ${screenSubjectLabel(subject)}`];
  if (subject.type === "video" && subject.positionSeconds !== null) {
    const of = subject.durationSeconds === null ? "" : ` of ${clockTime(subject.durationSeconds)}`;
    lines.push(
      `Video: at ${clockTime(subject.positionSeconds)}${of}${subject.hasCaptions ? ", captions available" : ""}`,
    );
  }
  return lines.filter((line) => line !== null).join("\n");
}
