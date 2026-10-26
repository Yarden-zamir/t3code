/** Fork: guest links over the Cloudflare tunnel, for builds without T3 Connect. */
import { GUEST_ROUTE_PREFIX, GUEST_SHARE_PARAM } from "./guestShare.ts";

/** One image of a tool's output in the shared thread: `?share=<id>&item=<id>&index=<n>`. */
export const GUEST_TOOL_OUTPUT_IMAGE_ROUTE = `${GUEST_ROUTE_PREFIX}/tool-output-image`;

export const guestToolOutputImageUrl = (shareId: string, itemId: string, index: number) =>
  `${GUEST_TOOL_OUTPUT_IMAGE_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&item=${encodeURIComponent(itemId)}&index=${index}`;
