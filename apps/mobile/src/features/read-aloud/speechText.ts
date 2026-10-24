/**
 * Fork: turns reply markdown into text a speech engine reads well. Code blocks become one short
 * phrase, and markup characters are dropped. Plain string scans; the input is small.
 */
export function markdownToSpeech(markdown: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const endParagraph = () => {
    if (current.length > 0) paragraphs.push(current.join(" "));
    current = [];
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      if (!inFence) {
        endParagraph();
        paragraphs.push("Code block.");
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) {
      endParagraph();
      continue;
    }
    const spoken = inlineToSpeech(stripLinePrefix(line));
    if (spoken.length > 0) current.push(spoken);
  }
  endParagraph();
  return paragraphs.join("\n\n");
}

function stripLinePrefix(line: string): string {
  let rest = line;
  while (rest.startsWith("#") || rest.startsWith(">")) rest = rest.slice(1).trimStart();
  for (const bullet of ["- [ ] ", "- [x] ", "- ", "* ", "+ "]) {
    if (rest.startsWith(bullet)) return rest.slice(bullet.length);
  }
  if (rest.startsWith("|")) {
    const cells = rest.split("|").map((cell) => cell.trim());
    // A separator row such as |---|:---:| has only dashes and colons.
    if (
      cells.every((cell) => [...cell].every((character) => character === "-" || character === ":"))
    ) {
      return "";
    }
    return cells.filter((cell) => cell.length > 0).join(", ");
  }
  return rest;
}

/** Keeps the label of `[label](url)` and `![alt](url)`, and drops emphasis and code marks. */
function inlineToSpeech(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const open = line.indexOf("[", index);
    if (open < 0) break;
    const middle = line.indexOf("](", open);
    const close = middle < 0 ? -1 : line.indexOf(")", middle);
    if (middle < 0 || close < 0) break;
    const imageMark = open > index && line[open - 1] === "!" ? 1 : 0;
    result += line.slice(index, open - imageMark) + line.slice(open + 1, middle);
    index = close + 1;
  }
  result += line.slice(index);
  for (const mark of ["**", "__", "~~", "`"]) result = result.replaceAll(mark, "");
  return result.trim();
}

/** Splits text into parts no longer than `maxLength`, at paragraph, sentence or word ends. */
export function splitForSpeech(text: string, maxLength: number): ReadonlyArray<string> {
  const parts: string[] = [];
  let current = "";
  const push = (piece: string) => {
    const joined = current.length === 0 ? piece : `${current}\n\n${piece}`;
    if (joined.length <= maxLength) {
      current = joined;
      return;
    }
    if (current.length > 0) parts.push(current);
    current = "";
    let rest = piece;
    while (rest.length > maxLength) {
      const window = rest.slice(0, maxLength);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(" "));
      const end = cut > 0 ? cut + 1 : maxLength;
      parts.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trimStart();
    }
    current = rest;
  };
  for (const paragraph of text.split("\n\n")) {
    if (paragraph.trim().length > 0) push(paragraph.trim());
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
