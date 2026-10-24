import { isElectronAccelerator } from "@t3tools/shared/electronAccelerator";

interface ShortcutBinding {
  readonly accelerator: string;
  readonly action: string;
}

function shortcutKey(accelerator: string, platform: string) {
  const command = platform === "darwin" ? "command" : "super";
  const aliases: Record<string, string> = {
    cmd: "command",
    ctrl: "control",
    option: "alt",
    meta: command,
    super: command,
    commandorcontrol: platform === "darwin" ? "command" : "control",
    cmdorctrl: platform === "darwin" ? "command" : "control",
    return: "enter",
    esc: "escape",
  };
  const parts = accelerator
    .toLowerCase()
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      return aliases[trimmed] ?? trimmed;
    });
  const key = parts.pop();
  return [...new Set(parts)]
    .sort()
    .concat(key ?? "")
    .join("+");
}

/** Own only our registrations: never unregister a key held by Snap Shot or another feature. */
export function createGlobalShortcutRegistry(
  api: {
    register: (accelerator: string, callback: () => void) => boolean;
    unregister: (accelerator: string) => void;
  },
  dispatch: (action: string) => void,
  platform: string,
) {
  const registered = new Map<string, { accelerator: string; action: string }>();
  return (bindings: readonly ShortcutBinding[]): readonly string[] => {
    const desired = new Map<string, ShortcutBinding>();
    const failed: string[] = [];
    // First binding wins, including app-toggle bindings before scripts. Compare aliases before
    // diffing so a newly configured app-toggle can also take a key held by an older script.
    for (const binding of bindings) {
      const key = shortcutKey(binding.accelerator, platform);
      if (!isElectronAccelerator(binding.accelerator) || desired.has(key)) {
        failed.push(binding.accelerator);
        continue;
      }
      desired.set(key, binding);
    }
    for (const [key, binding] of registered) {
      if (desired.get(key)?.action === binding.action) continue;
      api.unregister(binding.accelerator);
      registered.delete(key);
    }
    for (const [key, binding] of desired) {
      if (registered.has(key)) continue;
      try {
        if (api.register(binding.accelerator, () => dispatch(binding.action))) {
          registered.set(key, binding);
          continue;
        }
      } catch {
        // Electron can reject accelerators that pass the portable grammar check.
      }
      failed.push(binding.accelerator);
    }
    return failed;
  };
}
