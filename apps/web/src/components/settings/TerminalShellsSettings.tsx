import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  ProviderDriverKind,
  type ServerSettings,
  TERMINAL_THREAD_INSTANCE_ID,
  type TerminalCustomShell,
  TerminalCustomShells,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const decodeCustomShells = Schema.decodeUnknownOption(TerminalCustomShells);
const validateCustomShells = Schema.decodeUnknownResult(TerminalCustomShells);

/** The fields as the user types them. Arguments are one line. */
interface ShellDraft {
  readonly name: string;
  readonly executable: string;
  readonly args: string;
}

const toDraft = (shell: TerminalCustomShell): ShellDraft => ({
  name: shell.name,
  executable: shell.executable,
  args: shell.args.join(" "),
});

// Limit: arguments split at spaces, so one argument cannot hold a space. Revisit when a custom
// shell needs one (`-c "print(1)"`).
const fromDraft = (draft: ShellDraft) => ({
  name: draft.name,
  executable: draft.executable,
  args: draft.args.split(" ").filter((arg) => arg.length > 0),
});

const EMPTY_DRAFT: ShellDraft = { name: "", executable: "", args: "" };

/**
 * Fork: the shells of terminal threads on the environment of the settings scope. The detected
 * shells are read-only; the custom shells live in the config of the `terminal` provider.
 */
export function TerminalShellsSettings() {
  const { target } = useSettingsScope();
  if (target === null) return null;
  return (
    <EnvironmentTerminalShells
      environmentId={target.environmentId}
      label={target.label}
      settings={target.settings}
    />
  );
}

function EnvironmentTerminalShells({
  environmentId,
  label,
  settings,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly settings: ServerSettings;
}) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const terminalProvider = useAtomValue(providersIgnoringCheckedAtAtom(environmentId)).find(
    (provider) => provider.instanceId === TERMINAL_THREAD_INSTANCE_ID,
  );
  const explicitInstance = settings.providerInstances[TERMINAL_THREAD_INSTANCE_ID];
  const config = explicitInstance?.config ?? {};
  const savedShells = Option.match(
    decodeCustomShells((config as { readonly customShells?: unknown }).customShells ?? []),
    { onNone: () => null, onSome: (shells) => shells },
  );
  const detected = (terminalProvider?.models ?? []).filter(
    (model) => !model.isCustom && model.isLegacy !== true,
  );

  // The rows keep what the user typed until it saves, so a rejected entry stays visible.
  const [drafts, setDrafts] = useState<ReadonlyArray<ShellDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rows = drafts ?? (savedShells ?? []).map(toDraft);

  const updateRow = (index: number, patch: Partial<ShellDraft>) =>
    setDrafts(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));

  const save = async (next: ReadonlyArray<ShellDraft>) => {
    if (next.some((row) => row.name.trim() === "" || row.executable.trim() === "")) {
      setError("Each shell needs a name and an executable.");
      return;
    }
    const validated = validateCustomShells(next.map(fromDraft));
    if (validated._tag === "Failure") {
      setError(validated.failure.message.split("\n")[0] ?? "The shells are not valid.");
      return;
    }
    setError(null);
    setSaving(true);
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: TERMINAL_THREAD_INSTANCE_ID,
      instance: {
        ...(explicitInstance ?? { driver: ProviderDriverKind.make("terminal") }),
        config: { ...(config as Record<string, unknown>), customShells: validated.success },
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "The shells were not saved.");
      }
      return;
    }
    setDrafts(null);
  };

  const changed = drafts !== null;

  return (
    <SettingsRow
      id="terminal-shells"
      title="Shells"
      description={`The shells that a terminal thread can run on ${label}. A custom shell is any executable with arguments, such as uv with run python. A name without a folder runs from the PATH of the terminal. Custom shells get no shell integration: a message to one is typed, and the thread shows no result.`}
      status={
        error !== null ? (
          <span className="text-destructive-foreground">{error}</span>
        ) : savedShells === null ? (
          <span className="text-destructive-foreground">
            The saved custom shells are not valid. Save the list again to replace them.
          </span>
        ) : null
      }
    >
      <div className="mt-3 flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-sm">
          {detected.length === 0 ? (
            <li className="text-muted-foreground">
              No shells detected. Turn on terminal threads to list them.
            </li>
          ) : (
            detected.map((model) => (
              <li key={model.slug} className="flex items-baseline gap-2">
                <span className="font-medium">{model.name}</span>
                <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                  {model.subProvider}
                </span>
                {model.isDefault ? (
                  <span className="text-muted-foreground text-xs">default</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
        {rows.map((row, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no id until they save, and a name can be blank.
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              size="sm"
              className="w-32"
              value={row.name}
              placeholder="Name"
              aria-label="Shell name"
              disabled={!canWrite}
              onChange={(event) => updateRow(index, { name: event.target.value })}
            />
            <Input
              size="sm"
              font="mono"
              className="w-40"
              value={row.executable}
              placeholder="Executable"
              aria-label="Shell executable"
              disabled={!canWrite}
              onChange={(event) => updateRow(index, { executable: event.target.value })}
            />
            <Input
              size="sm"
              font="mono"
              className="min-w-40 flex-1"
              value={row.args}
              placeholder="Arguments"
              aria-label="Shell arguments"
              disabled={!canWrite}
              onChange={(event) => updateRow(index, { args: event.target.value })}
            />
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={`Remove ${row.name || "shell"}`}
              disabled={!canWrite}
              onClick={() => setDrafts(rows.filter((_, rowIndex) => rowIndex !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite}
            onClick={() => setDrafts([...rows, EMPTY_DRAFT])}
          >
            <PlusIcon />
            Add custom shell
          </Button>
          {changed ? (
            <>
              <Button size="xs" disabled={!canWrite || saving} onClick={() => void save(rows)}>
                Save shells
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDrafts(null);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </SettingsRow>
  );
}
