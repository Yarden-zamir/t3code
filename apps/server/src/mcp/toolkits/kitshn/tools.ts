/** Fork: kitshn publishing with the owner's agent key (`fork/kitshn/KitshnPublish.ts`). */
import { OrchestratorMcpFailure, SecretRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as KitshnPublish from "../../../fork/kitshn/KitshnPublish.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    KitshnPublish.KitshnPublish,
  ],
};

const KitshnPublishTool = Tool.make("kitshn_publish", {
  ...shared,
  description:
    "Publish a file or folder of this thread's workspace to kitshn: a .html file becomes a page, another file a file card, a folder a static site without dotfiles and links. The same name updates its card. Without circle the card stays private. The result is {address, card, kind (page, file or folder), updated, revision?}.",
  parameters: KitshnPublish.KitshnPublishInput,
  success: KitshnPublish.KitshnPublishResult,
}).annotate(Tool.Destructive, true);

const KitshnAddressTool = Tool.make("kitshn_address", {
  ...shared,
  description:
    "Give a kitshn page, file or folder site a new address name. The old address redirects. The result is {address, card, kind, revision?}.",
  parameters: KitshnPublish.KitshnAddressInput,
  success: KitshnPublish.KitshnAddressResult,
}).annotate(Tool.Destructive, true);

const KitshnAgentKeyTool = Tool.make("kitshn_agent_key", {
  ...shared,
  description:
    'Read, set or clear the kitshn agent key that kitshn_publish and kitshn_address use. "status" returns {set, server}. "set" takes server and two request_secret refs, for the client id and the client secret of the key\'s Cloudflare Access service token, and spends them. Full-access threads only.',
  parameters: Schema.Struct({
    action: Schema.Literals(["status", "set", "clear"]),
    server: Schema.optional(Schema.String).annotate({ description: "https://kit.<zone>" }),
    clientIdRef: Schema.optional(SecretRef),
    clientSecretRef: Schema.optional(SecretRef),
  }),
  success: KitshnPublish.KitshnKeyStatus,
}).annotate(Tool.Destructive, true);

export const KitshnToolkit = Toolkit.make(KitshnPublishTool, KitshnAddressTool, KitshnAgentKeyTool);
