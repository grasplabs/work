/**
 * Keeps `packages/ui` equal to Damsko (github.com/grasplabs/damsko), whose
 * components it holds as source, installed with the shadcn CLI. A file
 * there changes only in Damsko, then by a sync here; it is never edited in
 * place.
 *
 *   node scripts/ui-sync.ts check             every file is Damsko's, byte for byte
 *   node scripts/ui-sync.ts update [commit]   install every item again, at the pin or a new commit
 *
 * The pin is `packages/ui/damsko.json`: the commit of Damsko, and the items
 * added by name. Damsko's git is the durable form of a version: its site
 * serves its `main` as last deployed, and that one commit under an address
 * of its own, never an older one. So neither command reads the site: both
 * fetch Damsko at the pinned commit from GitHub.
 *
 * `check` compares with the commit's own files. Damsko's registry gives
 * every file as it stands in its tree, at the same path under `src/`, and
 * its CI holds an install to that byte for byte (its check-install.ts), so
 * the tree at the commit is what the CLI installs. A font is held as the
 * font: it travels as base64 text, which Damsko's own script, installed
 * beside it, unpacks; the check runs that script's `--check` too.
 *
 * `update` builds the registry from that commit as Damsko does
 * (`pnpm install`, then its scripts/registry-dist.ts), serves it on
 * 127.0.0.1 and adds every item with `shadcn add --overwrite`, all at
 * once, into an emptied `src/`: what Damsko dropped goes, too. Then it
 * unpacks the fonts. For the run alone, components.json names the local
 * registry in place of the site. Review `git diff` after it; never
 * `shadcn add --all`, which reads shadcn's own registry.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  differences,
  expectedOf,
  fontsUnpack,
  namespace,
  parseRegistry,
  pinSchema,
} from "./ui-sync-lib.ts";
import type { Pin } from "./ui-sync-lib.ts";

const damskoRepository = "https://github.com/grasplabs/damsko.git";
const ui = path.resolve("packages/ui");
const pinPath = path.join(ui, "damsko.json");
const componentsPath = path.join(ui, "components.json");

const run = async (
  command: string,
  args: readonly string[],
  cwd: string
): Promise<void> => {
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(child.exitCode)}.`
    );
  }
};

/** Damsko's tree at a commit, in a folder of its own. */
const fetchDamsko = async (commit: string, into: string): Promise<void> => {
  await run("git", ["init", "--quiet", into], process.cwd());
  await run(
    "git",
    ["fetch", "--quiet", "--depth=1", damskoRepository, commit],
    into
  );
  await run("git", ["checkout", "--quiet", "FETCH_HEAD"], into);
};

/** Every file under a folder, as paths from `packages/ui`. */
const filesUnder = (folder: string): string[] =>
  existsSync(path.join(ui, folder))
    ? readdirSync(path.join(ui, folder), { withFileTypes: true }).flatMap(
        (entry) =>
          entry.isDirectory()
            ? filesUnder(`${folder}/${entry.name}`)
            : [`${folder}/${entry.name}`]
      )
    : [];

const check = (pin: Pin, damsko: string): string[] => {
  const registry = parseRegistry(
    readFileSync(path.join(damsko, "registry.json"), "utf-8")
  );
  const manifest = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(path.join(ui, "package.json"), "utf-8")));
  return differences(
    expectedOf(registry, pin.items),
    (file) => readFileSync(path.join(damsko, file)),
    {
      read: (file) =>
        existsSync(path.join(ui, file))
          ? readFileSync(path.join(ui, file))
          : undefined,
      sources: filesUnder("src"),
      dependencies: manifest.dependencies,
    }
  );
};

/** A folder's files over HTTP on this machine alone, as the site serves the registry. */
const serve = async (
  folder: string
): Promise<{ url: string; close: () => void }> => {
  const server = createServer((request, response) => {
    const file = path.join(
      folder,
      path.normalize(new URL(request.url ?? "/", "http://localhost").pathname)
    );
    if (!(file.startsWith(folder + path.sep) && existsSync(file))) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(readFileSync(file));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The registry's server has no port.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.close();
    },
  };
};

const update = async (pin: Pin, damsko: string): Promise<void> => {
  const site = path.join(path.dirname(damsko), "site");
  await run("pnpm", ["install", "--frozen-lockfile"], damsko);
  await run("node", ["scripts/registry-dist.ts", site], damsko);
  const served = await serve(site);
  const components = readFileSync(componentsPath, "utf-8");
  const local: unknown = {
    ...z.record(z.string(), z.unknown()).parse(JSON.parse(components)),
    registries: { [namespace]: `${served.url}/r/{name}.json` },
  };
  try {
    writeFileSync(componentsPath, JSON.stringify(local));
    rmSync(path.join(ui, "src"), { recursive: true, force: true });
    await run(
      "pnpm",
      [
        "exec",
        "shadcn",
        "add",
        ...pin.items.map((item) => `${namespace}/${item}`),
        "--overwrite",
        "--yes",
      ],
      ui
    );
    if (existsSync(path.join(ui, fontsUnpack))) {
      await run("node", [fontsUnpack], ui);
    }
  } finally {
    writeFileSync(componentsPath, components);
    served.close();
  }
  writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
};

const [command, commit] = process.argv.slice(2);
if (command !== "check" && command !== "update") {
  throw new Error("Usage: node scripts/ui-sync.ts check | update [commit]");
}
const kept = pinSchema.parse(JSON.parse(readFileSync(pinPath, "utf-8")));
const pin =
  command === "update" && commit !== undefined
    ? pinSchema.parse({ ...kept, commit })
    : kept;

const scratch = mkdtempSync(path.join(tmpdir(), "damsko-"));
try {
  const damsko = path.join(scratch, "damsko");
  await fetchDamsko(pin.commit, damsko);
  if (command === "update") {
    await update(pin, damsko);
  }
  const found = check(pin, damsko);
  // Damsko's own check of its fonts: none still packed, and every file
  // its stylesheet names there.
  if (existsSync(path.join(ui, fontsUnpack))) {
    await run("node", [fontsUnpack, "--check"], ui);
  }
  if (found.length > 0) {
    for (const difference of found) {
      console.error(`packages/ui: ${difference}`);
    }
    console.error(
      `\npackages/ui is not Damsko's at ${pin.commit}. Change a component in Damsko, then sync: node scripts/ui-sync.ts update <commit>.`
    );
    process.exitCode = 1;
  } else {
    console.log(
      `packages/ui: ${pin.items.join(", ")} and what they build on, byte for byte Damsko's at ${pin.commit}.`
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
