// Must stay first: the render counter wraps the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { AppRegistry, LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";
import { AssistantPanelRoot } from "./src/features/assistant/AssistantPanel";

// Required for react-native-screens' iOS FormSheet sizing fix when a nested
// native stack is rendered inside a non-fitToContents formSheet.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
// Fork: the Android assistant panel root, which modules/t3-assistant opens.
AppRegistry.registerComponent("T3Assistant", () => AssistantPanelRoot);
