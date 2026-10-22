/**
 * Fork: what the `terminal` provider driver needs from the terminal manager. The driver imports
 * this module and not `terminal/Manager.ts`, because the manager imports the provider hydration,
 * which imports the built-in drivers.
 */
import type { ProjectId, TerminalOpenInput, TerminalWriteInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TerminalPortError extends Schema.TaggedError<TerminalPortError>()(
  "TerminalPortError",
  { operation: Schema.Literals(["open", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Terminal ${this.operation} failed.`;
  }
}

export type TerminalPortEvent =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "ended" };

export class TerminalPort extends Context.Service<
  TerminalPort,
  {
    /** A terminal that is open and has a live process. */
    readonly isRunning: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<boolean>;
    /** A program runs in the terminal, in front of the shell. */
    readonly hasRunningProgram: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<boolean>;
    /** The workspace root of a project, or null when it is unknown. */
    readonly workspaceRootOf: (projectId: ProjectId) => Effect.Effect<string | null>;
    readonly open: (input: TerminalOpenInput) => Effect.Effect<void, TerminalPortError>;
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalPortError>;
    /** Returns the function that stops the subscription. */
    readonly subscribe: (
      input: { readonly threadId: string; readonly terminalId: string },
      listener: (event: TerminalPortEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/fork/terminalProvider/port/TerminalPort") {}

/**
 * The driver reads the port as an optional service, so no layer stack that builds the provider
 * registry has to provide it. A stack without the port, such as a test, gets this one.
 */
export const unavailableTerminalPort: TerminalPort["Service"] = {
  isRunning: () => Effect.succeed(false),
  hasRunningProgram: () => Effect.succeed(false),
  workspaceRootOf: () => Effect.succeed(null),
  open: () =>
    Effect.fail(
      new TerminalPortError({ operation: "open", cause: "The terminal service is not available." }),
    ),
  write: () =>
    Effect.fail(
      new TerminalPortError({
        operation: "write",
        cause: "The terminal service is not available.",
      }),
    ),
  subscribe: () => Effect.succeed(() => undefined),
};
