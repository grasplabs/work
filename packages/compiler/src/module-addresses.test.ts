import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { addressModules } from "./module-addresses.ts";
import type { AddressedModules } from "./module-addresses.ts";

// An App's page modules at the addresses of their content: written to
// a directory under those addresses and imported from it with Node's own
// module loader, as a frame imports them from core. What can go wrong: a
// changed module leaves an importer at its old address (the frame keeps
// running the old code), or moves a module that didn't change (the frame
// loads it again); modules importing each other in a cycle get no
// address; a string that merely spells a module's name is rewritten; a
// kit module's name is touched; and the same modules get other addresses.

/** Modules as the compiler emits them: ES modules, importing by flat name. */
const modules = {
  "app~src~routes~desk.js": `import { label } from "app~src~components~label.js";
import { ping } from "app~src~components~ping.js";
import { basename } from "node:path";
export default async () => {
  const later = await import("app~src~components~later.js");
  return [label(), ping(), later.default, basename("/a/b"), "app~src~components~label.js"];
};`,
  "app~src~components~label.js": `import shared from "app~src~components~shared.js";
export const label = () => "Desk " + shared.id;`,
  "app~src~components~shared.js": "export default { id: 7 };",
  // Two modules importing each other.
  "app~src~components~ping.js": `import { pong } from "app~src~components~pong.js";
export const ping = () => "ping " + pong();
export const name = () => "ping";`,
  "app~src~components~pong.js": `import { name } from "app~src~components~ping.js";
export const pong = () => "pong of " + name();`,
  "app~src~components~later.js": `export default "later";`,
};

const desk = "app~src~routes~desk.js";

/** What the test's page module exports: a function to run. */
const isPage = (value: unknown): value is () => Promise<unknown> =>
  typeof value === "function";

/** What the desk page answers, its modules written at their addresses. */
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
  const page: unknown =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  return isPage(page) ? await page() : page;
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
      "app~src~components~label.js",
    ]);
  });

  it("move a changed module and every module importing it, up to its page, and nothing else", async () => {
    const before = await addressModules(modules);
    const after = await addressModules({
      ...modules,
      "app~src~components~shared.js": "export default { id: 8 };",
    });
    const cycle = await addressModules({
      ...modules,
      "app~src~components~pong.js": `import { name } from "app~src~components~ping.js";
export const pong = () => "pong to " + name();`,
    });
    expect({
      leaf: moved(before, after),
      cycle: moved(before, cycle),
      runs: await ran(after),
    }).toStrictEqual({
      leaf: [
        "app~src~components~label.js",
        "app~src~components~shared.js",
        "app~src~routes~desk.js",
      ],
      cycle: [
        "app~src~components~ping.js",
        "app~src~components~pong.js",
        "app~src~routes~desk.js",
      ],
      runs: [
        "Desk 8",
        "ping pong of ping",
        "later",
        "b",
        "app~src~components~label.js",
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
