import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

const { confirmMock } = vi.hoisted(() => ({
  confirmMock: vi.fn<(message: string, options?: unknown) => Promise<boolean>>(),
}));

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: confirmMock } }),
}));

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { confirmTerminalClose, isTerminalCloseConfirmPending } from "./terminalCloseConfirm";

describe("terminal close confirmation", () => {
  it("closes without prompting when the confirmation setting is off", async () => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, confirmTerminalClose: false });

    await expect(confirmTerminalClose(["Terminal 1"])).resolves.toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(isTerminalCloseConfirmPending()).toBe(false);
  });
});
