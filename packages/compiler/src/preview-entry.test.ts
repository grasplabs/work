import { build } from "esbuild-wasm";
import { describe, expect, it } from "vite-plus/test";

import { previewEntries } from "./preview-entry.ts";
import type { Bundle } from "./preview-entry.ts";

// A preview's App modules bundled into one entry (spec 19.2.1): tested
// on its own, by evaluating the entry as a browser's frame would, as one
// ES module, with esbuild's Node build standing in for the isolate's. A
// module Node has (`node:path`) stands in for a kit module: imported by
// the entry as it is, never inlined. What can go wrong: a module that
// imports another gets a copy, or a stale one; a module evaluates twice;
// a dynamic import reaches outside the entry; a module awaiting at its
// top level is read, by its importer or by two imports at once, before
// its await settles; modules importing each other don't resolve; a
// closure that misses a module or its entry makes an entry anyway; and
// the same modules make different bytes.

const bundle: Bundle = async (options) => await build(options);

/** The entry for screen `entry` alone, as `previewEntries` bundles it. */
const previewEntry = async (
  {
    entry,
    closure: own,
    modules: files,
    kitModules,
  }: {
    entry: string;
    closure: string[];
    modules: Record<string, string>;
    kitModules: string[];
  },
  bundler: Bundle
): Promise<string> => {
  const entries = await previewEntries(
    { screens: { [entry]: { closure: own, kitModules } }, modules: files },
    bundler
  );
  return entries[entry] ?? "";
};

/** The entry's default export, as a frame would import it. */
const evaluated = async (entry: string): Promise<unknown> => {
  const module: unknown = await import(
    `data:text/javascript,${encodeURIComponent(entry)}`
  );
  return typeof module === "object" && module !== null && "default" in module
    ? module.default
    : undefined;
};

/** What the test's screen module exports: a function to run. */
const isScreen = (value: unknown): value is () => Promise<unknown> =>
  typeof value === "function";

/** What the screen of the entry for `modules` answers, run. */
const ran = async (
  modules: Record<string, string>,
  kitModules: string[] = []
): Promise<unknown> => {
  const screen = await evaluated(
    await previewEntry(
      {
        entry: "app~screens~desk.js",
        closure: Object.keys(modules),
        modules,
        kitModules,
      },
      bundle
    )
  );
  return isScreen(screen) ? await screen() : screen;
};

/** Whether `made` made an entry, or why not. */
const refused = async (made: Promise<string>): Promise<string> => {
  try {
    await made;
    return "built";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Modules as the compiler emits them: ES modules, importing by flat name. */
const modules = {
  "app~screens~desk.js": `import { label, count } from "app~components~label.js";
import shared from "app~components~shared.js";
export default async () => {
  const later = await import("app~components~later.js");
  return [label(), count(), shared.id, later.default];
};`,
  "app~components~label.js": `import shared from "app~components~shared.js";
let made = 0;
export const label = () => "Desk " + shared.id;
export const count = () => made;
made += 1;`,
  "app~components~shared.js": `globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;
export default { id: 7 };`,
  "app~components~later.js": `import path, { basename } from "node:path";
export default [basename("/a/later"), path.extname("b.js")].join("");`,
};

const closure = Object.keys(modules);

describe("a preview's entry", () => {
  it("runs its screen with every App module evaluated once, imports and dynamic imports resolved within it", async () => {
    Reflect.set(globalThis, "evaluations", 0);
    const entry = await previewEntry(
      {
        entry: "app~screens~desk.js",
        closure,
        modules,
        kitModules: ["node:path"],
      },
      bundle
    );
    const screen = await evaluated(entry);
    const answer = isScreen(screen) ? await screen() : undefined;
    const evaluations: unknown = Reflect.get(globalThis, "evaluations");

    expect({
      answer,
      evaluations,
      // The same modules make the same bytes, whatever their order.
      same:
        (await previewEntry(
          {
            entry: "app~screens~desk.js",
            closure: closure.toReversed(),
            modules,
            kitModules: ["node:path"],
          },
          bundle
        )) === entry,
    }).toStrictEqual({
      answer: ["Desk 7", 1, 7, "later.js"],
      evaluations: 1,
      same: true,
    });
  });

  it("runs modules that await at their top level, each done before the module importing it runs", async () => {
    await expect(
      ran({
        "app~screens~desk.js": `import { ready } from "app~components~config.js";
export default async () => ready;`,
        "app~components~config.js": `const later = await import("app~components~later.js");
await new Promise((settle) => setTimeout(settle, 5));
export const ready = "Ready " + later.default;`,
        "app~components~later.js": `export default await Promise.resolve("now");`,
      })
    ).resolves.toBe("Ready now");
  });

  it("gives modules imported at once, which import one awaiting module, its settled exports, evaluating it once", async () => {
    Reflect.set(globalThis, "slowEvaluations", 0);
    const answer = await ran({
      "app~screens~desk.js": `export default async () => {
  const [one, other, slow] = await Promise.all([
    import("app~components~one.js"),
    import("app~components~other.js"),
    import("app~components~slow.js"),
  ]);
  return [one.value, other.value, slow.value, globalThis.slowEvaluations];
};`,
      "app~components~one.js": `import { value as slow } from "app~components~slow.js";
export const value = "one " + slow;`,
      "app~components~other.js": `import { value as slow } from "app~components~slow.js";
export const value = "other " + slow;`,
      "app~components~slow.js": `globalThis.slowEvaluations += 1;
await new Promise((settle) => setTimeout(settle, 5));
export const value = "settled";`,
    });

    expect(answer).toStrictEqual([
      "one settled",
      "other settled",
      "settled",
      1,
    ]);
  });

  it("resolves modules that import each other, as ES modules do", async () => {
    await expect(
      ran({
        "app~screens~desk.js": `import { a } from "app~components~a.js";
export default async () => a();`,
        "app~components~a.js": `import { b } from "app~components~b.js";
export const a = () => "a" + b();
export const name = "a";`,
        "app~components~b.js": `import { name } from "app~components~a.js";
export const b = () => "b" + name;`,
      })
    ).resolves.toBe("aba");
  });

  it("bundles each screen's entry in one run, each running its own screen", async () => {
    const entries = await previewEntries(
      {
        screens: {
          "app~screens~desk.js": { closure, kitModules: ["node:path"] },
          "app~screens~side.js": {
            closure: ["app~screens~side.js", "app~components~shared.js"],
            kitModules: [],
          },
        },
        modules: {
          ...modules,
          "app~screens~side.js": `import shared from "app~components~shared.js";
export default async () => "Side " + shared.id;`,
        },
      },
      bundle
    );
    const side = await evaluated(entries["app~screens~side.js"] ?? "");

    expect({
      screens: Object.keys(entries).toSorted(),
      side: isScreen(side) ? await side() : side,
    }).toStrictEqual({
      screens: ["app~screens~desk.js", "app~screens~side.js"],
      side: "Side 7",
    });
  });

  it("refuses a closure without its entry, naming a module it doesn't have, or importing one outside it", async () => {
    expect({
      noEntry: await refused(
        previewEntry(
          { entry: "app~screens~other.js", closure, modules, kitModules: [] },
          bundle
        )
      ),
      missing: await refused(
        previewEntry(
          {
            entry: "app~screens~desk.js",
            closure: [...closure, "app~components~gone.js"],
            modules,
            kitModules: [],
          },
          bundle
        )
      ),
      outside: await refused(
        previewEntry(
          {
            entry: "app~screens~desk.js",
            closure: ["app~screens~desk.js"],
            modules: {
              "app~screens~desk.js": `import elsewhere from "app~components~elsewhere.js";
export default elsewhere;`,
            },
            kitModules: [],
          },
          bundle
        )
      ),
    }).toStrictEqual({
      noEntry:
        "The preview's closure doesn't hold its entry, app~screens~other.js.",
      missing:
        "The preview's closure names app~components~gone.js, which is missing.",
      outside:
        "The preview's entry didn't bundle: The preview has no module app~components~elsewhere.js.",
    });
  });
});
