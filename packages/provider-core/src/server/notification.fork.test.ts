import { assert, describe, it } from "@effect/vitest";

import { backgroundWorkNotification } from "./notification.ts";

describe("backgroundWorkNotification", () => {
  it("keeps the task of every report that names one", () => {
    const monitor = { taskId: "b1", toolUseId: "toolu_1", outputFile: "/tmp/tasks/b1.output" };
    const notification = backgroundWorkNotification([
      { kind: "monitor", label: "Watch the build", outcome: "completed", task: monitor },
      { kind: "monitor", label: "Watch the logs", outcome: "completed" },
    ]);
    assert.deepEqual(notification.tasks, [monitor]);
    assert.isUndefined(
      backgroundWorkNotification([{ kind: "monitor", outcome: "completed" }]).tasks,
    );
  });
});
