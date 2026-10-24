import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import { nextTerminalHold, TERMINAL_HOLD_MAX, TERMINAL_HOLD_NOTICE_LEAD } from "./ForkUpdates.ts";

const max = Duration.toMillis(TERMINAL_HOLD_MAX);
const lead = Duration.toMillis(TERMINAL_HOLD_NOTICE_LEAD);

describe("nextTerminalHold", () => {
  it("installs at once when no terminal thread program runs", () => {
    expect(nextTerminalHold(null, false, 0)).toEqual({ action: "install", hold: null });
    expect(nextTerminalHold({ since: 0, noticedAt: null }, false, 1).action).toBe("install");
  });

  it("holds for the maximum, then prints the notice, then installs after the lead", () => {
    let step = nextTerminalHold(null, true, 0);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max - 1);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max);
    expect(step.action).toBe("notify");
    // The notice goes out once.
    step = nextTerminalHold(step.hold, true, max + lead - 1);
    expect(step.action).toBe("wait");
    step = nextTerminalHold(step.hold, true, max + lead);
    expect(step).toEqual({ action: "install", hold: null });
  });
});
