import { describe, expect, test } from "vite-plus/test";

import { familyNamespaces, sdkNamespaces } from "../src/error-namespaces.ts";
import { expectedNamespaces } from "../src/errors.ts";

// The SDK refuses an App error code in any of the platform's namespaces
// from a list it can carry without loading every error family
// (error-namespaces.ts). This holds the list to the real registry: every
// module in the repository that defines an error family is found by its
// source, loaded, and the namespaces its codes registered must be exactly
// the list, so a new family's namespace can't be missed.

const sources = import.meta.glob(
  ["../../../{apps,packages}/*/src/**/*.ts", "!**/*.d.ts"],
  { query: "?raw", import: "default" }
);
const modules = import.meta.glob([
  "../../../{apps,packages}/*/src/**/*.ts",
  "!**/*.d.ts",
]);

describe("the platform's error namespaces", () => {
  test("are exactly those of every error family in the repository", async () => {
    const defining: string[] = [];
    for (const [path, load] of Object.entries(sources)) {
      // One after the other: thousands of files, read only to find the few.
      // oxlint-disable-next-line no-await-in-loop -- see above
      const source = await load();
      if (typeof source === "string" && source.includes("defineErrorFamily(")) {
        defining.push(path);
      }
    }
    expect(defining.length).toBeGreaterThan(10);
    await Promise.all(
      defining.map(async (path) => {
        const load = modules[path];
        if (load === undefined) {
          throw new Error(`No module for ${path}`);
        }
        await load();
      })
    );
    const registered = [...expectedNamespaces()].toSorted();
    expect({
      families: [...familyNamespaces],
      sdkOverlap: sdkNamespaces.filter((namespace) =>
        registered.includes(namespace)
      ),
    }).toStrictEqual({ families: registered, sdkOverlap: [] });
  });
});
