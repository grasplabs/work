import { describe, expect, it } from "vite-plus/test";

import { previewEntry } from "./preview-entry.ts";

// A preview's App modules put together into one entry (spec 19.2.1):
// pure, so tested on its own, by evaluating the entry as a browser's
// frame would, as one ES module. A module Node has (`node:path`) stands
// in for a kit module: imported by the entry as it is, never inlined. What can go wrong: a module that imports
// another gets a copy, or a stale one; a module evaluates twice; a
// dynamic import reaches outside the entry; a closure that misses a
// module or its entry makes an entry anyway; and the same modules make
// different bytes.

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

/** Whether `build` made an entry, or why not. */
const refused = (build: () => string): string => {
  try {
    build();
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
    const entry = previewEntry({
      entry: "app~screens~desk.js",
      closure,
      modules,
      kitModules: ["node:path"],
    });
    const screen = await evaluated(entry);
    const ran = isScreen(screen) ? await screen() : undefined;
    const evaluations: unknown = Reflect.get(globalThis, "evaluations");

    expect({
      ran,
      evaluations,
      // The same modules make the same bytes, whatever their order.
      same:
        previewEntry({
          entry: "app~screens~desk.js",
          closure: closure.toReversed(),
          modules,
          kitModules: ["node:path"],
        }) === entry,
    }).toStrictEqual({
      ran: ["Desk 7", 1, 7, "later.js"],
      evaluations: 1,
      same: true,
    });
  });

  it("runs modules that await at their top level, each done before the module importing it runs", async () => {
    const awaiting = {
      "app~screens~desk.js": `import { ready } from "app~components~config.js";
export default async () => ready;`,
      "app~components~config.js": `const later = await import("app~components~later.js");
await new Promise((settle) => setTimeout(settle, 5));
export const ready = "Ready " + later.default;`,
      "app~components~later.js": `export default await Promise.resolve("now");`,
    };
    const entry = previewEntry({
      entry: "app~screens~desk.js",
      closure: Object.keys(awaiting),
      modules: awaiting,
      kitModules: [],
    });

    const screen = await evaluated(entry);

    await expect(isScreen(screen) ? screen() : screen).resolves.toBe(
      "Ready now"
    );
  });

  it("refuses a closure without its entry, or naming a module it doesn't have", () => {
    expect({
      noEntry: refused(() =>
        previewEntry({
          entry: "app~screens~other.js",
          closure,
          modules,
          kitModules: [],
        })
      ),
      missing: refused(() =>
        previewEntry({
          entry: "app~screens~desk.js",
          closure: [...closure, "app~components~gone.js"],
          modules,
          kitModules: [],
        })
      ),
    }).toStrictEqual({
      noEntry:
        "The preview's closure doesn't hold its entry, app~screens~other.js.",
      missing:
        "The preview's closure names app~components~gone.js, which is missing.",
    });
  });
});
