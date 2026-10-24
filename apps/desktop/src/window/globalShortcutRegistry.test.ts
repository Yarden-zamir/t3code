import { describe, expect, it, vi } from "vite-plus/test";
import { createGlobalShortcutRegistry } from "./globalShortcutRegistry.ts";

function setup() {
  const callbacks = new Map<string, () => void>();
  const api = {
    register: vi.fn((key: string, callback: () => void) => {
      if (key === "Alt+Space") return false;
      callbacks.set(key, callback);
      return true;
    }),
    unregister: vi.fn((key: string) => callbacks.delete(key)),
  };
  const dispatch = vi.fn();
  return {
    api,
    dispatch,
    callbacks,
    configure: createGlobalShortcutRegistry(api, dispatch, "darwin"),
  };
}

describe("global shortcut registration", () => {
  it("keeps unchanged keys, replaces changed actions and releases removed keys", () => {
    const { api, callbacks, configure, dispatch } = setup();
    configure([{ accelerator: "F17", action: "nav" }]);
    configure([{ accelerator: "F17", action: "nav" }]);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.unregister).not.toHaveBeenCalled();
    callbacks.get("F17")?.();
    expect(dispatch).toHaveBeenLastCalledWith("nav");
    configure([{ accelerator: "F17", action: "other" }]);
    callbacks.get("F17")?.();
    expect(dispatch).toHaveBeenLastCalledWith("other");
    configure([]);
    expect(callbacks.size).toBe(0);
    expect(api.unregister.mock.calls).toEqual([["F17"], ["F17"]]);
  });

  it("gives the first action priority and never releases failed or invalid registrations", () => {
    const { api, callbacks, configure, dispatch } = setup();
    expect(
      configure([
        { accelerator: "F17", action: "toggle" },
        { accelerator: "f17", action: "nav" },
        { accelerator: "Alt+Space", action: "busy" },
        { accelerator: "invalid-key", action: "invalid" },
      ]),
    ).toEqual(["f17", "invalid-key", "Alt+Space"]);
    callbacks.get("F17")?.();
    expect(dispatch).toHaveBeenCalledWith("toggle");
    configure([]);
    expect(api.unregister.mock.calls).toEqual([["F17"]]);
  });

  it("retries unavailable keys and contains Electron conversion errors", () => {
    const { api, configure } = setup();
    api.register.mockImplementationOnce(() => {
      throw new Error("conversion failure");
    });
    const binding = [{ accelerator: "F18", action: "nav" }];
    expect(configure(binding)).toEqual(["F18"]);
    expect(configure(binding)).toEqual([]);
  });

  it("resolves modifier aliases and order before giving an app-toggle priority", () => {
    const { api, dispatch } = setup();
    const configure = createGlobalShortcutRegistry(api, dispatch, "darwin");
    configure([{ accelerator: "Cmd+Alt+N", action: "nav" }]);
    expect(
      configure([
        { accelerator: "Option+CommandOrControl+N", action: "toggle" },
        { accelerator: "Cmd+Alt+N", action: "nav" },
      ]),
    ).toEqual(["Cmd+Alt+N"]);
    expect(api.unregister).toHaveBeenCalledWith("Cmd+Alt+N");
    expect(api.register).toHaveBeenLastCalledWith(
      "Option+CommandOrControl+N",
      expect.any(Function),
    );
  });

  it.each(["win32", "linux"])("resolves CommandOrControl to Control on %s", (platform) => {
    const { api, dispatch } = setup();
    const configure = createGlobalShortcutRegistry(api, dispatch, platform);
    expect(
      configure([
        { accelerator: "CommandOrControl+Alt+N", action: "first" },
        { accelerator: "Option+Ctrl+N", action: "second" },
      ]),
    ).toEqual(["Option+Ctrl+N"]);
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it("releases the previous accelerator when a script changes its key", () => {
    const { configure, callbacks, api } = setup();
    configure([{ accelerator: "F18", action: "nav" }]);
    configure([{ accelerator: "F19", action: "nav" }]);
    expect(callbacks.has("F18")).toBe(false);
    expect(callbacks.has("F19")).toBe(true);
    expect(api.unregister).toHaveBeenCalledExactlyOnceWith("F18");
  });
});
