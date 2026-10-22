import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { loadBalancingSendWarning } from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("loadBalancingSendWarning", () => {
  it("accepts a machine that reads the other machine through the machine map (MM-1906)", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateReadableEnvironmentIds: [[remote], [local, remote]],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});
