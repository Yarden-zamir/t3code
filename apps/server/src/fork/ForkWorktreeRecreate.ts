import {
  CommandId,
  type ForkRecreateThreadWorktreeInput,
  MessageId,
  WorktreeMcpFailure,
  type WorktreeMcpHandoffResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorktreeMcpService from "../mcp/WorktreeMcpService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { actAsThread } from "./forkWorktreeHandoffTool.ts";

/**
 * Fork: `thread.recreateWorktree`. A thread whose worktree folder is gone moves to a new worktree,
 * then gets the message of its latest failed run again.
 */
export class ForkWorktreeRecreate extends Context.Service<
  ForkWorktreeRecreate,
  {
    readonly recreate: (
      input: ForkRecreateThreadWorktreeInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
  }
>()("t3/fork/ForkWorktreeRecreate") {}

const failure = (code: WorktreeMcpFailure["code"], message: string) =>
  new WorktreeMcpFailure({ code, message });

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const worktrees = yield* WorktreeMcpService.WorktreeMcpService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const recreate: ForkWorktreeRecreate["Service"]["recreate"] = Effect.fn(
    "ForkWorktreeRecreate.recreate",
  )(function* ({ threadId, runId }) {
    const { thread, runs, messages } = yield* threads
      .getThreadRecords(threadId, ["runs", "messages"])
      .pipe(
        Effect.mapError(() => failure("thread_not_found", `Thread '${threadId}' was not found.`)),
      );
    // The upstream handoff refuses a folder that exists and a disabled "Restore worktrees on resume".
    if (thread.worktreePath === null)
      return yield* failure("invalid_request", `Thread '${threadId}' has no worktree to recreate.`);
    const latest = runs.reduce<(typeof runs)[number] | undefined>(
      (newest, run) => (newest === undefined || run.ordinal > newest.ordinal ? run : newest),
      undefined,
    );
    const message = messages.find((candidate) => candidate.id === latest?.userMessageId);
    if (latest?.id !== runId || latest.status !== "failed" || message === undefined)
      return yield* failure(
        "invalid_request",
        `Run '${runId}' is not the latest failed run of thread '${threadId}'.`,
      );
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError(() => failure("operation_failed", "Unable to read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("project_not_found", "The project was not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const taken = new Set(
      yield* git
        .listLocalBranchNames(project.workspaceRoot)
        .pipe(Effect.mapError(() => failure("operation_failed", "Unable to list branches."))),
    );
    const base = `${thread.branch ?? "t3code/workspace"}-restored`;
    let branch = base;
    for (let suffix = 2; taken.has(branch); suffix++) branch = `${base}-${suffix}`;
    const { environmentId } = yield* environment.getDescriptor;
    const result = yield* worktrees.handoff(
      actAsThread(
        {
          environmentId,
          capabilities: new Set(["worktree"]),
          issuedAt: 0,
          requestNamespace: "fork-worktree-recreate",
          thread: undefined,
          client: undefined,
        },
        { threadId, providerInstanceId: thread.providerInstanceId },
      ),
      { branch },
    );
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const continuation = yield* threads
      .sendToThread({
        projectId: thread.projectId,
        commandId: CommandId.make(`fork-worktree-recreate:${uuid}`),
        threadId,
        messageId: MessageId.make(`fork-worktree-recreate:${uuid}`),
        text: message.text,
        attachments: message.attachments,
        mode: "queue",
        createdBy: message.createdBy,
        creationSource: message.creationSource,
        ...(message.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
      })
      .pipe(
        Effect.map((sent) => ({ status: "scheduled" as const, delivery: sent.delivery })),
        Effect.catchCause((cause) =>
          Effect.succeed({ status: "failed" as const, detail: Cause.pretty(cause) }),
        ),
      );
    return { ...result, continuation };
  });

  return ForkWorktreeRecreate.of({ recreate });
});

export const layer = Layer.effect(ForkWorktreeRecreate, make);
