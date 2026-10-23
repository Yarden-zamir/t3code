import { ForkServerSwitchRow } from "./ThreadLinkChipsSettings";

/** Fork: `accessChangeNotices` (`@t3tools/client-runtime/fork/accessChange`). */
export function AccessChangeNoticesSettingsRow() {
  return (
    <ForkServerSwitchRow
      settingKey="accessChangeNotices"
      searchId="access-change-notices"
      label="Access change notices"
      description="Show a notice when a machine map arrow changes what this device can do on this server, or what the agents of this server can do on another machine. Applies on desktop, web and the mobile app."
    />
  );
}
