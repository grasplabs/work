import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { connectorBuilder } from "./build-connectors.ts";
import type { ConnectorFiles } from "./src/connector.ts";

// The compiler's `connector` target, as connect's build runs it in Node
// and core in the package builder's isolate: a connector's own files in,
// one ES module out. The ways it can go wrong first: a connector importing
// a package, Node's or the runtime's own modules, the runtime past the
// SDK, a file outside its folder, or code from a URL, any of which would
// run in its isolate unreviewed.

const entry = "src/index.ts";

const connector = `import { defineConnector } from "@grasp-os/sdk/connector";
import { title } from "./title.ts";

export default defineConnector({
  name: "tracker",
  title,
  mcp: { url: "https://mcp.tracker.test/mcp", registration: "dcr" },
});
`;

/** A connector's folder of `files`, by path, with `src/index.ts` its entry. */
const folder = (files: Record<string, string>): ConnectorFiles => ({
  entry,
  read: (file) => (Object.hasOwn(files, file) ? files[file] : undefined),
});

const ownFiles = {
  "src/title.ts": 'export const title: string = "Tracker";\n',
  "outside.ts": "export {};\n",
};

const isModule = (
  value: unknown
): value is { default: { fetch: (request: Request) => Promise<Response> } } =>
  typeof value === "object" && value !== null && "default" in value;

describe("a connector's build", () => {
  it("is one module of the SDK and its own files, whose server answers its manifest, and refuses every other import", async () => {
    const build = await connectorBuilder();
    const built = await build(folder({ [entry]: connector, ...ownFiles }));
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), "connector-")),
      "connector.mjs"
    );
    writeFileSync(file, built.ok ? built.code : "");
    const loaded: unknown = await import(pathToFileURL(file).href);
    const answer = isModule(loaded)
      ? await loaded.default.fetch(
          new Request("https://connector.internal/mcp", {
            method: "POST",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "grasp-os/manifest",
              params: {},
            }),
          })
        )
      : undefined;
    const imports = [
      "zod",
      "node:fs",
      "cloudflare:workers",
      "@grasp-os/runtime/connector",
      "../../outside.ts",
      "/outside.ts",
      "https://code.example.test/code.js",
      "./missing.ts",
    ];
    const refused: Record<string, boolean | "built"> = {};
    for (const source of imports) {
      // oxlint-disable-next-line no-await-in-loop -- one build at a time
      const each = await build(
        folder({ [entry]: `import "${source}";\n${connector}`, ...ownFiles })
      );
      refused[source] = each.ok
        ? "built"
        : each.refusals.some((text) => text.includes("nothing else"));
    }
    expect({
      built: built.ok,
      manifest: await answer?.json(),
      refused,
    }).toMatchObject({
      built: true,
      manifest: {
        result: {
          name: "tracker",
          title: "Tracker",
          mcp: { url: "https://mcp.tracker.test/mcp", registration: "dcr" },
          actions: {},
        },
      },
      refused: Object.fromEntries(imports.map((source) => [source, true])),
    });
  });

  it("refuses a module that imports what it computes as it runs, or that esbuild only warns of", async () => {
    const build = await connectorBuilder();
    const computed = await build(
      folder({
        [entry]: `${connector}Reflect.set(globalThis, "load", (name: string) => import(name));\n`,
        ...ownFiles,
      })
    );
    const warned = await build(
      folder({
        [entry]: `${connector}export const twice = { key: 1, key: 2 };\n`,
        ...ownFiles,
      })
    );
    expect({
      computed: computed.ok ? "built" : computed.refusals,
      warned: warned.ok ? "built" : warned.refusals,
    }).toStrictEqual({
      computed: [
        "It imports a module as it runs: a connector imports nothing but the SDK and its own files, as it is built.",
      ],
      warned: ['Duplicate key "key" in object literal'],
    });
  });
});
