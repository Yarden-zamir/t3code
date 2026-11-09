import * as NodeModule from "node:module";

const MODULE_ID = "\0fork-undici-require";

/**
 * Fork: a Node single-executable resolves only built-ins through ESM `import`, and undici stays
 * external. Bundled code that imports undici, such as `@effect/platform-node/NodeHttpClient`,
 * gets a module that loads it from disk through createRequire, like `outboundHttp.ts` does.
 */
export function forkUndiciRequirePlugin() {
  const exportNames = Object.keys(NodeModule.createRequire(import.meta.url)("undici")).filter(
    (name) => name !== "default",
  );
  return {
    name: "fork-undici-require",
    // Before the deps plugin, which marks undici external.
    resolveId: {
      order: "pre" as const,
      handler: (id: string) => (id === "undici" ? MODULE_ID : null),
    },
    load: (id: string) =>
      id === MODULE_ID
        ? [
            'import { createRequire } from "node:module";',
            'const undici = createRequire(import.meta.url)("undici");',
            "export default undici;",
            ...exportNames.map((name) => `export const ${name} = undici.${name};`),
          ].join("\n")
        : null,
  };
}
