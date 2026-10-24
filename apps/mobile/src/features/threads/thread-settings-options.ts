import { RuntimeMode } from "@t3tools/contracts";

import type { AppSymbolName } from "../../components/ui/AppSymbol";

interface RuntimeModeDetails {
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
}

/** Icons match the web composer's runtime mode picker. */
export const RUNTIME_MODE_DETAILS: Record<RuntimeMode, RuntimeModeDetails> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: "lock",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: "pencil",
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: "sparkles",
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: "lock.open",
  },
};

export const RUNTIME_MODE_CHOICES: ReadonlyArray<
  RuntimeModeDetails & { readonly mode: RuntimeMode }
> = RuntimeMode.literals.map((mode) => ({ mode, ...RUNTIME_MODE_DETAILS[mode] }));

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes && supportedRuntimeModes.length > 0
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export function compatibleRuntimeModeForChoices(
  runtimeMode: RuntimeMode,
  choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return choices.some((choice) => choice.mode === runtimeMode)
    ? runtimeMode
    : (choices[0]?.mode ?? runtimeMode);
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
