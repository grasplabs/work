/**
 * `vp run dev`: builds the compiler again whenever what it is built from
 * changes, into the assets the dev server serves. Core's own build runs
 * once, when the server starts; without this a change to `@grasp-os/ui`
 * shows in the frontend, which Vite reloads, but not in App screens,
 * which the compiler goes on checking and building against the kit as it
 * was when the server started.
 *
 * Each build is a process of its own (build.ts), so it builds with the
 * compiler's sources as they are now. It writes the new release next to
 * the old one and the version last; the dev server reloads on the
 * version. A build that fails (a file saved half-written, say) leaves
 * everything as it was and says so.
 */
import { spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const packages = path.join(root, "..");

/** What the kit and the compiler are built from, besides their dependencies. */
const watched = [
  path.join(packages, "ui/src"),
  path.join(packages, "ui/components.json"),
  path.join(packages, "ui/package.json"),
  path.join(packages, "sdk/src"),
  path.join(packages, "shared/src"),
  path.join(root, "src"),
  path.join(root, "build.ts"),
];

/** How long after the last change a build starts: an editor saves in bursts. */
const settleMs = 200;

const [assets, versionModule] = process.argv.slice(2);
if (assets === undefined) {
  throw new Error("Usage: node watch.ts <assets directory> [version module]");
}

let building = false;
let changedSince = false;
let settle: NodeJS.Timeout | undefined;

/** One build at a time; a change during one builds again after it. */
const rebuild = (): void => {
  if (building) {
    changedSince = true;
    return;
  }
  building = true;
  const build = spawn(
    process.execPath,
    [
      path.join(root, "build.ts"),
      assets,
      ...(versionModule === undefined ? [] : [versionModule]),
    ],
    { stdio: "inherit" }
  );
  build.on("exit", (code) => {
    building = false;
    if (code !== 0) {
      console.error(
        "The screen compiler didn't build: screens keep the kit as it was."
      );
    }
    if (changedSince) {
      changedSince = false;
      rebuild();
    }
  });
};

const changed = (): void => {
  clearTimeout(settle);
  settle = setTimeout(rebuild, settleMs);
};

for (const target of watched.filter((file) => existsSync(file))) {
  watch(target, { recursive: true }, changed);
}
