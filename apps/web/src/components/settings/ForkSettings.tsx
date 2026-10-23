import { Link } from "@tanstack/react-router";
import type { ComponentType } from "react";

import { Button } from "../ui/button";
import { FORK_SETTING_ROWS, HIDE_WITHOUT_ROWS, isForkEntryShown } from "./ForkSettingsSlot";
import { AboutVersionSection } from "./SettingsPanels";
import { useSettingsScope } from "./SettingsScopeContext";
import { WorktreesDirectoryRow } from "./StorageSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  FORK_SETTING_PLACES,
  forkSettingGroups,
  type UpstreamSettingRowId,
} from "./forkSettingsCatalog";
import { SETTINGS_SECTION_LABELS, type SettingsSearchItem } from "./settingsSearch";
import { useAvailableSettingsSearchItems } from "./useAvailableSettingsSearchItems";

/** The upstream rows that the fork changed and the Fork page renders, as on their own page. */
const UPSTREAM_SETTING_ROWS: Readonly<Record<UpstreamSettingRowId, ComponentType>> = {
  "update-track": AboutVersionSection,
  "storage-worktrees-location": WorktreesDirectoryRow,
};

/** Opens the row of `item` in its place, the way a search result does. */
function placeLinkProps(item: SettingsSearchItem) {
  return {
    to: item.to,
    hash: item.id,
    hashScrollIntoView: false,
    state: { settingsTargetHighlight: true },
  } as const;
}

export function ForkSettingsPanel() {
  const { search, scope } = useSettingsScope();
  const available = useAvailableSettingsSearchItems(search);
  const availableById = new Map(available.map((item) => [item.id, item] as const));

  return (
    <SettingsPageContainer>
      {forkSettingGroups.map((group) => {
        // A row that its own setting hides, such as "Single-thread tabs" while sidebar tabs are
        // off, is not in `available` and does not count.
        const entries = group.entries.flatMap((entry) => {
          const item = availableById.get(entry.ids[0]);
          return item !== undefined && isForkEntryShown(entry.ids, availableById, scope.kind)
            ? [{ entry, item }]
            : [];
        });
        if (entries.length === 0) return null;
        return (
          // A row can render nothing, for example the machine map without an environment. An
          // entry or a group without a rendered row hides.
          <SettingsSection key={group.title} title={group.title} className={HIDE_WITHOUT_ROWS}>
            {entries.map(({ entry, item }) => {
              if ("linkOnly" in entry) {
                return (
                  <SettingsRow
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    description={entry.change}
                    control={
                      <Button
                        size="sm"
                        variant="outline"
                        render={<Link {...placeLinkProps(item)} />}
                      >
                        Open in {SETTINGS_SECTION_LABELS[item.to]}
                      </Button>
                    }
                  />
                );
              }
              const Row =
                "place" in entry
                  ? FORK_SETTING_ROWS[entry.ids[0]]
                  : UPSTREAM_SETTING_ROWS[entry.ids[0]];
              const section = "place" in entry ? FORK_SETTING_PLACES[entry.place].section : null;
              const placeLabel =
                section === null
                  ? SETTINGS_SECTION_LABELS[item.to]
                  : `${SETTINGS_SECTION_LABELS[item.to]} › ${section}`;
              return (
                <div key={item.id} className={HIDE_WITHOUT_ROWS}>
                  <Row />
                  <p className="-mt-1 px-3 pb-3 text-xs text-muted-foreground sm:px-4">
                    {item.desktopOnly ? "Desktop app only. " : ""}
                    {"change" in entry ? `${entry.change} ` : ""}
                    Also in{" "}
                    <Link {...placeLinkProps(item)} className="underline underline-offset-2">
                      {placeLabel}
                    </Link>
                    .
                  </p>
                </div>
              );
            })}
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}
