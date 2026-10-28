/**
 * Fork: how an agent links one message. Appended to the upstream thread link rule of
 * `T3_CODE_ORCHESTRATION_SECTIONS` and to the `t3_thread_read` description, which returns the ids.
 * A client without the fork or with `messageLinks` off ignores the fragment and opens the thread.
 */
export const FORK_MESSAGE_LINK_INSTRUCTIONS =
  "To link one message, append `#<messageId>` (from `t3_thread_read`) to the thread's `link` exactly as given. T3 Code opens the thread at that message.";
