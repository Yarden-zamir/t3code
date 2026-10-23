/**
 * Fork: reads the marks that the shell integration of a terminal thread prints (OSC 133) and the
 * bell from the output of a terminal. Pure, so the manager and the provider adapter each own
 * one parser and neither depends on the other.
 *
 * - `prompt`: the shell shows its prompt (OSC 133;A).
 * - `commandStart`: the shell runs a command (OSC 133;C).
 * - `commandEnd`: the command ended (OSC 133;D;<exit code>).
 * - `attention`: a bell, or an app notification (OSC 9, 99 or 777).
 *
 * Every other byte comes back as `text`, with the marks removed.
 */
export type ShellItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "prompt" }
  | { readonly type: "commandStart" }
  | { readonly type: "commandEnd"; readonly exitCode: number | null }
  | { readonly type: "attention" };

const ESC = "\u001b";
const BEL = "\u0007";
const OSC_START = `${ESC}]`;
const STRING_TERMINATOR = `${ESC}\\`;
/** An unfinished sequence longer than this is plain text. */
const MAX_PENDING_CHARS = 4_096;

function itemOfOsc(body: string): ShellItem | null {
  if (body === "133;A") return { type: "prompt" };
  if (body === "133;C") return { type: "commandStart" };
  if (body === "133;D" || body.startsWith("133;D;")) {
    const code = Number.parseInt(body.slice("133;D;".length), 10);
    return { type: "commandEnd", exitCode: Number.isInteger(code) ? code : null };
  }
  // OSC 9;4 is a progress report and OSC 9;9 a working directory report, not notifications.
  if (
    (body.startsWith("9;") && !body.startsWith("9;4;") && !body.startsWith("9;9;")) ||
    body.startsWith("99;") ||
    body.startsWith("777;notify;")
  ) {
    return { type: "attention" };
  }
  return null;
}

export function makeShellMarkParser() {
  // The start of a sequence that the last chunk did not finish.
  let pending = "";

  return {
    push(data: string): ReadonlyArray<ShellItem> {
      const whole = pending + data;
      // A trailing ESC may start a sequence in the next chunk.
      const trailing = whole.endsWith(ESC) ? ESC : "";
      const input = whole.slice(0, whole.length - trailing.length);
      pending = trailing;
      const items: Array<ShellItem> = [];
      let textStart = 0;
      let index = 0;
      const flushText = (end: number) => {
        if (end > textStart) items.push({ type: "text", text: input.slice(textStart, end) });
      };

      while (index < input.length) {
        const bell = input.indexOf(BEL, index);
        const osc = input.indexOf(OSC_START, index);
        if (bell !== -1 && (osc === -1 || bell < osc)) {
          flushText(bell);
          items.push({ type: "attention" });
          index = textStart = bell + 1;
          continue;
        }
        if (osc === -1) break;
        const bodyStart = osc + OSC_START.length;
        const bellEnd = input.indexOf(BEL, bodyStart);
        const stEnd = input.indexOf(STRING_TERMINATOR, bodyStart);
        const end = bellEnd === -1 ? stEnd : stEnd === -1 ? bellEnd : Math.min(bellEnd, stEnd);
        if (end === -1) {
          if (input.length - osc <= MAX_PENDING_CHARS) {
            flushText(osc);
            pending = input.slice(osc) + trailing;
            return items;
          }
          index = bodyStart;
          continue;
        }
        const item = itemOfOsc(input.slice(bodyStart, end));
        const next = end + (end === bellEnd ? BEL.length : STRING_TERMINATOR.length);
        if (item === null) {
          // Another sequence, such as a window title: its text stays and its BEL is no bell.
          index = next;
          continue;
        }
        flushText(osc);
        items.push(item);
        index = textStart = next;
      }
      flushText(input.length);
      return items;
    },
  };
}
