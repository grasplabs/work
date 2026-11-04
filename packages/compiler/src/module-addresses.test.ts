import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { addressModules } from "./module-addresses.ts";
import type { AddressedModules } from "./module-addresses.ts";

// An App's screen modules at the addresses of their content: written to
// a directory under those addresses and imported from it with Node's own
// module loader, as a frame imports them from core. What can go wrong: a
// changed module leaves an importer at its old address (the frame keeps
// running the old code), or moves a module that didn't change (the frame
// loads it again); modules importing each other in a cycle get no
// address; a string that merely spells a module's name is rewritten; a
// kit module's name is touched; and the same modules get other addresses.

/** Modules as the compiler emits them: ES modules, importing by flat name. */
const modules = {
  "app~screens~desk.js": `import { label } from "app~components~label.js";
import { ping } from "app~components~ping.js";
import { basename } from "node:path";
export default async () => {
  const later = await import("app~components~later.js");
  return [label(), ping(), later.default, basename("/a/b"), "app~components~label.js"];
};`,
  "app~components~label.js": `import shared from "app~components~shared.js";
export const label = () => "Desk " + shared.id;`,
  "app~components~shared.js": "export default { id: 7 };",
  // Two modules importing each other.
  "app~components~ping.js": `import { pong } from "app~components~pong.js";
export const ping = () => "ping " + pong();
export const name = () => "ping";`,
  "app~components~pong.js": `import { name } from "app~components~ping.js";
export const pong = () => "pong of " + name();`,
  "app~components~later.js": `export default "later";`,
};

const desk = "app~screens~desk.js";

/** What the test's screen module exports: a function to run. */
const isScreen = (value: unknown): value is () => Promise<unknown> =>
  typeof value === "function";

/** What the desk screen answers, its modules written at their addresses. */
const ran = async ({
  modules: code,
  addresses,
}: AddressedModules): Promise<unknown> => {
  const directory = await mkdtemp(path.join(tmpdir(), "module-addresses-"));
  await Promise.all(
    Object.entries(code).map(async ([name, text]) => {
      await writeFile(path.join(directory, `${addresses[name]}.js`), text);
    })
  );
  const entry = path.join(directory, `${addresses[desk]}.js`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const screen: unknown =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  return isScreen(screen) ? await screen() : screen;
};

/** The names of the modules whose address differs between `one` and `other`. */
const moved = (one: AddressedModules, other: AddressedModules): string[] =>
  Object.keys(one.addresses)
    .filter((name) => one.addresses[name] !== other.addresses[name])
    .toSorted();

describe("an App's modules at their addresses", () => {
  it("run as modules importing each other by address, cycles and dynamic imports included, kit imports and strings as they were", async () => {
    const addressed = await addressModules(modules);
    await expect(ran(addressed)).resolves.toStrictEqual([
      "Desk 7",
      "ping pong of ping",
      "later",
      "b",
      "app~components~label.js",
    ]);
  });

  it("move a changed module and every module importing it, up to its screen, and nothing else", async () => {
    const before = await addressModules(modules);
    const after = await addressModules({
      ...modules,
      "app~components~shared.js": "export default { id: 8 };",
    });
    const cycle = await addressModules({
      ...modules,
      "app~components~pong.js": `import { name } from "app~components~ping.js";
export const pong = () => "pong to " + name();`,
    });
    expect({
      leaf: moved(before, after),
      cycle: moved(before, cycle),
      runs: await ran(after),
    }).toStrictEqual({
      leaf: [
        "app~components~label.js",
        "app~components~shared.js",
        "app~screens~desk.js",
      ],
      cycle: [
        "app~components~ping.js",
        "app~components~pong.js",
        "app~screens~desk.js",
      ],
      runs: [
        "Desk 8",
        "ping pong of ping",
        "later",
        "b",
        "app~components~label.js",
      ],
    });
  });

  it("give the same modules the same addresses and code, whatever their order", async () => {
    const reversed = Object.fromEntries(Object.entries(modules).toReversed());
    await expect(addressModules(reversed)).resolves.toStrictEqual(
      await addressModules(modules)
    );
  });
});
