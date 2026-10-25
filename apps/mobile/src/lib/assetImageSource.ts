import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

import { withRequestHeaders } from "../connection/requestHeaders";

/** Cache immutable attachments by id; signed URLs change on each mint and reconnect. */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  return withRequestHeaders(
    resource._tag === "attachment"
      ? {
          uri,
          cacheKey: `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`,
        }
      : { uri },
  );
}
