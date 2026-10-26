// MM-1215: reads and writes the values of `wrangler.jsonc`. It keeps the comments and changes only
// the value lines, so a JSON parser that drops comments does not fit.

/** A value that the README asks to replace before the first deploy. */
const NOT_SET = "REPLACE_";

export function readVars(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('"')) continue;
    const end = trimmed.indexOf('":');
    const rest = trimmed.slice(end + 2).trim();
    if (end < 1 || !rest.startsWith('"')) continue;
    const value = rest.slice(1, rest.indexOf('"', 1));
    vars.set(trimmed.slice(1, end), value);
  }
  return vars;
}

/** The host of the custom domain route: `"routes": [{ "pattern": "<host>", ... }]`. */
export function readRouteHost(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim().startsWith('"routes":'));
  const mark = '"pattern": "';
  const start = line?.indexOf(mark) ?? -1;
  if (line === undefined || start === -1) return undefined;
  const from = start + mark.length;
  return line.slice(from, line.indexOf('"', from));
}

export const isSet = (value: string | undefined): value is string =>
  value !== undefined && value !== "" && !value.startsWith(NOT_SET);

export function writeVar(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim().startsWith(`"${key}":`));
  if (index === -1) throw new Error(`wrangler.jsonc has no "${key}" line.`);
  const line = lines[index] ?? "";
  const indent = line.slice(0, line.length - line.trimStart().length);
  lines[index] = `${indent}"${key}": ${JSON.stringify(value)},`;
  return lines.join("\n");
}

export function writeRoute(text: string, host: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim().startsWith('"routes":'));
  if (index === -1) throw new Error('wrangler.jsonc has no "routes" line.');
  lines[index] = `  "routes": [{ "pattern": ${JSON.stringify(host)}, "custom_domain": true }],`;
  return lines.join("\n");
}
