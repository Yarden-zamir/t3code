import { useAtomValue } from "@effect/atom-react";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import * as Linking from "expo-linking";
import { useRef, type ComponentRef } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { environmentThreadDetails } from "../../state/threads";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { panelExchanges } from "./assistantConversation";

/** Pixels from the end that still count as reading the newest words. */
const FOLLOW_SLOP = 24;

/**
 * Fork: the replies to what the panel sent, above its text field. Mount it only once the
 * server created the thread: a thread subscription treats a missing thread as deleted.
 */
export function AssistantConversation(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sent: ReadonlyArray<{ readonly messageId: MessageId; readonly text: string }>;
}) {
  const thread = useAtomValue(environmentThreadDetails.threadAtom(props.threadRef));
  const styles = useMarkdownPreviewStyles();
  const { height } = useWindowDimensions();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const followsEnd = useRef(true);
  const exchanges = panelExchanges({ projection: thread?.projection ?? null, sent: props.sent });

  return (
    <ScrollView
      ref={scrollRef}
      style={{ maxHeight: height * 0.45 }}
      contentContainerClassName="gap-3"
      keyboardShouldPersistTaps="handled"
      // A streaming reply grows at the bottom; it stays in view unless the user scrolled up.
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        followsEnd.current =
          contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLOP;
      }}
      scrollEventThrottle={100}
      onContentSizeChange={() => {
        if (followsEnd.current) scrollRef.current?.scrollToEnd({ animated: false });
      }}
    >
      {exchanges.map((exchange) => (
        <View key={exchange.messageId} className="gap-2">
          {exchange.text ? (
            <View className="max-w-[85%] self-end rounded-2xl bg-input px-3 py-2">
              <Text className="text-sm" numberOfLines={4}>
                {exchange.text}
              </Text>
            </View>
          ) : null}
          {exchange.replies.map((reply) => (
            <SelectableMarkdownText
              key={reply.messageId}
              markdown={reply.text}
              textStyle={styles.nativeTextStyle}
              onLinkPress={(href) => void Linking.openURL(href)}
            />
          ))}
          {exchange.state === "working" ? (
            <Text className="text-sm text-foreground-muted">Working…</Text>
          ) : exchange.state === "stopped" ? (
            <Text className="text-sm text-foreground-muted">The run stopped.</Text>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
