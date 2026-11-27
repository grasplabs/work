/**
 * Keeps `packages/app-kit` equal to what the registry's CLI installs for
 * the kit's style (`packages/app-kit/components.json`), except the files
 * changed on purpose, which `packages/app-kit/local-changes.json` lists,
 * each with its reason and the test that holds it.
 *
 *   node scripts/app-kit-sync.ts check    every installed file is the CLI's, byte for byte, or listed
 *   node scripts/app-kit-sync.ts update   install every component and the theme again, and pin them
 *
 * `check` reads no network: the pin (`packages/app-kit/registry.json`)
 * holds the SHA-256 of every file the CLI wrote, and the kit's own files
 * where the CLI writes (`own`: what the form shares). It fails for
 * a file that differs and isn't listed, a listed one that no longer
 * differs, a pinned file that is gone and a file that is neither pinned
 * nor the kit's own.
 *
 * `update` runs the CLI that the catalog pins in packages/app-kit itself:
 * `init` (the style's preset, writing the theme into a bare stylesheet),
 * then `add --all --overwrite`. It pins the hash of every file it wrote,
 * then puts back each listed file as it was and writes the registry's new
 * copy beside it as `<file>.registry` for you to carry the change over (or
 * drop the entry when the change is no longer needed), and puts back what
 * the CLI changes outside the kit's sources (package.json, the lockfile,
 * components.json's aliases). Then `vp install`, and review `git diff`.
 * Confirm first that the style is still the registry's default (its CLI
 * docs, `--defaults`), and set `style` and `installed` in the pin.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  localChangesSchema,
  problemsOf,
  registryPinSchema,
  sha256,
} from "./app-kit-sync-lib.ts";
import type { RegistryPin } from "./app-kit-sync-lib.ts";

const root = path.resolve(import.meta.dirname, "..");
const kit = path.join(root, "packages", "app-kit");
const pinPath = path.join(kit, "registry.json");
const localChangesPath = path.join(kit, "local-changes.json");

/** The folders the CLI writes to, by path from packages/app-kit. */
const cliFolders = ["src/components", "src/hooks", "src/lib"];
/** What the CLI writes outside those folders. */
const cliFiles = ["src/styles.css"];

const readPin = (): RegistryPin =>
  registryPinSchema.parse(JSON.parse(readFileSync(pinPath, "utf-8")));

const readChanges = () =>
  localChangesSchema.parse(JSON.parse(readFileSync(localChangesPath, "utf-8")));

/** Every file in the CLI's folders and files, by path from packages/app-kit. */
const presentFiles = (): string[] => [
  ...cliFolders.flatMap((folder) =>
    readdirSync(path.join(kit, folder), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(kit, path.join(entry.parentPath, entry.name))
      )
  ),
  ...cliFiles.filter((file) => existsSync(path.join(kit, file))),
];

const readKitFile = (file: string): Uint8Array | undefined => {
  const full = path.join(kit, file);
  return existsSync(full) ? readFileSync(full) : undefined;
};

const check = (): boolean => {
  const pin = readPin();
  const problems = problemsOf(pin, readChanges(), readKitFile, presentFiles());
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length === 0) {
    console.info(
      `packages/app-kit is the registry's ${pin.style} (CLI ${pin.cli}), but for the files local-changes.json lists.`
    );
  }
  return problems.length === 0;
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: kit, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
};

const update = (): boolean => {
  const pin = readPin();
  const changes = readChanges();
  // Every file the CLI may write, as it is: all of it goes back if the
  // install fails, and the listed files go back once it is done.
  const before = new Map(
    presentFiles().map((file) => [file, readFileSync(path.join(kit, file))])
  );
  const outside = ["package.json", "components.json"].map((file) => ({
    file,
    bytes: readFileSync(path.join(kit, file)),
  }));
  const lockfile = path.join(root, "pnpm-lock.yaml");
  const lock = readFileSync(lockfile);
  const preset = pin.style.replace(/^base-/u, "");
  const cli = path.join(kit, "node_modules", ".bin", "shadcn");
  let installed = false;
  try {
    writeFileSync(path.join(kit, "src/styles.css"), '@import "tailwindcss";\n');
    run(cli, [
      "init",
      "--preset",
      preset,
      "--base",
      "base",
      "--force",
      "--no-reinstall",
      "--yes",
    ]);
    // init points the `ui` alias at a folder of its own; the kit's are flat.
    writeFileSync(path.join(kit, "components.json"), outside[1]?.bytes ?? "");
    run(cli, ["add", "--all", "--overwrite", "--yes"]);
    const files = Object.fromEntries(
      presentFiles()
        .filter((file) => !pin.own.includes(file))
        .toSorted()
        .map((file) => [file, sha256(readFileSync(path.join(kit, file)))])
    );
    writeFileSync(pinPath, `${JSON.stringify({ ...pin, files }, null, 2)}\n`);
    for (const { path: file } of changes) {
      const full = path.join(kit, file);
      copyFileSync(full, `${full}.registry`);
      console.info(
        `Carry ${file}'s change over to ${file}.registry, then delete it.`
      );
    }
    installed = true;
  } finally {
    const restored = installed
      ? changes.map((change) => change.path)
      : [...before.keys()];
    for (const file of restored) {
      const bytes = before.get(file);
      if (bytes !== undefined) {
        writeFileSync(path.join(kit, file), bytes);
      }
    }
    for (const { file, bytes } of outside) {
      writeFileSync(path.join(kit, file), bytes);
    }
    writeFileSync(lockfile, lock);
    rmSync(path.join(kit, "node_modules", ".vite"), {
      recursive: true,
      force: true,
    });
  }
  console.info(
    "Run `vp install`, review `git diff`, then `vp run check:app-kit`."
  );
  return true;
};

const [command] = process.argv.slice(2);
const ok = command === "update" ? update() : command === "check" && check();
if (command !== "update" && command !== "check") {
  console.error("Usage: node scripts/app-kit-sync.ts check|update");
}
process.exitCode = ok ? 0 : 1;
