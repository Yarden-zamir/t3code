/** Fork: kitshn publishing through the machine's kitshn daemon (`fork/kitshn/KitshnPublish.ts`). */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
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
    'Publish a file or folder of this thread\'s workspace to kitshn: a .html file becomes a page, another file a file card, a folder a static site without dotfiles and links. Path "." is the whole workspace; prefer a build folder. The same name updates its card; circle, public, address and zone apply only to its first publish. Without circle the card stays private. Runs as this thread through the kitshn daemon of this machine. Full-access threads only. When kitshn asks for an approval, the call waits 60 seconds, then returns {outcome "waiting", proposalId, message}: follow the message. Else the result is {address, card, kind (page, file or folder), updated, revision?}.',
  parameters: KitshnPublish.KitshnPublishInput,
  success: KitshnPublish.KitshnPublishAnswer,
}).annotate(Tool.Destructive, true);

const KitshnAddressTool = Tool.make("kitshn_address", {
  ...shared,
  description:
    'Give a kitshn page, file or folder site a new address name. The old address redirects. Runs like kitshn_publish, with the same outcome "waiting". Full-access threads only. The result is {address, card, kind, revision?}.',
  parameters: KitshnPublish.KitshnAddressInput,
  success: KitshnPublish.KitshnAddressAnswer,
}).annotate(Tool.Destructive, true);

export const KitshnToolkit = Toolkit.make(KitshnPublishTool, KitshnAddressTool);
