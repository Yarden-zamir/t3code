"use client";

import type { DesktopPreviewColorScheme } from "@t3tools/contracts";
import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { shortcutLabelForCommand } from "~/keybindings";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export interface PreviewMoreMenuActions {
  readonly hardReload: () => void;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
  readonly clearCookies: () => void;
  readonly clearCache: () => void;
  readonly openDevTools?: () => void;
  readonly toggleNativePictureInPicture?: () => void;
}

interface Props {
  enabled: boolean;
  actions: PreviewMoreMenuActions;
  zoomFactor: number;
  colorScheme: DesktopPreviewColorScheme;
  deviceToolbarVisible: boolean;
  onToggleDeviceToolbar: () => void;
  nativePictureInPicture: boolean;
  profileName: string | undefined;
  move?: { readonly label: string; readonly onMove: () => void };
}

const MenuTriggerButton = () => (
  <Tooltip>
    <TooltipTrigger
      render={
        <MenuTrigger
          render={<Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />}
        />
      }
    >
      <MoreVertical />
    </TooltipTrigger>
    <TooltipPopup>More</TooltipPopup>
  </Tooltip>
);

export function PreviewMoreMenu({
  enabled,
  actions,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  profileName,
  move,
}: Props) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const zoomOutShortcutLabel = shortcutLabelForCommand(keybindings, "preview.zoomOut", {
    context: { previewFocus: true, previewOpen: true },
  });
  const zoomInShortcutLabel = shortcutLabelForCommand(keybindings, "preview.zoomIn", {
    context: { previewFocus: true, previewOpen: true },
  });
  const resetZoomShortcutLabel = shortcutLabelForCommand(keybindings, "preview.resetZoom", {
    context: { previewFocus: true, previewOpen: true },
  });
  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  const disabled = !enabled;
  return (
    <Menu>
      <MenuTriggerButton />
      <MenuPopup align="end" sideOffset={6}>
        <MenuItem onClick={actions.hardReload} disabled={disabled}>
          Hard reload
        </MenuItem>
        {actions.openDevTools ? (
          <MenuItem onClick={actions.openDevTools} disabled={disabled}>
            Open DevTools
          </MenuItem>
        ) : null}
        {actions.toggleNativePictureInPicture ? (
          <MenuItem onClick={actions.toggleNativePictureInPicture} disabled={disabled}>
            {nativePictureInPicture
              ? "Close separate preview window"
              : "Open separate preview window"}
          </MenuItem>
        ) : null}
        {move ? <MenuItem onClick={move.onMove}>{move.label}</MenuItem> : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={disabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={disabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => actions.setColorScheme(value as DesktopPreviewColorScheme)}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={disabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-xs"
                    type="button"
                    onClick={actions.zoomOut}
                    aria-label="Zoom out"
                    disabled={disabled}
                  />
                }
              >
                <Minus />
              </TooltipTrigger>
              <TooltipPopup>
                Zoom out{zoomOutShortcutLabel ? ` (${zoomOutShortcutLabel})` : ""}
              </TooltipPopup>
            </Tooltip>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-xs"
                    type="button"
                    onClick={actions.zoomIn}
                    aria-label="Zoom in"
                    disabled={disabled}
                  />
                }
              >
                <PlusIcon />
              </TooltipTrigger>
              <TooltipPopup>
                Zoom in{zoomInShortcutLabel ? ` (${zoomInShortcutLabel})` : ""}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    type="button"
                    onClick={actions.resetZoom}
                    aria-label="Reset zoom"
                    disabled={disabled}
                  />
                }
              >
                <RotateCcw />
              </TooltipTrigger>
              <TooltipPopup>
                Reset zoom{resetZoomShortcutLabel ? ` (${resetZoomShortcutLabel})` : ""}
              </TooltipPopup>
            </Tooltip>
          </span>
        </MenuItem>
        <MenuSeparator />
        {/*
         * Grouped so the heading has a `MenuGroup` ancestor — `MenuGroupLabel`
          reads its context and throws without one.
         */}
        <MenuGroup>
          {profileName ? (
            <MenuGroupLabel className="max-w-64">
              <span className="block truncate">Profile: {profileName}</span>
            </MenuGroupLabel>
          ) : null}
          <MenuItem onClick={actions.clearCookies}>Clear cookies</MenuItem>
          <MenuItem onClick={actions.clearCache}>Clear cache</MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
