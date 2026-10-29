import { ForkServerSwitchRow } from "./ThreadLinkChipsSettings";

/** Fork: `kitshnProvider` (apps/server/src/fork/kitshn/KitshnProvider.ts). */
export function KitshnProviderSettingsRow() {
  return (
    <ForkServerSwitchRow
      settingKey="kitshnProvider"
      searchId="kitshn-provider"
      label="kitshn provider"
      description="Show this server as a card on the kitshn map, with commands such as Restart server and Collect diagnostics. Its kitshn grants then decide who reaches T3 through the tunnel, the owner included. Needs kitshn 2 on this machine."
    />
  );
}
