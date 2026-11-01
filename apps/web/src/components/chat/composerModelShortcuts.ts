import type { NamedCommand } from "../focusLevels/ShortcutHint";

const TRIGGER_COMMAND_NAMES = {
  "modelPicker.toggle": "Model",
  "composer.effort": "Effort",
  "composer.mode": "Permissions",
} as const;

type TriggerCommand = keyof typeof TRIGGER_COMMAND_NAMES;

function isTriggerCommand(name: string): name is TriggerCommand {
  return Object.hasOwn(TRIGGER_COMMAND_NAMES, name);
}

/**
 * Fork: the commands of the composer model trigger, named for its tooltip. `triggerShortcuts` is
 * the upstream `data-composer-shortcut` value, such as "composer.effort composer.mode".
 */
export function composerTriggerCommands(
  triggerShortcuts: string | undefined,
): ReadonlyArray<NamedCommand> {
  const names = ["modelPicker.toggle", ...(triggerShortcuts?.split(" ") ?? [])];
  return names.map((name) => {
    if (!isTriggerCommand(name)) {
      throw new Error(`The composer model trigger has no tooltip name for "${name}"`);
    }
    return { command: name, name: TRIGGER_COMMAND_NAMES[name] };
  });
}
