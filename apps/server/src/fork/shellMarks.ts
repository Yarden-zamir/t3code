/**
 * Fork: parses the OSC 133 marks of the terminal thread shell integration and the bell from
 * terminal output. Pure, so the manager and the provider adapter each own one parser. Kitty forms:
 * `continuation` is OSC 133;A;k=s and `commandStart` can carry cmdline=<text>. `attention` is a
 * bell or OSC 9, 99 or 777. Every other byte comes back as `text`, with the marks removed.
 */
export type ShellItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "prompt" }
  | { readonly type: "continuation" }
  | { readonly type: "commandStart"; readonly commandLine: string | null }
  | { readonly type: "commandEnd"; readonly exitCode: number | null }
  | { readonly type: "attention" };

const ESC = "\u001b";
const BEL = "\u0007";
const OSC_START = `${ESC}]`;
const STRING_TERMINATOR = `${ESC}\\`;
const COMMAND_LINE_PREFIX = "133;C;cmdline=";
/** An unfinished sequence longer than this, such as an inline image, is dropped. */
const MAX_PENDING_CHARS = 4_096;

function itemOfOsc(body: string): ShellItem | null {
  if (body === "133;A") return { type: "prompt" };
  if (body === "133;A;k=s") return { type: "continuation" };
  if (body === "133;C") return { type: "commandStart", commandLine: null };
  if (body.startsWith(COMMAND_LINE_PREFIX)) {
    return { type: "commandStart", commandLine: body.slice(COMMAND_LINE_PREFIX.length) };
  }
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

/**
 * Where an OSC sequence whose body starts at `from` ends. BEL and `ESC \\` end it. Any other ESC
 * cuts it off, as in xterm, so a program that dies in the middle of a sequence (an inline image)
 * cannot hide the marks that follow; parsing goes on at that ESC. Null when the text ends first.
 */
function oscEnd(text: string, from: number): { end: number; next: number } | null {
  const bell = text.indexOf(BEL, from);
  const esc = text.indexOf(ESC, from);
  if (esc !== -1 && (bell === -1 || esc < bell)) {
    if (esc + 1 >= text.length) return null;
    return { end: esc, next: text.startsWith(STRING_TERMINATOR, esc) ? esc + 2 : esc };
  }
  return bell === -1 ? null : { end: bell, next: bell + 1 };
}

export function makeShellMarkParser() {
  // The start of a sequence that the last chunk did not finish.
  let pending = "";
  // Inside a dropped sequence: its terminator ends it and is no bell.
  let dropping = false;

  return {
    push(data: string): ReadonlyArray<ShellItem> {
      let whole = pending + data;
      if (dropping) {
        const dropped = oscEnd(whole, 0);
        if (dropped === null) {
          pending = whole.endsWith(ESC) ? ESC : "";
          return [];
        }
        dropping = false;
        whole = whole.slice(dropped.next);
      }
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
        const found = oscEnd(input, bodyStart);
        if (found === null) {
          flushText(osc);
          if (input.length - osc <= MAX_PENDING_CHARS) {
            pending = input.slice(osc) + trailing;
          } else {
            dropping = true;
          }
          return items;
        }
        const item = itemOfOsc(input.slice(bodyStart, found.end));
        if (item === null) {
          // Another sequence, such as a window title: its text stays and its BEL is no bell.
          index = found.next;
          continue;
        }
        flushText(osc);
        items.push(item);
        index = textStart = found.next;
      }
      flushText(input.length);
      return items;
    },
  };
}
