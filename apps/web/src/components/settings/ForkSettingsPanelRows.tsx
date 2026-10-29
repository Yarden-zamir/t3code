/**
 * The fork parts of `SettingsPanels.tsx` and `AppearanceSettingsPanel.tsx`. They import this
 * module once, so each upstream file keeps one line per hook. The rows of each place come from
 * `forkSettingsCatalog.ts`.
 */
import { ForkSettingsSlot } from "./ForkSettingsSlot";

export { ForkSettingsSlot } from "./ForkSettingsSlot";
export { FORK_SETTINGS_RESTORE_PATCH, forkChangedSettingLabels } from "./forkSettingsRestore";
export {
  openIdleInstallPromptIfWorkRuns,
  useIdleInstallArmed,
} from "../desktop/DesktopUpdateIdleInstall";
export { prepareNewestUpdateInstall } from "../desktop/DesktopUpdateNewerCheck";

/**
 * The fork releases have one track, nightly, so the desktop app hides the upstream Stable/Nightly
 * switch. That switch targets upstream npm releases. Revisit if the fork publishes a stable track.
 */
export const SHOWS_DESKTOP_UPDATE_TRACK = false;

/** Appearance: the fork sections, after the upstream sections and before Motion. */
export function AppearanceSections() {
  return (
    <>
      <ForkSettingsSlot place="appearance-thread-cards" />
      <ForkSettingsSlot place="appearance-thread-links" />
      <ForkSettingsSlot place="appearance-mobile-app" />
    </>
  );
}
