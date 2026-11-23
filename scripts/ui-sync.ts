/**
 * Keeps `packages/ui` equal to Damsko (github.com/grasplabs/damsko), whose
 * components it holds as source, installed with the shadcn CLI, except the
 * files changed here on purpose, which `packages/ui/local-changes.json`
 * lists and which go back to Damsko as a pull request there.
 *
 *   node scripts/ui-sync.ts check             every file is Damsko's, byte for byte, or listed
 *   node scripts/ui-sync.ts update [commit]   install every item again, at the pin or a new commit
 *   node scripts/ui-sync.ts propose           the listed changes as a patch for Damsko
 *
 * The pin is `packages/ui/damsko.json`: the commit of Damsko, and the items
 * added by name. Damsko's git is the durable form of a version: its site
 * serves its `main` as last deployed and each released tag at /r/<tag>/,
 * never a commit between tags. So no command reads the site: each fetches
 * Damsko at the pinned commit from GitHub.
 *
 * `check` compares with the commit's own files. Damsko's registry gives
 * every file as it stands in its tree, at the same path under `src/`, and
 * its CI holds an install to that byte for byte (its check-install.ts), so
 * the tree at the commit is what the CLI installs. A font is held as the
 * font: it travels as base64 text, which Damsko's own script, installed
 * beside it, unpacks; the check runs that script's `--check` too. A listed
 * file may differ; one that no longer does fails, and one listed for two
 * weeks with no pull request in Damsko is named, without failing.
 *
 * `update` builds the registry from that commit as Damsko does
 * (`pnpm install`, then its scripts/registry-dist.ts), serves it on
 * 127.0.0.1 and adds every item with `shadcn add --overwrite`, all at
 * once, into an emptied `src/`: what Damsko dropped goes, too. Then it
 * unpacks the fonts, and carries each listed change to the new version:
 * dropped once Damsko's file is the same, else applied again on top, or
 * left with git's conflict markers to resolve by hand. For the run alone,
 * components.json names the local registry in place of the site. Review
 * `git diff` after it; never `shadcn add --all`, which reads shadcn's own
 * registry.
 *
 * `propose` writes the listed changes as one patch against Damsko's tree
 * at the pin and prints the commands that open the pull request there. It
 * pushes and opens nothing itself.
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
  carry,
  differences,
  expectedOf,
  fontsUnpack,
  namespace,
  parseRegistry,
  pinSchema,
  readLocalChanges,
  unproposed,
} from "./ui-sync-lib.ts";
import type { Content, Expected, LocalChange, Pin } from "./ui-sync-lib.ts";

const damskoRepository = "https://github.com/grasplabs/damsko.git";
const ui = path.resolve("packages/ui");
const pinPath = path.join(ui, "damsko.json");
const componentsPath = path.join(ui, "components.json");
const localChangesPath = path.join(ui, "local-changes.json");

const run = async (
  command: string,
  args: readonly string[],
  cwd: string,
  output: "inherit" | "capture" = "inherit"
): Promise<string> => {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", output === "capture" ? "pipe" : "inherit", "inherit"],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(child, "close");
  if (child.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${String(child.exitCode)}.`
    );
  }
  return Buffer.concat(chunks).toString("utf-8");
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

/** A file of `packages/ui`, or undefined without one. */
const readOurs = (file: string): Content =>
  existsSync(path.join(ui, file))
    ? readFileSync(path.join(ui, file))
    : undefined;

/** What the pinned items install, from Damsko's tree at its commit. */
const expectedAt = (damsko: string, pin: Pin): Expected =>
  expectedOf(
    parseRegistry(readFileSync(path.join(damsko, "registry.json"), "utf-8")),
    pin.items
  );

/** Damsko's file for one of `packages/ui`: by the registry's map, else at the same path. */
const damskoPath = (expected: Expected, file: string): string =>
  expected.files.get(file) ?? file;

/** Damsko's file in a checkout, or undefined where it has none. */
const readDamsko = (damsko: string, file: string): Content =>
  existsSync(path.join(damsko, file))
    ? readFileSync(path.join(damsko, file))
    : undefined;

const check = (pin: Pin, damsko: string, local: LocalChange[]): string[] => {
  const packages = z.record(z.string(), z.string());
  const manifest = z
    .object({ dependencies: packages, devDependencies: packages })
    .parse(JSON.parse(readFileSync(path.join(ui, "package.json"), "utf-8")));
  return differences(
    expectedAt(damsko, pin),
    (file) => readFileSync(path.join(damsko, file)),
    {
      read: readOurs,
      sources: filesUnder("src"),
      dependencies: { ...manifest.devDependencies, ...manifest.dependencies },
    },
    local
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

const install = async (pin: Pin, damsko: string): Promise<void> => {
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
};

const writeOurs = (file: string, content: Content): void => {
  if (content === undefined) {
    rmSync(path.join(ui, file), { force: true });
  } else {
    writeFileSync(path.join(ui, file), content);
  }
};

/**
 * Installs the pin, then carries each listed change over: the file as it
 * was here, Damsko's at the old pin and at the new one. Returns the paths
 * left in conflict.
 */
const update = async (
  pin: Pin,
  kept: Pin,
  damsko: string,
  local: LocalChange[]
): Promise<string[]> => {
  const ours = new Map(local.map(({ path: file }) => [file, readOurs(file)]));
  let was = damsko;
  if (local.length > 0 && kept.commit !== pin.commit) {
    was = path.join(path.dirname(damsko), "pinned");
    await fetchDamsko(kept.commit, was);
  }
  const wasExpected = local.length > 0 ? expectedAt(was, kept) : undefined;
  await install(pin, damsko);
  if (pin.commit !== kept.commit) {
    writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  }
  if (wasExpected === undefined) {
    return [];
  }
  const nowExpected = expectedAt(damsko, pin);
  const conflicts: string[] = [];
  const remaining = local.filter(({ path: file }) => {
    const carried = carry({
      was: readDamsko(was, damskoPath(wasExpected, file)),
      now: readDamsko(damsko, damskoPath(nowExpected, file)),
      ours: ours.get(file),
    });
    if (carried.kind === "dropped") {
      console.log(`${file}: Damsko's is now the same; its entry is dropped.`);
      return false;
    }
    writeOurs(file, carried.content);
    if (carried.kind === "conflict") {
      conflicts.push(file);
    }
    return true;
  });
  writeFileSync(localChangesPath, `${JSON.stringify(remaining, null, 2)}\n`);
  return conflicts;
};

/** The listed changes as one patch against Damsko's tree at the pin. */
const propose = async (
  pin: Pin,
  damsko: string,
  local: LocalChange[]
): Promise<void> => {
  if (local.length === 0) {
    console.log("packages/ui/local-changes.json lists no change to propose.");
    return;
  }
  const expected = expectedAt(damsko, pin);
  for (const { path: file } of local) {
    const target = path.join(damsko, damskoPath(expected, file));
    const content = readOurs(file);
    if (content === undefined) {
      rmSync(target, { force: true });
    } else {
      writeFileSync(target, content);
    }
  }
  await run("git", ["add", "--all"], damsko);
  const patch = await run(
    "git",
    ["diff", "--cached", "--binary"],
    damsko,
    "capture"
  );
  const out = path.join(
    tmpdir(),
    `damsko-local-changes-${pin.commit.slice(0, 8)}.patch`
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

const [command, commit] = process.argv.slice(2);
if (command !== "check" && command !== "update" && command !== "propose") {
  throw new Error(
    "Usage: node scripts/ui-sync.ts check | update [commit] | propose"
  );
}
const kept = pinSchema.parse(JSON.parse(readFileSync(pinPath, "utf-8")));
const pin =
  command === "update" && commit !== undefined
    ? pinSchema.parse({ ...kept, commit })
    : kept;
const local = readLocalChanges(localChangesPath);

const scratch = mkdtempSync(path.join(tmpdir(), "damsko-"));
try {
  const damsko = path.join(scratch, "damsko");
  await fetchDamsko(pin.commit, damsko);
  if (command === "propose") {
    await propose(pin, damsko, local);
  } else {
    const conflicts =
      command === "update" ? await update(pin, kept, damsko, local) : [];
    const listed =
      command === "update" ? readLocalChanges(localChangesPath) : local;
    const found = check(pin, damsko, listed);
    // Damsko's own check of its fonts: none still packed, and every file
    // its stylesheet names there.
    if (existsSync(path.join(ui, fontsUnpack))) {
      await run("node", [fontsUnpack, "--check"], ui);
    }
    for (const warning of unproposed(listed, new Date())) {
      console.warn(`packages/ui: ${warning}`);
    }
    for (const file of conflicts) {
      console.error(
        `packages/ui: ${file} is a listed change that conflicts with Damsko's at ${pin.commit}: resolve git's markers in it by hand.`
      );
    }
    if (found.length > 0) {
      for (const difference of found) {
        console.error(`packages/ui: ${difference}`);
      }
      console.error(
        `\npackages/ui is not Damsko's at ${pin.commit}. List a change made here on purpose in packages/ui/local-changes.json, or restore Damsko's files with vp run ui:update.`
      );
    }
    if (found.length > 0 || conflicts.length > 0) {
      process.exitCode = 1;
    } else {
      const changed =
        listed.length > 0
          ? `, but the ${listed.length} listed in local-changes.json,`
          : "";
      console.log(
        `packages/ui: ${pin.items.join(", ")} and what they build on${changed} byte for byte Damsko's at ${pin.commit}.`
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
