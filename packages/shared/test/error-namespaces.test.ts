import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vite-plus/test";

import { familyNamespaces, sdkNamespaces } from "../src/error-namespaces.ts";
import { expectedNamespaces } from "../src/errors.ts";

// The SDK refuses an App error code in any of the platform's namespaces
// from a list it can carry without loading every error family
// (error-namespaces.ts). This holds the list to the real registry: every
// module in the repository that defines an error family is found by its
// source, loaded, and the namespaces its codes registered must be exactly
// the list, so a new family's namespace can't be missed.
//
// The glob only names the modules; nothing is loaded until the test picks
// the few that define a family. Their sources are read from disk, not
// imported as `?raw`: that would fetch hundreds of modules through Vitest's
// module runner one by one, which a busy machine (CI, with the Worker suites
// alongside) slows past the test's time.
const modules = import.meta.glob([
  "../../../{apps,packages}/*/src/**/*.ts",
  "!**/*.d.ts",
]);

describe("the platform's error namespaces", () => {
  test("are exactly those of every error family in the repository", async () => {
    const read = await Promise.all(
      Object.keys(modules).map(async (path) => ({
        path,
        source: await readFile(new URL(path, import.meta.url), "utf-8"),
      }))
    );
    const defining = read
      .filter(({ source }) => source.includes("defineErrorFamily("))
      .map(({ path }) => path);
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
