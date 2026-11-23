/**
 * Keeps `packages/ui` equal to Damsko (github.com/grasplabs/damsko), whose
 * components it holds as source, installed with the shadcn CLI, except the
 * files changed here on purpose, which `packages/ui/local-changes.json`
 * lists and which go back to Damsko as a pull request there.
 *
 *   node scripts/ui-sync.ts check                 every file is Damsko's, byte for byte, or listed
 *   node scripts/ui-sync.ts update [commit|tag]   install every item again, at the pin or a new one
 *   node scripts/ui-sync.ts propose               the listed changes as a patch for Damsko
 *
 * The pin is `packages/ui/damsko.json`: the commit of Damsko, and the items
 * added by name. A new pin is a commit in full or a release tag (`v0.2.0`,
 * written down as its commit), and only one Damsko merged or released:
 * a commit on its `main` or one a release tag points at. Every command
 * checks that before it reads a file of the commit, so neither a pull
 * request's head nor a fork's commit, which GitHub serves by hash too, can
 * be installed or pass the check. Damsko's git is the durable form of a
 * version: its site serves its `main` as last deployed and each released
 * tag at /r/<tag>/, never a commit between tags. So no command reads the
 * site: each fetches Damsko from GitHub.
 *
 * `check` compares with the commit's own files. Damsko's registry gives
 * every file as it stands in its tree, at the same path under `src/`, and
 * its CI holds an install to that byte for byte (its check-install.ts), so
 * the tree at the commit is what the CLI installs. A font is held as the
 * font: it travels as base64 text, which Damsko's own script, installed
 * beside it, unpacks; the check runs that script's `--check` too. A
 * symbolic link fails, and is never followed.
 *
 * `update` builds the registry from that commit as Damsko does
 * (`pnpm install`, then its scripts/registry-dist.ts), serves it on
 * 127.0.0.1 and adds every item with `shadcn add --overwrite`, all at
 * once, into an empty folder of its own: what Damsko dropped goes, too.
 * There it unpacks the fonts, carries each listed change to the new
 * version (dropped once Damsko's file is the same, else applied again on
 * top, or left with git's conflict markers to resolve by hand) and checks
 * the result. Only then does the new `src/` take the place of
 * `packages/ui/src`; on any failure before, `packages/ui` is as it was.
 * Review `git diff` after it; never `shadcn add --all`, which reads
 * shadcn's own registry.
 *
 * Owned source, by hand:
 *   1. Edit, add or remove a file under packages/ui/src (not a font).
 *   2. List it in packages/ui/local-changes.json: `path` (from
 *      packages/ui), a one-line `reason`, `since` (the day, YYYY-MM-DD).
 *   3. `vp run ui:propose`, open Damsko's pull request with the commands
 *      it prints, and add its address to the entry as `pullRequest`.
 *   4. Once it merges, `vp run ui:update <commit>`: each entry is dropped,
 *      kept, applied again on top, or left in conflict (markers `here`,
 *      `pinned`, `Damsko`; resolve them and run `vp run check:ui`).
 * `check` fails for a listed file that no longer differs or never
 * existed, and for a date after today; it names an entry older than 14
 * days without failing.
 *
 * `propose` writes the listed changes as one patch against Damsko's tree
 * at the pin and prints the commands that open the pull request there. It
 * pushes and opens nothing itself.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { z } from "zod";

import {
  damskoPath,
  differences,
  expectedOf,
  fetchDamsko,
  fontsUnpack,
  namespace,
  overdue,
  parseRegistry,
  pinSchema,
  proposal,
  readLocalChanges,
  readWithin,
  treeOf,
  updateTree,
} from "./ui-sync-lib.ts";
import type { DamskoAt, LocalChange, Pin } from "./ui-sync-lib.ts";

const damskoRepository = "https://github.com/grasplabs/damsko.git";
const root = path.resolve(import.meta.dirname, "..");
const ui = path.join(root, "packages", "ui");
const pinPath = path.join(ui, "damsko.json");
const localChangesPath = path.join(ui, "local-changes.json");

const run = async (
  command: string,
  args: readonly string[],
  cwd: string,
  quiet = false
): Promise<string> => {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(child.exitCode)}.${output === "" ? "" : `\n${output.trim()}`}`
    );
  }
  return output;
};

/** Damsko at a pin: its checkout, and what the pinned items install. */
const damskoAt = (checkout: string, pin: Pin): DamskoAt => {
  const registry = readWithin(checkout, "registry.json");
  if (registry === undefined) {
    throw new Error(`Damsko at ${pin.commit} has no registry.json.`);
  }
  return {
    root: checkout,
    expected: expectedOf(
      parseRegistry(new TextDecoder().decode(registry)),
      pin.items
    ),
  };
};

const dependencies = (): Record<string, string> =>
  z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(path.join(ui, "package.json"), "utf-8")))
    .dependencies;

/** Damsko's file at a pin, by its path there; it must have it. */
const damskoFile =
  (damsko: DamskoAt) =>
  (file: string): Uint8Array => {
    const content = readWithin(damsko.root, file);
    if (content === undefined) {
      throw new Error(`Damsko's registry names ${file}, which its tree lacks.`);
    }
    return content;
  };

/**
 * What check:ui finds: the differences, then Damsko's own check of its
 * fonts (none still packed, every file its stylesheets name there, each
 * the font its checksum names), as one more line where it fails.
 */
const check = async (
  damsko: DamskoAt,
  local: readonly LocalChange[]
): Promise<string[]> => {
  const found = differences(
    damsko.expected,
    damskoFile(damsko),
    { ...treeOf(ui), dependencies: dependencies() },
    local
  );
  const unpack = readWithin(ui, fontsUnpack);
  if (found.length === 0 && unpack !== undefined) {
    try {
      await run("node", [fontsUnpack, "--check"], ui, true);
    } catch (error) {
      found.push(error instanceof Error ? error.message : String(error));
    }
  }
  return found;
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

/**
 * Every pinned item, installed by the CLI into `stage` from the registry
 * built at the new pin, its fonts unpacked. The stage stands for
 * `packages/ui` with what the CLI reads beside it: the package's
 * manifest, TypeScript settings and components.json (naming the local
 * registry), the workspace's TypeScript base and a workspace file, by
 * which the CLI resolves the package's own name.
 */
const installInto =
  (pin: Pin, damsko: string) =>
  async (stage: string): Promise<void> => {
    const site = path.join(path.dirname(damsko), "site");
    await run("pnpm", ["install", "--frozen-lockfile"], damsko);
    await run("node", ["scripts/registry-dist.ts", site], damsko);
    const workspace = path.dirname(path.dirname(stage));
    copyFileSync(
      path.join(root, "tsconfig.base.json"),
      path.join(workspace, "tsconfig.base.json")
    );
    writeFileSync(
      path.join(workspace, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n"
    );
    for (const file of ["package.json", "tsconfig.json"]) {
      copyFileSync(path.join(ui, file), path.join(stage, file));
    }
    const served = await serve(site);
    try {
      const components = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(readFileSync(path.join(ui, "components.json"), "utf-8"))
        );
      writeFileSync(
        path.join(stage, "components.json"),
        JSON.stringify({
          ...components,
          registries: { [namespace]: `${served.url}/r/{name}.json` },
        })
      );
      // The CLI as this repository pins it, writing into the stage.
      await run(
        path.join(ui, "node_modules", ".bin", "shadcn"),
        [
          "add",
          ...pin.items.map((item) => `${namespace}/${item}`),
          "--overwrite",
          "--yes",
        ],
        stage
      );
    } finally {
      served.close();
    }
  };

/** The listed changes as one patch against Damsko's tree at the pin. */
const propose = (
  pin: Pin,
  damsko: DamskoAt,
  local: readonly LocalChange[]
): void => {
  if (local.length === 0) {
    console.log("packages/ui/local-changes.json lists no change to propose.");
    return;
  }
  const patch = proposal(
    damsko.root,
    new Map(
      local.map(({ path: file }) => [
        damskoPath(damsko.expected, file),
        readWithin(ui, file),
      ])
    )
  );
  // In a folder of its own, which no one else can have made beforehand.
  const out = path.join(
    mkdtempSync(path.join(tmpdir(), "damsko-proposal-")),
    `local-changes-${pin.commit.slice(0, 8)}.patch`
  );
  writeFileSync(out, patch);
  console.log(
    [
      `Wrote ${out}: ${local.length} listed ${local.length === 1 ? "change" : "changes"} against Damsko at ${pin.commit}.`,
      "",
      "In a checkout of github.com/grasplabs/damsko:",
      "",
      "  git fetch origin",
      "  git switch --create fix/<what-it-changes> origin/main",
      `  git apply --3way ${out}`,
      "  git add --all",
      '  git commit --message "fix(<component>): <what and why>"',
      "  git push --set-upstream origin HEAD",
      "  gh pr create --fill",
      "",
      "Then put the pull request's address in packages/ui/local-changes.json, as pullRequest.",
    ].join("\n")
  );
};

const main = async (): Promise<boolean> => {
  const [command, target] = process.argv.slice(2);
  if (command !== "check" && command !== "update" && command !== "propose") {
    throw new Error(
      "Usage: node scripts/ui-sync.ts check | update [commit|tag] | propose"
    );
  }
  const pinText = readFileSync(pinPath, "utf-8");
  const kept = pinSchema.parse(JSON.parse(pinText));
  const local = readLocalChanges(localChangesPath);
  const scratch = mkdtempSync(path.join(tmpdir(), "damsko-"));
  try {
    const checkout = path.join(scratch, "damsko");
    const commit = fetchDamsko(
      damskoRepository,
      command === "update" && target !== undefined ? target : kept.commit,
      checkout
    );
    const pin: Pin = { ...kept, commit };
    const damsko = damskoAt(checkout, pin);
    if (command === "propose") {
      propose(pin, damsko, local);
      return true;
    }
    let listed = local;
    let conflicts: readonly string[] = [];
    if (command === "update") {
      let was = damsko;
      if (commit !== kept.commit) {
        const pinned = path.join(scratch, "pinned");
        fetchDamsko(damskoRepository, kept.commit, pinned);
        was = damskoAt(pinned, kept);
      }
      const updated = await updateTree({
        ui,
        install: async (stage) => {
          await installInto(pin, checkout)(stage);
          if (existsSync(path.join(stage, fontsUnpack))) {
            await run("node", [fontsUnpack], stage);
          }
        },
        was,
        now: damsko,
        local,
        // The commit alone changes, so the file keeps its formatting.
        pin: pinText.replace(kept.commit, commit),
        dependencies: dependencies(),
      });
      for (const file of updated.dropped) {
        console.log(`${file}: Damsko's is now the same; its entry is dropped.`);
      }
      ({ conflicts } = updated);
      listed = readLocalChanges(localChangesPath);
    }
    const found = await check(damsko, listed);
    for (const warning of overdue(listed, new Date())) {
      console.warn(`packages/ui: ${warning}`);
    }
    for (const file of conflicts) {
      console.error(
        `packages/ui: ${file} is a listed change that conflicts with Damsko's at ${commit}: resolve git's markers in it by hand.`
      );
    }
    if (found.length > 0) {
      for (const difference of found) {
        console.error(`packages/ui: ${difference}`);
      }
      console.error(
        `\npackages/ui is not Damsko's at ${commit}. List a change made here on purpose in packages/ui/local-changes.json, or restore Damsko's files with vp run ui:update.`
      );
    }
    if (found.length > 0 || conflicts.length > 0) {
      return false;
    }
    const changed =
      listed.length > 0
        ? `, but the ${listed.length} listed in local-changes.json,`
        : "";
    console.log(
      `packages/ui: ${pin.items.join(", ")} and what they build on${changed} byte for byte Damsko's at ${commit}.`
    );
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

try {
  if (!(await main())) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    `packages/ui: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
