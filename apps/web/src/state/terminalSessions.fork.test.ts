import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";

import { attachedTerminalSessionAtom } from "./terminalSessions";

const attachCalls = vi.hoisted(() => [] as Array<{ stream: string; request: unknown }>);
vi.mock("./terminal", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const stream = (name: string) => (request: unknown) => {
    attachCalls.push({ stream: name, request });
    return Atom.make(AsyncResult.initial(true));
  };
  return {
    terminalEnvironment: {
      attach: stream("attach"),
      attachDraft: stream("attachDraft"),
      metadata: () => Atom.make(AsyncResult.initial(true)),
    },
  };
});
vi.mock("./session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const granted = Atom.make(AsyncResult.success({}));
  return {
    environmentSession: { sessionStateAtom: () => granted },
    sessionHasScope: () => true,
    useEnvironmentScope: () => true,
  };
});

const environmentId = EnvironmentId.make("environment-fork-draft");
const input = {
  threadId: ThreadId.make("thread-fork-draft"),
  terminalId: "term-1",
  cwd: "/repo",
  shell: "zsh",
};

describe("attachedTerminalSessionAtom (fork draft terminals)", () => {
  it("attaches a draft shell through the short-lived draft stream", () => {
    attachCalls.length = 0;
    const draft = attachedTerminalSessionAtom(environmentId, input, true);
    const thread = attachedTerminalSessionAtom(environmentId, input);
    expect(draft).not.toBe(thread);

    const registry = AtomRegistry.make();
    registry.get(draft);
    registry.get(thread);
    expect(attachCalls).toEqual([
      { stream: "attachDraft", request: { environmentId, input } },
      { stream: "attach", request: { environmentId, input } },
    ]);
  });
});
