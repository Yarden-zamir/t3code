import { describe, expect, it } from "vite-plus/test";

import { type CommandPaletteUiState, reduceCommandPaletteUiState } from "./CommandPalette.logic";
import { forkTerminalNewThreadInView } from "./ForkTerminalThreadPaletteItems";

const closed: CommandPaletteUiState = {
  open: false,
  mode: "command",
  openIntent: null,
  session: 0,
};

describe("command palette terminal thread intent (fork)", () => {
  it("opens 'new thread in' for the requested thread kind", () => {
    expect(
      reduceCommandPaletteUiState(closed, { _tag: "OpenNewThreadIn", threadKind: "terminal" }),
    ).toMatchObject({
      open: true,
      openIntent: { kind: "new-thread-in", threadKind: "terminal" },
      session: 1,
    });
  });

  it("keeps the terminal project list apart from the chat one", () => {
    // The palette fills a view whose group is "projects" with chat thread items.
    expect(forkTerminalNewThreadInView().groups.map((group) => group.value)).not.toContain(
      "projects",
    );
  });
});
