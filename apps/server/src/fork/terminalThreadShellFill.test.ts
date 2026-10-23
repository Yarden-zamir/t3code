import { it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, TERMINAL_THREAD_INSTANCE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { withTerminalThreadShell } from "./terminalThreadShellFill.ts";

const threadsWith = (thread: { providerInstanceId: string; model: string } | null) =>
  ({
    getThreadShell: () =>
      Effect.succeed(
        thread === null
          ? null
          : {
              providerInstanceId: thread.providerInstanceId,
              modelSelection: { instanceId: thread.providerInstanceId, model: thread.model },
            },
      ),
  }) as unknown as ThreadManagement.ThreadManagementService["Service"];

const input = (terminalId: string, shell?: string) => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/work",
  ...(shell === undefined ? {} : { shell }),
});

it.effect("gives every terminal of a terminal thread the shell of the thread", () =>
  Effect.gen(function* () {
    const terminalThread = threadsWith({
      providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
      model: "fish",
    });
    expect((yield* withTerminalThreadShell(terminalThread, input(DEFAULT_TERMINAL_ID))).shell).toBe(
      "fish",
    );
    expect((yield* withTerminalThreadShell(terminalThread, input("term-2"))).shell).toBe("fish");
    // A shell that the client names stands.
    expect((yield* withTerminalThreadShell(terminalThread, input("term-2", "zsh"))).shell).toBe(
      "zsh",
    );
    // The legacy model means the default shell.
    const legacy = threadsWith({
      providerInstanceId: TERMINAL_THREAD_INSTANCE_ID,
      model: "terminal",
    });
    expect((yield* withTerminalThreadShell(legacy, input("term-2"))).shell).toBeUndefined();
  }),
);

it.effect("leaves the terminals of an agent thread and of a draft alone", () =>
  Effect.gen(function* () {
    const agent = threadsWith({ providerInstanceId: "codex", model: "gpt-5" });
    expect((yield* withTerminalThreadShell(agent, input("term-2"))).shell).toBeUndefined();
    expect(
      (yield* withTerminalThreadShell(threadsWith(null), input(DEFAULT_TERMINAL_ID))).shell,
    ).toBeUndefined();
  }),
);
