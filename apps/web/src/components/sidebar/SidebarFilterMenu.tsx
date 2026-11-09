/**
 * Fork: the sidebar Filter menu and the chips of the active filters. The menu has one submenu
 * per field. A plain pick shows only that value and closes the menu; Shift adds or removes one
 * value and keeps the menu open. If upstream T3 Code ships sidebar filters, use theirs.
 */
import {
  Building2Icon,
  CpuIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  GitBranchIcon,
  LayersIcon,
  MonitorIcon,
  type LucideIcon,
} from "lucide-react";
import { type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, useState } from "react";

import { useOrderWhileOpen } from "../../hooks/useOrderWhileOpen";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { AppIcon } from "../AppIcon";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectPinButton } from "../ProjectPinButton";
import { filterMenuSummary, flipFilterOperator, type FilterOperator } from "../filters/FilterChip";
import { FilterChipList } from "../filters/FilterChipList";
import {
  pickSidebarFilterValue,
  SIDEBAR_FILTER_FIELD_LABELS,
  type SidebarFilterField,
  type SidebarFilterOption,
} from "../filters/sidebarFilters.logic";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import type { SidebarFilterChange } from "./useSidebarFilters";

/** A section offers a search box from this many values up. */
const SEARCH_FROM_VALUES = 9;

const FIELD_PLURALS = {
  project: "projects",
  machine: "machines",
  model: "models",
  branch: "branches",
  owner: "owners",
} as const satisfies Record<SidebarFilterField, string>;

const FIELD_ICONS = {
  project: FolderIcon,
  machine: MonitorIcon,
  model: CpuIcon,
  branch: GitBranchIcon,
  owner: Building2Icon,
} as const satisfies Record<SidebarFilterField, LucideIcon>;

export interface SidebarFilterSection {
  readonly field: SidebarFilterField;
  readonly operator: FilterOperator;
  readonly selected: readonly string[];
  readonly options: readonly SidebarFilterOption[];
}

/** What a project row offers beyond the pick: favicon, pin, settings and the machine badge. */
export interface SidebarFilterProjectRows {
  readonly groupByKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly canPin: (group: SidebarProjectSnapshot) => boolean;
  readonly togglePin: (group: SidebarProjectSnapshot) => void;
  readonly isPinShortcut: (event: ReactKeyboardEvent) => boolean;
  readonly openSettings: (group: SidebarProjectSnapshot) => void;
  /** Set when projects span machines: the badge names the machines of each project. */
  readonly environmentBadge: Omit<ComponentProps<typeof ProjectEnvironmentBadge>, "group"> | null;
}

export type SidebarFilterChangeHandler = (
  field: SidebarFilterField,
  change: SidebarFilterChange,
) => void;

const isToggleEvent = (event: Event) =>
  (event instanceof MouseEvent || event instanceof KeyboardEvent) && event.shiftKey;

export function SidebarFilterMenu(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly activeCount: number;
  /** Runs only while the menu is open, so the list render never builds the options. */
  readonly buildSections: () => readonly SidebarFilterSection[];
  readonly onChange: SidebarFilterChangeHandler;
  readonly projectRows?: SidebarFilterProjectRows | undefined;
}) {
  const { open, onOpenChange, activeCount } = props;
  const label =
    activeCount === 0
      ? "Filter threads"
      : `Filter threads: ${activeCount} ${activeCount === 1 ? "filter" : "filters"} on`;
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={label}
            shortcutContext={{ sidebarFocus: true }}
            command="sidebar.filter"
          />
        }
      >
        <AppIcon slot="sidebar.filter" />
        {activeCount > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end">
        {open ? (
          <SidebarFilterSections
            sections={props.buildSections()}
            onChange={props.onChange}
            onClose={() => onOpenChange(false)}
            projectRows={props.projectRows}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function SidebarFilterSections(props: {
  readonly sections: readonly SidebarFilterSection[];
  readonly onChange: SidebarFilterChangeHandler;
  readonly onClose: () => void;
  readonly projectRows: SidebarFilterProjectRows | undefined;
}) {
  if (props.sections.length === 0) return <MenuItem disabled>Nothing to filter yet</MenuItem>;
  return props.sections.map((section) => (
    <SidebarFilterSubmenu
      key={section.field}
      section={section}
      onChange={(change) => props.onChange(section.field, change)}
      onClose={props.onClose}
      projectRows={section.field === "project" ? props.projectRows : undefined}
    />
  ));
}

function SidebarFilterSubmenu(props: {
  readonly section: SidebarFilterSection;
  readonly onChange: (change: SidebarFilterChange) => void;
  readonly onClose: () => void;
  readonly projectRows: SidebarFilterProjectRows | undefined;
}) {
  const { section, onChange } = props;
  const { field, operator, selected, options } = section;
  const Icon = FIELD_ICONS[field];
  const fieldLabel = SIDEBAR_FILTER_FIELD_LABELS[field];
  const selectedLabels = selected.map(
    (value) => options.find((option) => option.value === value)?.label ?? value,
  );
  return (
    <MenuSub>
      <MenuSubTrigger>
        <Icon aria-hidden className="size-3.5" />
        <span className="flex-1">{fieldLabel}</span>
        <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
          {filterMenuSummary(selectedLabels, operator)}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup aria-label={`Filter by ${fieldLabel.toLowerCase()}`}>
        <MenuRadioGroup
          value={operator}
          onValueChange={(next) => {
            if (next === "is" || next === "is_not") onChange({ operator: next, values: selected });
          }}
        >
          <MenuRadioItem value="is">
            <span className="flex min-w-0 items-center gap-2">
              <EyeIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Show only</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          <MenuRadioItem value="is_not">
            <span className="flex min-w-0 items-center gap-2">
              <EyeOffIcon aria-hidden className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Hide</span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem disabled={selected.length === 0} onClick={() => onChange(null)}>
          <LayersIcon aria-hidden className="size-3.5" />
          {`All ${FIELD_PLURALS[field]}`}
        </MenuItem>
        <MenuSeparator />
        <SidebarFilterValues
          section={section}
          onPick={(value, toggle) => {
            onChange({ operator, values: pickSidebarFilterValue(selected, value, toggle) });
            if (!toggle) props.onClose();
          }}
          onClose={props.onClose}
          projectRows={props.projectRows}
        />
      </MenuSubPopup>
    </MenuSub>
  );
}

function SidebarFilterValues(props: {
  readonly section: SidebarFilterSection;
  readonly onPick: (value: string, toggle: boolean) => void;
  readonly onClose: () => void;
  readonly projectRows: SidebarFilterProjectRows | undefined;
}) {
  const { section, onPick, projectRows } = props;
  const [query, setQuery] = useState("");
  // Mounted only while the submenu is open; a pin keeps the rows where they were.
  const options = useOrderWhileOpen(section.options, (option) => option.value, true);
  const needle = query.trim().toLowerCase();
  const visible =
    needle.length === 0
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(needle));
  const plural = FIELD_PLURALS[section.field];
  return (
    <>
      {section.options.length >= SEARCH_FROM_VALUES ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`Search ${plural}`}
          aria-label={`Search ${plural}`}
        />
      ) : null}
      {visible.length === 0 ? <MenuItem disabled>{`No matching ${plural}`}</MenuItem> : null}
      {visible.map((option) => {
        const group = projectRows?.groupByKey.get(option.value) ?? null;
        return (
          <MenuCheckboxItem
            key={option.value}
            checked={section.selected.includes(option.value)}
            onCheckedChange={(_checked, details) =>
              onPick(option.value, isToggleEvent(details.event))
            }
            onKeyDown={(event) => {
              if (group === null || projectRows === undefined) return;
              if (!projectRows.canPin(group) || !projectRows.isPinShortcut(event)) return;
              event.preventDefault();
              event.stopPropagation();
              projectRows.togglePin(group);
            }}
            onContextMenu={(event) => {
              if (group === null || projectRows === undefined) return;
              event.preventDefault();
              props.onClose();
              projectRows.openSettings(group);
            }}
          >
            <span className="flex min-w-0 items-center gap-2">
              {group ? <ProjectFavicon project={group} className="size-4 shrink-0" /> : null}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {group && projectRows?.environmentBadge ? (
                <ProjectEnvironmentBadge group={group} {...projectRows.environmentBadge} />
              ) : null}
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {option.threadCount}
              </span>
              {group && projectRows?.canPin(group) ? (
                <ProjectPinButton
                  name={option.label}
                  pinned={group.pinned}
                  onToggle={() => projectRows.togglePin(group)}
                />
              ) : null}
            </span>
          </MenuCheckboxItem>
        );
      })}
    </>
  );
}

export interface SidebarFilterChip {
  readonly field: SidebarFilterField;
  readonly operator: FilterOperator;
  readonly values: readonly string[];
  readonly labels: readonly string[];
  /** The hidden threads that wait for an approval or an answer. */
  readonly hiddenNeedingUser: number;
}

/** Under the header: one chip per active filter, read as a sentence. */
export function SidebarFilterChips(props: {
  readonly chips: readonly SidebarFilterChip[];
  readonly onChange: SidebarFilterChangeHandler;
  readonly onClearAll: () => void;
}) {
  const { chips, onChange } = props;
  if (chips.length === 0) return null;
  return (
    <div role="status" className="min-w-0 px-2 py-1">
      <FilterChipList
        chips={chips.map((chip) => ({
          key: chip.field,
          field: SIDEBAR_FILTER_FIELD_LABELS[chip.field],
          operator: chip.operator,
          value: chip.labels.join(", "),
          alert: chip.hiddenNeedingUser > 0 ? `${chip.hiddenNeedingUser} need you` : undefined,
          onFlip: () =>
            onChange(chip.field, {
              operator: flipFilterOperator(chip.operator),
              values: chip.values,
            }),
          onRemove: () => onChange(chip.field, null),
        }))}
        onClearAll={props.onClearAll}
      />
    </div>
  );
}
