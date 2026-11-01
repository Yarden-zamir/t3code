/**
 * Fork: the machines of the Fleet view, this one first. Each row reads what its own server already
 * pushes: the server config, the connection and the scheduled task list. Nothing polls.
 */
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { kitshnMapUrl } from "@t3tools/client-runtime/fork/arrowLinks";
import { fleetTaskSummary } from "@t3tools/client-runtime/fork/fleet";
import {
  type FleetCommandInput,
  kitshnJoinedText,
  type KitshnMachineRef,
  resolveEnvironmentMachineKind,
  type ScheduledTask,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { EllipsisIcon, ExternalLinkIcon, SettingsIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import {
  type EnvironmentPresentation,
  useEnvironments,
  useKitshnMachines,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { fleetRunCommand, linkedMachines } from "~/state/machineMap";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveVersionMismatch } from "~/versionSkew";
import { isHostedByThisApp } from "../sidebar/useUpdateEverything";
import { EnvironmentRow } from "../settings/EnvironmentRow";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { KitshnBadge } from "./KitshnMark";

const fleetTasksAtom = environmentAtomList("web-fleet-scheduled-tasks", (environmentId) =>
  serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
);
const fleetCommandPermissionsAtom = environmentAtomList(
  "web-fleet-command-permissions",
  fleetRunCommand.permissionAtom,
);

const COMMANDS: ReadonlyArray<{
  readonly label: string;
  readonly command: FleetCommandInput;
  readonly separatorBefore?: true;
}> = [
  { label: "Install update when idle", command: { _tag: "installUpdate", whenIdle: true } },
  { label: "Install update now", command: { _tag: "installUpdate", whenIdle: false } },
  { label: "Restart server", command: { _tag: "restartServer" }, separatorBefore: true },
  { label: "Stop all agents", command: { _tag: "stopAllAgents" } },
  { label: "Pause scheduled tasks", command: { _tag: "pauseScheduledTasks" } },
  { label: "Resume scheduled tasks", command: { _tag: "resumeScheduledTasks" } },
];

/** "3 scheduled tasks · Last failed: Backup, 2 hours ago", or null before the list loads. */
function scheduledTasksText(tasks: ReadonlyArray<ScheduledTask> | null): string | null {
  if (tasks === null) return null;
  const { enabled, lastFailed } = fleetTaskSummary(tasks);
  return [
    `${enabled} scheduled ${enabled === 1 ? "task" : "tasks"}`,
    lastFailed?.lastRunAt == null
      ? null
      : `Last failed: ${lastFailed.title}, ${formatRelativeTimeLabel(lastFailed.lastRunAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function FleetMachines() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const kitshnMachines = useKitshnMachines();
  const ordered = environments.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryEnvironmentId) -
      Number(left.environmentId === primaryEnvironmentId),
  );
  const connectedIds = ordered.flatMap((environment) =>
    environment.connection.phase === "connected" && environment.serverConfig !== null
      ? [environment.environmentId]
      : [],
  );
  const connectedKey = environmentIdsKey(connectedIds);
  const taskQueries = useAtomValue(fleetTasksAtom(connectedKey));
  const permissions = useAtomValue(fleetCommandPermissionsAtom(connectedKey));
  // Machines that kitshn links to this one but that this app does not reach itself.
  const linked = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : linkedMachines({ environmentId: primaryEnvironmentId, input: {} }),
  );
  const known = new Set(ordered.map((environment) => environment.environmentId));
  const linkedOnly = (linked.data ?? []).filter((machine) => !known.has(machine.environmentId));

  return (
    <div className="divide-y divide-border/60">
      {ordered.map((environment) => {
        const index = connectedIds.indexOf(environment.environmentId);
        const query = index < 0 ? null : taskQueries[index]!;
        return (
          <FleetMachineRow
            key={environment.environmentId}
            environment={environment}
            isPrimary={environment.environmentId === primaryEnvironmentId}
            kitshnMachine={kitshnMachines.get(environment.environmentId)}
            tasks={
              query === null ? null : (AsyncResult.getOrElse(query, () => null)?.tasks ?? null)
            }
            canRunCommands={index >= 0 && permissions[index] === true}
          />
        );
      })}
      {linkedOnly.map((machine) => (
        <EnvironmentRow
          key={machine.environmentId}
          kind="server"
          label={machine.name}
          mark={<KitshnBadge machine={{ name: machine.name }} />}
          subtitle="Linked through kitshn. Add it with a device invite to see its state here."
        />
      ))}
    </div>
  );
}

function FleetMachineRow({
  environment,
  isPrimary,
  kitshnMachine,
  tasks,
  canRunCommands,
}: {
  readonly environment: EnvironmentPresentation;
  readonly isPrimary: boolean;
  readonly kitshnMachine: KitshnMachineRef | undefined;
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly canRunCommands: boolean;
}) {
  const navigate = useNavigate();
  const runCommand = useAtomCommand(fleetRunCommand, { reportFailure: false });
  const hostedByThisApp = isHostedByThisApp(environment);
  const desktopUpdate = useDesktopUpdateState();
  const config = environment.serverConfig;
  const version = config?.environment.serverVersion ?? null;
  const mismatch = resolveVersionMismatch(version);
  const updateText = hostedByThisApp
    ? desktopUpdateText(desktopUpdate)
    : [
        config === null ? null : `Auto-update ${config.settings.forkAutoUpdate ? "on" : "off"}`,
        mismatch === null ? null : `Behind this app (${mismatch.clientVersion})`,
      ]
        .filter(Boolean)
        .join(" · ");
  const mapUrl = environment.displayUrl === null ? null : kitshnMapUrl(environment.displayUrl);

  const run = async (label: string, command: FleetCommandInput) => {
    const result = await runCommand({
      environmentId: environment.environmentId,
      input: { command },
    });
    const error =
      result._tag === "Success" ? result.value.error : "The machine did not answer the command.";
    toastManager.add(
      stackedThreadToast(
        error === null
          ? { type: "success", title: `${label}: sent to ${environment.label}` }
          : { type: "error", title: `${label} failed on ${environment.label}`, description: error },
      ),
    );
  };

  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(config)}
      label={isPrimary ? `${environment.label} (this machine)` : environment.label}
      mark={<KitshnBadge machine={kitshnMachine} />}
      subtitle={[
        connectionStatusText(environment.connection),
        version === null ? null : `T3 ${version}`,
        updateText || null,
      ]
        .filter(Boolean)
        .join(" · ")}
      below={
        <>
          <p className="truncate text-xs text-muted-foreground">
            {kitshnMachine === undefined
              ? "Manual environment: an address that you added and paired."
              : kitshnJoinedText(kitshnMachine)}
          </p>
          {tasks === null ? null : (
            <p className="truncate text-xs text-muted-foreground">{scheduledTasksText(tasks)}</p>
          )}
        </>
      }
    >
      {kitshnMachine !== undefined && mapUrl !== null ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Open ${environment.label} on the kitshn map`}
          render={<a href={mapUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Settings of ${environment.label}`}
        onClick={() =>
          void navigate({
            to: "/settings/general",
            search: { machine: environment.environmentId },
          })
        }
      >
        <SettingsIcon className="size-3.5" />
      </Button>
      {canRunCommands ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Commands for ${environment.label}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {COMMANDS.filter(
              // The desktop app installs its own update with the update button.
              (entry) => !(hostedByThisApp && entry.command._tag === "installUpdate"),
            ).map((entry) => (
              <FleetCommandItem
                key={entry.label}
                label={entry.label}
                separatorBefore={entry.separatorBefore === true}
                onClick={() => void run(entry.label, entry.command)}
              />
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </EnvironmentRow>
  );
}

function FleetCommandItem(props: {
  readonly label: string;
  readonly separatorBefore: boolean;
  readonly onClick: () => void;
}) {
  return (
    <>
      {props.separatorBefore ? <MenuSeparator /> : null}
      <MenuItem onClick={props.onClick}>{props.label}</MenuItem>
    </>
  );
}

function desktopUpdateText(state: ReturnType<typeof useDesktopUpdateState>): string {
  if (state === null || !state.enabled) return "Updates with this app";
  switch (state.status) {
    case "available":
      return state.availableVersion === null
        ? "Update available"
        : `Update ${state.availableVersion} available`;
    case "downloading":
      return "Downloading the update";
    case "downloaded":
      return state.downloadedVersion === null
        ? "Update ready to install"
        : `Update ${state.downloadedVersion} ready to install`;
    case "error":
      return "Update failed";
    default:
      return "Up to date";
  }
}
