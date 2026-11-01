/**
 * Fork: machine map, the route of `t3 machine exec` (MM-1919). The `/mcp` credentials open it: the
 * MCP credential of an agent's thread or of the CLI on this machine. `MachineExec.stream` refuses
 * other machines; the command runs through kitshn (K-722).
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { MACHINE_EXEC_STREAM_PATH } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { execSocket } from "./machineExecStream.ts";
import * as MachineExec from "./MachineExec.ts";

// Request middleware owns tracing, including long-lived WebSocket sessions.
const makeHandler = (
  machineExec: MachineExec.MachineExec["Service"],
  services: Context.Context<ThreadManagement.ThreadManagementService>,
) =>
  Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
    if (request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.text("Upgrade Required", { status: 426 });
    }
    // The bytes that wait in the TCP socket under the WebSocket: the backpressure of the stream.
    const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      execSocket(socket, () => transport.writableLength).pipe(Effect.flatMap(machineExec.stream)),
    ).pipe(Effect.provideContext(services), Effect.ignore);
    return HttpServerResponse.empty();
  });

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const machineExec = yield* MachineExec.MachineExec;
    const services = yield* Effect.context<ThreadManagement.ThreadManagementService>();
    yield* router.add("GET", MACHINE_EXEC_STREAM_PATH, makeHandler(machineExec, services));
  }),
).pipe(Layer.provide(McpHttpServer.layerMcpAuthMiddleware));
