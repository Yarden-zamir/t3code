import { createRouter, RouterHistory } from "@tanstack/react-router";

import { recordForkMessageHistory } from "./components/chat/forkMessageHistory";
import { routeTree } from "./routeTree.gen";

export function getRouter(history: RouterHistory) {
  const router = createRouter({
    routeTree,
    history,
    context: {},
    defaultPreload: "intent",
  });
  // Fork: Back and Forward return to where the user left each thread entry.
  recordForkMessageHistory(router);
  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
