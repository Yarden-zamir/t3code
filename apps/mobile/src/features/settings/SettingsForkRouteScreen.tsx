import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { AppTokenSettingsSection } from "./forkAppTokenSettings";
import {
  ForkMobileNewThreadSection,
  ForkMobileSwitchRows,
  useForkMobileSettings,
} from "./forkMobileSettings";
import { SidebarTabSettingsSection } from "./forkSidebarTabEditor";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Fork: every fork setting that applies to the mobile app, like the Fork page of web settings.
 * Thread behavior and Server settings > New threads also show the ones of their topic.
 */
export function SettingsForkRouteScreen() {
  const insets = useSafeAreaInsets();
  const { targets } = useForkMobileSettings();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Fork" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Use the filter above to select a connected environment.
            </Text>
          ) : (
            <>
              <SettingsSection title="Web app and look">
                <ForkMobileSwitchRows />
              </SettingsSection>
              <SidebarTabSettingsSection />
              <AppTokenSettingsSection />
              <ForkMobileNewThreadSection />
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}
