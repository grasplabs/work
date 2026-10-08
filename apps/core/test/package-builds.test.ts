import { compilerVersion } from "@grasp-os/compiler";
import type {
  DependencyIntent,
  GraspLock,
  PackageBuild,
} from "@grasp-os/shared/packages";
import { graspLockSchema, targetConfigHash } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildDependencies, withPin } from "../src/packages/build.ts";
import { sweepPackageFiles } from "../src/packages/cleanup.ts";
import { mockIdp } from "./idp.ts";
import {
  failure,
  intentFor,
  named,
  noise,
  plain,
  publish,
  refusalsOf,
} from "./npm.ts";
import type { Published } from "./npm.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// Building an App's approved packages (src/packages/build.ts) with
// esbuild-wasm in the package builder's isolate, from its threat model:
// building what nobody approved, Node.js APIs and the platform's React
// where they don't exist, imports a package doesn't declare, remote
// scripts and stylesheets, computed imports, files that could script,
// paths out of a package, artifacts too large, and bytes that change
// under a lock. Packages come from connect's strict fake of the npm
// registry, through the real resolver; the limits are the tests' own
// (vite.config.ts, `PACKAGE_LIMITS`).

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** An App whose package.json resolved to a pending request. */
const resolvedApp = async (
  dependencies: Record<string, string>,
  more: Partial<DependencyIntent> = {}
) => {
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({
    name: `App ${unique()}`,
  });
  const { request, lock } = await builder.api.dependencies.resolve(
    intentFor(app, dependencies, more)
  );
  return { builder, app, request, lock };
};

/** An App whose package.json resolved, and an admin approved its graph. */
const approvedApp = async (
  dependencies: Record<string, string>,
  more: Partial<DependencyIntent> = {}
) => {
  const admin = await personApi("admin");
  await admin.api.dependencies.grantApprover({
    type: "person",
    userId: admin.userId,
  });
  const resolved = await resolvedApp(dependencies, more);
  const { policyGeneration } = await admin.api.dependencies.waiting();
  await admin.api.dependencies.decide(resolved.request.id, {
    approved: true,
    reviewed: { graphHash: resolved.request.graphHash, policyGeneration },
  });
  return resolved;
};

type Resolved = Awaited<ReturnType<typeof resolvedApp>>;

/** Builds `target` of the App's graph, under the policy generation now. */
const buildOf = async (
  { builder, app, request }: Resolved,
  target: PackageBuild["artifact"]["target"]
): Promise<PackageBuild> => {
  const { policyGeneration } = await builder.api.dependencies.status(app);
  return await builder.api.dependencies.build({
    app,
    graphHash: request.graphHash,
    target,
    policyGeneration,
  });
};

/** The App's lock, as core stores it. */
const storedLock = async ({ app, request }: Resolved): Promise<GraspLock> => {
  const row = await env.DB.prepare(
    "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
  )
    .bind(app, request.graphHash)
    .first<{ lock: string }>();
  return graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
};

/** Stores `lock` as the App's, as if core had written it. */
const storeLock = async (
  { app, request }: Resolved,
  lock: GraspLock
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE dependency_locks SET lock = ? WHERE app_id = ? AND graph_hash = ?"
  )
    .bind(JSON.stringify(lock), app, request.graphHash)
    .run();
};

/** The hash of `target`'s config in `lock`, which its pins are keyed by. */
const configOf = async (
  lock: GraspLock,
  target: PackageBuild["artifact"]["target"]
): Promise<string> => {
  const config = lock.targets[target];
  if (config === undefined) {
    throw new Error(`The lock has no ${target} target`);
  }
  return await targetConfigHash(target, config);
};

/** A made-up SHA-256: `char`, 64 times. */
const hashOf = (char: string): string => char.repeat(64);

/** The detail of each `dependency.built` event among `events`. */
const pinsRecorded = (events: Awaited<ReturnType<typeof auditedDuring>>) =>
  events
    .filter(({ action }) => action === "dependency.built")
    .map(({ detail }) => detail);

/** The hash of each pin a `dependency.pin_dropped` event among `events` drops. */
const droppedRecorded = (events: Awaited<ReturnType<typeof auditedDuring>>) =>
  events
    .filter(({ action }) => action === "dependency.pin_dropped")
    .map(({ detail }) => String(detail.hash));

/** A property of a binding, its methods bound to it, for a proxy to pass on. */
const bound = (target: object, property: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
};

/** A file of a kept artifact, as text. */
const artifactText = async (hash: string, path: string): Promise<string> => {
  const file = await env.FILES.get(`package-builds/${hash}/${path}`);
  return (await file?.text()) ?? "";
};

/** A package of ES modules, with `files` beside its package.json. */
const esm = (
  name: string,
  files: Record<string, string>,
  manifest: Record<string, unknown> = {}
): Published => ({
  ...plain(name, "1.0.0", manifest),
  files,
});

/**
 * A badge component: an ES module for the browser that imports the
 * platform's React, a CommonJS helper and a stylesheet with a font and an
 * image; another for Workers; and a Node one neither target reads.
 */
const badgeLibrary = async () => {
  const fmt = named("fmt");
  const ui = named("ui");
  await publish({
    name: fmt,
    version: "1.0.0",
    manifest: { main: "index.js", license: "MIT" },
    files: {
      "index.js":
        "module.exports = { pad: (n) => String(n).padStart(2, '0') };",
    },
  });
  await publish(
    esm(
      ui,
      {
        "browser.js": `import { createElement } from "react";
import fmt from "${fmt}";
import "./styles.css";
export const Badge = ({ n }) => createElement("span", { className: "badge" }, fmt.pad(n));`,
        "worker.js": `import fmt from "${fmt}";
export const badge = (n) => fmt.pad(n);`,
        "node.js": `import { readFileSync } from "fs";
export const badge = () => readFileSync("/etc/hostname", "utf8");`,
        "styles.css": `@font-face { font-family: Badge; src: url("./badge.woff2") format("woff2"); }
.badge { font-family: Badge; background: url(./logo.png) no-repeat; }`,
        "badge.woff2": "wOF2 font bytes",
        "logo.png": "PNG image bytes",
      },
      {
        exports: {
          ".": {
            browser: "./browser.js",
            workerd: "./worker.js",
            default: "./node.js",
          },
        },
        dependencies: { [fmt]: "^1.0.0" },
        peerDependencies: { react: "^19.0.0" },
      }
    )
  );
  return { fmt, ui };
};

describe("building an App's approved packages", () => {
  it("builds the browser target into an ES module, its stylesheet and its assets, importing the platform's React", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp(
      { [ui]: "^1.0.0" },
      { targets: ["browser", "server"] }
    );

    const built = await buildOf(app, "browser");

    const assets = Object.entries(built.artifact.files)
      .filter(([path]) => path.startsWith("assets/"))
      .map(([path, { type }]) => [path.replace(/-[A-Z0-9]+\./u, "."), type]);
    expect({
      entries: built.artifact.entries,
      imports: built.artifact.imports,
      assets: assets.toSorted(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
    }).toStrictEqual({
      entries: {
        [ui]: {
          module: `${ui}.js`,
          css: `${ui}.css`,
          resolved: `${ui}@1.0.0/browser.js`,
        },
      },
      imports: ["react"],
      assets: [
        ["assets/badge.woff2", "font/woff2"],
        ["assets/logo.png", "image/png"],
      ],
    });
    const module = await artifactText(built.hash, `${ui}.js`);
    const css = await artifactText(built.hash, `${ui}.css`);
    // React from the platform, the CommonJS helper bundled in, nothing
    // required at run time, and assets by their place in the artifact.
    expect({
      importsReact: /from\s*"react"/u.test(module),
      requires: /\brequire\(/u.test(module),
      readsFiles: module.includes("readFileSync"),
      cssAssets: [...css.matchAll(/url\((?<url>[^)]+)\)/gu)].map(({ groups }) =>
        groups?.url?.replaceAll('"', "").replace(/-[A-Z0-9]+\./u, ".")
      ),
    }).toStrictEqual({
      importsReact: true,
      requires: false,
      readsFiles: false,
      cssAssets: ["./assets/badge.woff2", "./assets/logo.png"],
    });
  });

  it("resolves each target by its own conditions", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp(
      { [ui]: "^1.0.0" },
      { targets: ["browser", "server"] }
    );
    const browser = await buildOf(app, "browser");
    const server = await buildOf(app, "server");
    expect([
      browser.artifact.entries[ui]?.resolved,
      server.artifact.entries[ui]?.resolved,
      server.artifact.imports,
      server.artifact.entries[ui]?.css,
    ]).toStrictEqual([
      `${ui}@1.0.0/browser.js`,
      `${ui}@1.0.0/worker.js`,
      [],
      null,
    ]);
  });

  it("pins each target config's artifact in the lock, and hands it out again from the pin", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const first = await buildOf(app, "browser");
    const again = await buildOf(app, "browser");
    const lock = await storedLock(app);
    const pinned =
      lock.artifacts?.[compilerVersion]?.[await configOf(lock, "browser")];
    expect({
      pinned: { ...pinned, pinnedAt: typeof pinned?.pinnedAt },
      again: [again.hash, again.stats, again.address === null],
    }).toStrictEqual({
      pinned: {
        target: "browser",
        hash: first.hash,
        exports: { [ui]: `${ui}@1.0.0/browser.js` },
        pinnedAt: "string",
      },
      // Handed out from the pin: nothing built again.
      again: [first.hash, null, false],
    });
  });

  it("measures what the build took", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const { stats } = await buildOf(app, "browser");
    expect({
      measuredMemory: (stats?.wasmMemoryBytes ?? 0) > 0,
      inputFiles: stats?.inputFiles,
    }).toStrictEqual({ measuredMemory: true, inputFiles: 9 });
  });
});

describe("what a build may use", () => {
  it("builds nothing a person didn't approve, nor for a target they didn't", async () => {
    const { ui } = await badgeLibrary();
    const pending = await resolvedApp({ [ui]: "^1.0.0" });
    const approved = await approvedApp({ [ui]: "^1.0.0" });
    const unapproved = await failure(buildOf(pending, "browser"));
    const otherTarget = await failure(buildOf(approved, "server"));
    expect([unapproved.code, otherTarget.code]).toStrictEqual([
      "dependency.approval_required",
      "dependency.approval_required",
    ]);
  });

  it("refuses a lock that no longer is the approved graph", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const lock = { ...app.lock };
    const key = Object.keys(lock.packages)[0] ?? "";
    const changed = {
      ...lock,
      packages: {
        ...lock.packages,
        [key]: { ...lock.packages[key], license: "Proprietary" },
      },
    };
    await env.DB.prepare(
      "UPDATE dependency_locks SET lock = ? WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(JSON.stringify(changed), app.app, app.request.graphHash)
      .run();
    const { code } = await failure(buildOf(app, "browser"));
    expect(code).toBe("dependency.approval_required");
  });
});

describe("what a package's code may reach", () => {
  it("refuses Node.js's built-ins, React on the server and the platform's other entry points, each by name", async () => {
    const fsUser = named("reads-files");
    const cryptoUser = named("hashes");
    const reactUser = named("server-react");
    await publish(
      esm(fsUser, {
        "index.js": 'import { readFile } from "fs"; export { readFile };',
      })
    );
    await publish(
      esm(cryptoUser, {
        "index.js":
          'import { createHash } from "node:crypto"; export { createHash };',
      })
    );
    await publish(
      esm(
        reactUser,
        {
          "index.js":
            'import { renderToString } from "react-dom/server"; export { renderToString };',
        },
        { peerDependencies: { "react-dom": "^19.0.0" } }
      )
    );
    const browser = await approvedApp({
      [fsUser]: "1",
      [cryptoUser]: "1",
      [reactUser]: "1",
    });
    const server = await approvedApp(
      { [reactUser]: "1" },
      { targets: ["server"] }
    );
    const inBrowser = await refusalsOf(buildOf(browser, "browser"));
    expect({
      browser: inBrowser.toSorted(),
      server: await refusalsOf(buildOf(server, "server")),
    }).toStrictEqual({
      browser: [
        `${cryptoUser}@1.0.0 uses Node.js's node:crypto, which isn't available on the browser target`,
        `${fsUser}@1.0.0 uses Node.js's fs, which isn't available on the browser target`,
        `${reactUser}@1.0.0 imports react-dom/server, which the platform doesn't provide`,
      ].toSorted(),
      server: [
        `${reactUser}@1.0.0 imports react-dom/server, which the platform provides only in the browser`,
      ],
    });
  });

  it("takes an npm package named like a built-in when the package depends on it", async () => {
    const polyfill = `buffer-${unique()}`;
    const user = named("uses-buffer");
    await publish(esm(polyfill, { "index.js": "export const Buffer = {};" }));
    await publish(
      esm(
        user,
        { "index.js": `export { Buffer } from "${polyfill}";` },
        { dependencies: { [polyfill]: "1" } }
      )
    );
    const app = await approvedApp({ [user]: "1" });
    const built = await buildOf(app, "browser");
    expect(built.artifact.entries[user]?.module).toBe(`${user}.js`);
  });

  it("takes a package's own browser shim for a built-in, and nothing for one it maps away", async () => {
    const shimmed = named("shimmed");
    await publish(
      esm(
        shimmed,
        {
          "index.js":
            'import { digest } from "crypto"; import "os"; export { digest };',
          "crypto-browser.js": "export const digest = () => 'browser';",
        },
        { browser: { crypto: "./crypto-browser.js", os: false } }
      )
    );
    const app = await approvedApp({ [shimmed]: "1" });
    const built = await buildOf(app, "browser");
    const module = await artifactText(built.hash, `${shimmed}.js`);
    expect(module).toContain("browser");
  });

  it("resolves an imports target that names a package through the package's own dependencies", async () => {
    const helper = named("helper");
    const user = named("uses-helper");
    const sneaky = named("sneaky-helper");
    await publish(esm(helper, { "index.js": "export const h = 'helped';" }));
    await publish(
      esm(
        user,
        { "index.js": 'export { h } from "#helper";' },
        { imports: { "#helper": helper }, dependencies: { [helper]: "1" } }
      )
    );
    await publish(
      esm(
        sneaky,
        { "index.js": 'export { h } from "#helper";' },
        { imports: { "#helper": helper } }
      )
    );
    const ok = await approvedApp({ [user]: "1" });
    const built = await buildOf(ok, "browser");
    const module = await artifactText(built.hash, `${user}.js`);
    // The helper is in the graph, but not one of the package's own.
    const refused = await approvedApp({ [helper]: "1", [sneaky]: "1" });
    expect({
      helped: module.includes("helped"),
      refusals: await refusalsOf(buildOf(refused, "browser")),
    }).toStrictEqual({
      helped: true,
      refusals: [
        `${sneaky}@1.0.0 imports ${helper}, which it doesn't depend on`,
      ],
    });
  });

  it("picks the exports pattern Node picks: the longer prefix, then the longer key", async () => {
    const patterns = named("patterns");
    await publish(
      esm(
        patterns,
        {
          "lib/a.js": "export const from = 'lib';",
          "raw/b.js": "export const from = 'raw';",
        },
        { exports: { "./*": "./lib/*.js", "./*.js": "./raw/*.js" } }
      )
    );
    const app = await approvedApp(
      { [patterns]: "1" },
      { entries: [`${patterns}/a`, `${patterns}/b.js`] }
    );
    const built = await buildOf(app, "browser");
    expect([
      built.artifact.entries[`${patterns}/a`]?.resolved,
      built.artifact.entries[`${patterns}/b.js`]?.resolved,
    ]).toStrictEqual([
      `${patterns}@1.0.0/lib/a.js`,
      `${patterns}@1.0.0/raw/b.js`,
    ]);
  });

  it("puts a bare imports target through the package's browser remaps, to a file or to nothing", async () => {
    const shimmed = named("imports-shim");
    await publish(
      esm(
        shimmed,
        {
          "index.js":
            'import { digest } from "#crypto"; import "#os"; export { digest };',
          "crypto-browser.js": "export const digest = () => 'browser shim';",
        },
        {
          imports: { "#crypto": "crypto", "#os": "os" },
          browser: { crypto: "./crypto-browser.js", os: false },
        }
      )
    );
    const app = await approvedApp({ [shimmed]: "1" });
    const built = await buildOf(app, "browser");
    const module = await artifactText(built.hash, `${shimmed}.js`);
    expect(module).toContain("browser shim");
  });

  it("skips a null fallback in an exports array, and takes a null alone as not exported", async () => {
    const fallback = named("null-fallback");
    const blocked = named("null-blocked");
    await publish(
      esm(
        fallback,
        { "index.js": "export const from = 'fallback';" },
        { exports: { ".": [null, "./index.js"] } }
      )
    );
    await publish(
      esm(
        blocked,
        { "index.js": "export const from = 'blocked';" },
        { exports: { ".": null } }
      )
    );
    const ok = await approvedApp({ [fallback]: "1" });
    const built = await buildOf(ok, "browser");
    const refused = await approvedApp({ [blocked]: "1" });
    expect({
      resolved: built.artifact.entries[fallback]?.resolved,
      refusals: await refusalsOf(buildOf(refused, "browser")),
    }).toStrictEqual({
      resolved: `${fallback}@1.0.0/index.js`,
      refusals: [`${blocked}@1.0.0 doesn't export . for the browser target`],
    });
  });

  it("refuses an import of a package it doesn't depend on, even one in the graph", async () => {
    const shared = named("shared");
    const phantom = named("phantom");
    await publish(esm(shared, { "index.js": "export const x = 1;" }));
    await publish(
      esm(phantom, { "index.js": `export { x } from "${shared}";` })
    );
    const app = await approvedApp({ [shared]: "1", [phantom]: "1" });
    await expect(refusalsOf(buildOf(app, "browser"))).resolves.toStrictEqual([
      `${phantom}@1.0.0 imports ${shared}, which it doesn't depend on`,
    ]);
  });

  it("refuses remote scripts and stylesheets, computed imports, paths out of the package and files that could script", async () => {
    const remoteScript = named("cdn-script");
    const remoteCss = named("cdn-css");
    const computed = named("computed");
    const escapes = named("escapes");
    const svg = named("svg");
    const html = named("html");
    const credentials = ["https://user", "secret@cdn.example/x.js"].join(":");
    await publish(
      esm(remoteScript, {
        "index.js": `import "https://cdn.example/tracker.js"; import "${credentials}"; export {};`,
      })
    );
    await publish(
      esm(remoteCss, {
        "index.js": 'import "./theme.css"; export {};',
        "theme.css":
          '@import "https://fonts.example/font.css"; .x { background: url(https://cdn.example/x.png); }',
      })
    );
    await publish(
      esm(computed, {
        "index.js": "export const load = (name) => import(name);",
      })
    );
    await publish(
      esm(escapes, { "index.js": 'export * from "../../outside/index.js";' })
    );
    await publish(
      esm(svg, {
        "index.js": 'import icon from "./icon.svg"; export { icon };',
        "icon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(1)"></svg>',
      })
    );
    await publish(
      esm(html, {
        "index.js": 'import page from "./page.html"; export { page };',
        "page.html": "<script>alert(1)</script>",
      })
    );
    const app = await approvedApp({
      [remoteScript]: "1",
      [remoteCss]: "1",
      [computed]: "1",
      [escapes]: "1",
      [svg]: "1",
      [html]: "1",
    });
    const refusals = await refusalsOf(buildOf(app, "browser"));
    const about = (name: string) =>
      refusals.filter((refusal) => refusal.includes(name)).length;
    expect({
      remoteScript: about(`${remoteScript}@1.0.0 imports a remote script`),
      remoteCss: about(`${remoteCss}@1.0.0 imports a remote file`),
      computed: about(
        `${computed}@1.0.0/index.js: This "import" expression will not be bundled because the argument is not a string literal`
      ),
      escapes: about(
        `${escapes}@1.0.0 imports ../../outside/index.js, outside itself`
      ),
      svg: about(`${svg}@1.0.0's icon.svg is an SVG with an event handler`),
      html: about(
        `${html}@1.0.0 imports page.html, a kind of file an artifact doesn't carry`
      ),
    }).toStrictEqual({
      remoteScript: 2,
      remoteCss: 2,
      computed: 1,
      escapes: 1,
      svg: 1,
      html: 1,
    });
  });

  it("bundles a literal dynamic import into the artifact, so nothing is loaded at run time", async () => {
    const lazy = named("lazy");
    await publish(
      esm(lazy, {
        "index.js": 'export const load = () => import("./heavy.js");',
        "heavy.js": "export const heavy = 42;",
      })
    );
    const app = await approvedApp({ [lazy]: "1" });
    const built = await buildOf(app, "browser");
    const module = await artifactText(built.hash, `${lazy}.js`);
    expect([module.includes("import("), module.includes("42")]).toStrictEqual([
      false,
      true,
    ]);
  });

  it("refuses a package whose fields for finding its files can't be read, rather than guessing", async () => {
    const badMain = named("bad-main");
    const badDirectory = named("bad-directory");
    const user = named("uses-directory");
    await publish({
      ...esm(badMain, { "index.js": "export const fallback = 1;" }),
      manifest: { main: 5, license: "MIT" },
    });
    await publish(
      esm(badDirectory, {
        "index.js": 'export { x } from "./lib";',
        "lib/package.json": '{ "main": 7 }',
        "lib/index.js": "export const x = 1;",
      })
    );
    await publish(
      esm(
        user,
        { "index.js": `export * from "${badDirectory}";` },
        { dependencies: { [badDirectory]: "1" } }
      )
    );
    const main = await approvedApp({ [badMain]: "1" });
    const directory = await approvedApp({ [user]: "1" });
    await expect(
      Promise.all([
        refusalsOf(buildOf(main, "browser")),
        refusalsOf(buildOf(directory, "browser")),
      ])
    ).resolves.toStrictEqual([
      [`${badMain}@1.0.0: its package.json's main can't be read`],
      [`${badDirectory}@1.0.0 imports ./lib, which it doesn't have`],
    ]);
  });

  it("refuses a package that exports nothing for the target", async () => {
    const cjsOnly = named("cjs-only");
    await publish(
      esm(
        cjsOnly,
        { "index.cjs": "module.exports = 1;" },
        { exports: { ".": { require: "./index.cjs" } } }
      )
    );
    const app = await approvedApp({ [cjsOnly]: "1" });
    await expect(refusalsOf(buildOf(app, "browser"))).resolves.toStrictEqual([
      `${cjsOnly}@1.0.0 doesn't export . for the browser target`,
    ]);
  });

  it("refuses an artifact larger than the limit", async () => {
    const big = named("big");
    await publish(
      esm(big, { "index.js": `export const data = "${noise(300 * 1024)}";` })
    );
    const app = await approvedApp({ [big]: "1" });
    const refusals = await refusalsOf(buildOf(app, "browser"));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(
      /^the browser artifact is \d+ bytes, more than the 262144 an artifact may be$/u
    );
  });
});

describe("what an artifact may carry", () => {
  it("refuses a stylesheet whose image-set strings load from outside the artifact", async () => {
    const sets = named("image-sets");
    await publish(
      esm(sets, {
        "index.js": 'import "./theme.css"; export {};',
        "theme.css": `.a { background: image-set("https://cdn.example/a.png" 1x); }
.b { background: -webkit-image-set('https://cdn.example/b.png' 2x); }`,
      })
    );
    const app = await approvedApp({ [sets]: "1" });
    const refusals = await refusalsOf(buildOf(app, "browser"));
    expect(refusals.toSorted()).toStrictEqual(
      [
        `the stylesheet ${sets}.css loads https://cdn.example/a.png, outside the artifact`,
        `the stylesheet ${sets}.css loads https://cdn.example/b.png, outside the artifact`,
      ].toSorted()
    );
  });

  it("keeps a stylesheet's references to its own document, and refuses an SVG that hides a script under a prefix", async () => {
    const masked = named("masked");
    const sneaky = named("sneaky-svg");
    await publish(
      esm(masked, {
        "index.js": 'import "./mask.css"; export {};',
        "mask.css": ".m { mask: url(#clip); }",
      })
    );
    await publish(
      esm(sneaky, {
        "index.js": 'import icon from "./icon.svg"; export { icon };',
        "icon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script>fetch(1)</x:script></svg>',
      })
    );
    const ok = await approvedApp({ [masked]: "1" });
    const built = await buildOf(ok, "browser");
    const css = await artifactText(built.hash, `${masked}.css`);
    const refused = await approvedApp({ [sneaky]: "1" });
    expect({
      css: css.includes("url(#clip)"),
      refusals: await refusalsOf(buildOf(refused, "browser")),
    }).toStrictEqual({
      css: true,
      refusals: [
        `${sneaky}@1.0.0's icon.svg is an SVG with an element that can run or embed something`,
      ],
    });
  });

  it("refuses entries that would be the same module", async () => {
    const theme = named("theme");
    await publish(
      esm(
        theme,
        { "style.css": ".t{color:red}", "style.js": "export const t = 1;" },
        { exports: { "./style.css": "./style.css", "./style": "./style.js" } }
      )
    );
    const app = await approvedApp(
      { [theme]: "1" },
      { entries: [`${theme}/style.css`, `${theme}/style`] }
    );
    await expect(refusalsOf(buildOf(app, "browser"))).resolves.toStrictEqual([
      `the entries ${theme}/style.css and ${theme}/style would both be the module ${theme}~style`,
    ]);
  });
});

describe("a build's durability", () => {
  it("keeps nothing when the approval stops holding while it builds", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const admin = await personApi("admin");
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    // As the builder starts, who approves dependencies changes: the
    // policy the build was admitted under is no longer the one in force.
    let changed = false;
    const assets = new Proxy(env.ASSETS, {
      get: (target, property): unknown =>
        property === "fetch"
          ? async (input: RequestInfo, init?: RequestInit) => {
              if (!changed) {
                changed = true;
                await admin.api.dependencies.grantApprover({
                  type: "person",
                  userId: identity.userId,
                });
              }
              return await target.fetch(input, init);
            }
          : bound(target, property),
    });
    const outcome = await failure(
      buildDependencies({ ...env, ASSETS: assets }, identity, {
        app: app.app,
        graphHash: app.request.graphHash,
        target: "browser",
        policyGeneration,
      })
    );
    const row = await env.DB.prepare(
      "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(app.app, app.request.graphHash)
      .first<{ lock: string }>();
    const lock = graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
    expect([outcome.code, lock.artifacts]).toStrictEqual([
      "dependency.policy_changed",
      undefined,
    ]);
  });

  it("keeps a target's pin when a resolve sets other entries, records the change, and pins the new entries' build on its own", async () => {
    const widgets = named("widgets");
    await publish(
      esm(
        widgets,
        {
          "index.js": "export const main = 'main';",
          "extra.js": "export const extra = 'extra';",
        },
        { exports: { ".": "./index.js", "./extra": "./extra.js" } }
      )
    );
    const app = await approvedApp({ [widgets]: "1" });
    const first = await buildOf(app, "browser");
    const firstConfig = await configOf(await storedLock(app), "browser");
    const reresolve = async (entries: string[]) =>
      await auditedDuring(async () => {
        await app.builder.api.dependencies.resolve(
          intentFor(app.app, { [widgets]: "1" }, { entries })
        );
      });

    const changed = await reresolve([widgets, `${widgets}/extra`]);
    const afterResolve = await storedLock(app);
    const extraConfig = await configOf(afterResolve, "browser");
    let second: PackageBuild | undefined;
    const secondPinned = await auditedDuring(async () => {
      second = await buildOf(app, "browser");
    });
    // Back to the first entries: their pin's bytes, never others.
    const changedBack = await reresolve([widgets]);
    let back: PackageBuild | undefined;
    const backPinned = await auditedDuring(async () => {
      back = await buildOf(app, "browser");
    });
    const finalLock = await storedLock(app);

    expect(
      changed
        .filter(({ action }) => action === "dependency.lock_targets_changed")
        .map(({ detail }) => detail)
    ).toStrictEqual([
      {
        app: app.app,
        graphHash: app.request.graphHash,
        targets: "browser",
        "from.browser": firstConfig,
        "to.browser": extraConfig,
      },
    ]);
    expect({
      // The resolve leaves the first config's pin as it was.
      kept: afterResolve.artifacts?.[compilerVersion]?.[firstConfig]?.hash,
      unpinned: afterResolve.artifacts?.[compilerVersion]?.[extraConfig],
      secondEntries: Object.keys(second?.artifact.entries ?? {}).toSorted(),
      secondRecorded: pinsRecorded(secondPinned),
      changedBack: changedBack.filter(
        ({ action }) => action === "dependency.lock_targets_changed"
      ).length,
      back: [back?.hash, back?.stats],
      backRecorded: pinsRecorded(backPinned),
      pins: Object.keys(
        finalLock.artifacts?.[compilerVersion] ?? {}
      ).toSorted(),
    }).toStrictEqual({
      kept: first.hash,
      unpinned: undefined,
      secondEntries: [widgets, `${widgets}/extra`].toSorted(),
      secondRecorded: [
        {
          app: app.app,
          graphHash: app.request.graphHash,
          target: "browser",
          config: extraConfig,
          approval: app.request.id,
          hash: second?.hash,
        },
      ],
      changedBack: 1,
      back: [first.hash, null],
      backRecorded: [],
      pins: [firstConfig, extraConfig].toSorted(),
    });
  });

  it("records a resolve that changes the config of every target, and stores its lock", async () => {
    const widgets = named("widgets");
    await publish(
      esm(
        widgets,
        {
          "index.js": "export const main = 'main';",
          "extra.js": "export const extra = 'extra';",
        },
        { exports: { ".": "./index.js", "./extra": "./extra.js" } }
      )
    );
    const targets = ["browser", "server", "workflow", "computation"] as const;
    const app = await approvedApp(
      { [widgets]: "1" },
      { targets: [...targets] }
    );
    const before = await storedLock(app);
    const changed = await auditedDuring(async () => {
      await app.builder.api.dependencies.resolve(
        intentFor(
          app.app,
          { [widgets]: "1" },
          { targets: [...targets], entries: [widgets, `${widgets}/extra`] }
        )
      );
    });
    const after = await storedLock(app);
    const configs = async (lock: GraspLock, side: string) =>
      await Promise.all(
        targets.map(async (target): Promise<[string, string]> => [
          `${side}.${target}`,
          await configOf(lock, target),
        ])
      );
    const from = await configs(before, "from");
    const to = await configs(after, "to");
    expect({
      entries: after.targets.computation?.entries.toSorted(),
      recorded: changed
        .filter(({ action }) => action === "dependency.lock_targets_changed")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      entries: [widgets, `${widgets}/extra`].toSorted(),
      recorded: [
        {
          app: app.app,
          graphHash: app.request.graphHash,
          targets: targets.join(" "),
          ...Object.fromEntries([...from, ...to]),
        },
      ],
    });
  });

  it("pins one artifact, and records one pin, when two builds race to pin it", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    let builds: PackageBuild[] = [];
    const events = await auditedDuring(async () => {
      builds = await Promise.all([
        buildOf(app, "browser"),
        buildOf(app, "browser"),
      ]);
    });
    const [first, second] = builds;
    const lock = await storedLock(app);
    expect({
      same: first?.hash === second?.hash,
      pinned:
        lock.artifacts?.[compilerVersion]?.[await configOf(lock, "browser")]
          ?.hash,
      versions: Object.keys(lock.artifacts ?? {}),
      recorded: pinsRecorded(events).length,
    }).toStrictEqual({
      same: true,
      pinned: first?.hash,
      versions: [compilerVersion],
      recorded: 1,
    });
  });

  it("keeps the pins of the two compilers that pinned last, and of a target's newest configs, recording what it drops", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const lock = await storedLock(app);
    const config = await configOf(lock, "browser");
    const day = 24 * 60 * 60 * 1000;
    const pinOf = (hash: string, daysAgo: number) => ({
      target: "browser" as const,
      hash,
      exports: {},
      pinnedAt: new Date(Date.now() - daysAgo * day).toISOString(),
    });
    // Two other releases pinned this config before; this compiler pinned
    // four other configs of the target, and none of this one yet.
    await storeLock(app, {
      ...lock,
      artifacts: {
        "release-older": { [config]: pinOf(hashOf("a"), 9) },
        "release-newer": { [config]: pinOf(hashOf("b"), 1) },
        [compilerVersion]: {
          [hashOf("1")]: pinOf(hashOf("c"), 8),
          [hashOf("2")]: pinOf(hashOf("d"), 7),
          [hashOf("3")]: pinOf(hashOf("e"), 6),
          [hashOf("4")]: pinOf(hashOf("f"), 5),
        },
      },
    });
    let built: PackageBuild | undefined;
    const events = await auditedDuring(async () => {
      built = await buildOf(app, "browser");
    });
    const after = await storedLock(app);
    expect({
      compilers: Object.keys(after.artifacts ?? {}).toSorted(),
      pins: Object.keys(after.artifacts?.[compilerVersion] ?? {}).toSorted(),
      recorded: pinsRecorded(events).length,
      dropped: droppedRecorded(events).toSorted(),
    }).toStrictEqual({
      compilers: [compilerVersion, "release-newer"].toSorted(),
      pins: [hashOf("2"), hashOf("3"), hashOf("4"), config].toSorted(),
      recorded: 1,
      dropped: [hashOf("a"), hashOf("c")],
    });
    expect(after.artifacts?.[compilerVersion]?.[config]?.hash).toBe(
      built?.hash
    );
  });

  it("pins and records a build that drops every pin another release kept, as many as a lock holds", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const lock = await storedLock(app);
    const day = 24 * 60 * 60 * 1000;
    const targets = ["browser", "server", "workflow", "computation"] as const;
    const pinOf = (
      target: (typeof targets)[number],
      hash: string,
      daysAgo: number
    ) => ({
      target,
      hash,
      exports: {},
      pinnedAt: new Date(Date.now() - daysAgo * day).toISOString(),
    });
    // The oldest of two other releases kept four configs of every target:
    // a build of a third release drops them all, and one of its own.
    const older = targets.flatMap((target, t) =>
      [0, 1, 2, 3].map((c) => ({
        config: `${"0".repeat(62)}${t}${c}`,
        pin: pinOf(target, `${"abcd"[t]?.repeat(63)}${c}`, 9),
      }))
    );
    await storeLock(app, {
      ...lock,
      artifacts: {
        "release-older": Object.fromEntries(
          older.map(({ config, pin }) => [config, pin])
        ),
        "release-newer": { [hashOf("e")]: pinOf("browser", hashOf("e"), 1) },
        [compilerVersion]: {
          [hashOf("1")]: pinOf("browser", hashOf("1"), 8),
          [hashOf("2")]: pinOf("browser", hashOf("2"), 7),
          [hashOf("3")]: pinOf("browser", hashOf("3"), 6),
          [hashOf("4")]: pinOf("browser", hashOf("4"), 5),
        },
      },
    });
    let built: PackageBuild | undefined;
    const events = await auditedDuring(async () => {
      built = await buildOf(app, "browser");
    });
    const after = await storedLock(app);
    const config = await configOf(after, "browser");
    expect({
      pinned: after.artifacts?.[compilerVersion]?.[config]?.hash,
      compilers: Object.keys(after.artifacts ?? {}).toSorted(),
      dropped: droppedRecorded(events).toSorted(),
    }).toStrictEqual({
      pinned: built?.hash,
      compilers: [compilerVersion, "release-newer"].toSorted(),
      dropped: [hashOf("1"), ...older.map(({ pin }) => pin.hash)].toSorted(),
    });
  });

  it("refuses a build that makes other bytes than the lock pinned", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
    const lock = await storedLock(app);
    const config = await configOf(lock, "browser");
    const pinned = lock.artifacts?.[compilerVersion]?.[config];
    if (pinned === undefined) {
      throw new Error("No pin");
    }
    await storeLock(app, {
      ...lock,
      artifacts: {
        [compilerVersion]: { [config]: { ...pinned, hash: "0".repeat(64) } },
      },
    });
    const { code } = await failure(buildOf(app, "browser"));
    expect(code).toBe("package.artifact_mismatch");
  });

  it("records in the audit trail the pin a build writes and the approval it relied on, once", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const events = await auditedDuring(async () => {
      await buildOf(app, "browser");
      // Handed out from the pin, again and again: nothing more recorded.
      await buildOf(app, "browser");
      await buildOf(app, "browser");
    });
    const built = pinsRecorded(events).map((detail) =>
      z.object({ approval: z.string(), graphHash: z.string() }).parse(detail)
    );
    expect(built).toStrictEqual([
      { approval: app.request.id, graphHash: app.request.graphHash },
    ]);
  });
});

describe("what a build names and keeps", () => {
  it("lets a package import itself through its exports, and no further", async () => {
    const widgets = named("widgets");
    const leaky = named("leaky");
    const bare = named("bare");
    await publish(
      esm(
        widgets,
        {
          "index.js": `export { helper } from "${widgets}/helper";`,
          "helper.js": "export const helper = 'self';",
        },
        { exports: { ".": "./index.js", "./helper": "./helper.js" } }
      )
    );
    await publish(
      esm(
        leaky,
        {
          "index.js": `export { secret } from "${leaky}/secret.js";`,
          "secret.js": "export const secret = 1;",
        },
        { exports: { ".": "./index.js" } }
      )
    );
    await publish(
      esm(bare, { "index.js": `export * from "${bare}/index.js";` })
    );
    const ok = await approvedApp({ [widgets]: "1" });
    const built = await buildOf(ok, "browser");
    const module = await artifactText(built.hash, `${widgets}.js`);
    const refused = await approvedApp({ [leaky]: "1", [bare]: "1" });
    const refusals = await refusalsOf(buildOf(refused, "browser"));
    expect({
      self: module.includes("self"),
      refusals: refusals.toSorted(),
    }).toStrictEqual({
      self: true,
      refusals: [
        `${bare}@1.0.0 imports itself by name, which only a package with exports may`,
        `${leaky}@1.0.0 doesn't export ./secret.js for the browser target`,
      ].toSorted(),
    });
  });

  it("names the file built for an entry, after the browser field's remap", async () => {
    const remapped = named("remapped");
    await publish(
      esm(
        remapped,
        {
          "index.js": "export const where = 'node';",
          "browser.js": "export const where = 'browser';",
        },
        { browser: { "./index.js": "./browser.js" } }
      )
    );
    const app = await approvedApp({ [remapped]: "1" });
    const built = await buildOf(app, "browser");
    expect(built.artifact.entries[remapped]?.resolved).toBe(
      `${remapped}@1.0.0/browser.js`
    );
  });

  it("refuses local image-set strings and SVGs that load from outside", async () => {
    const photos = named("photos");
    const sprite = named("sprite");
    await publish(
      esm(photos, {
        "index.js": 'import "./photos.css"; export {};',
        "photos.css": '.p { background: image-set("./photo.png" 1x); }',
        "photo.png": "PNG",
      })
    );
    await publish(
      esm(sprite, {
        "index.js": 'import icon from "./icon.svg"; export { icon };',
        "icon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example/a.png"/></svg>',
      })
    );
    const app = await approvedApp({ [photos]: "1", [sprite]: "1" });
    const css = await approvedApp({ [photos]: "1" });
    expect({
      assets: await refusalsOf(buildOf(app, "browser")),
      css: await refusalsOf(buildOf(css, "browser")),
    }).toStrictEqual({
      assets: [
        `${sprite}@1.0.0's icon.svg is an SVG that loads something from outside itself`,
      ],
      css: [
        `the stylesheet ${photos}.css names ./photo.png as a string, which isn't bundled: use url()`,
      ],
    });
  });

  it("refuses a stylesheet that takes a URL it loads from a custom property", async () => {
    const themed = named("themed");
    await publish(
      esm(themed, {
        "index.js": 'import "./theme.css"; export {};',
        "theme.css":
          '.p { --photo: "https://cdn.example/p.png"; background: image-set(var(--photo) 1x); }',
      })
    );
    const app = await approvedApp({ [themed]: "1" });
    await expect(refusalsOf(buildOf(app, "browser"))).resolves.toStrictEqual([
      `the stylesheet ${themed}.css takes a URL it loads from var(), which the build can't check`,
    ]);
  });

  it("takes a stylesheet's text that only looks like a URL", async () => {
    const quoted = named("quoted");
    await publish(
      esm(quoted, {
        "index.js": 'import "./note.css"; export {};',
        "note.css": `/* background: url(https://cdn.example/a.png) */
.n::before { content: "https://cdn.example/a.png"; font-family: "url(https://x)"; }`,
      })
    );
    const app = await approvedApp({ [quoted]: "1" });
    const built = await buildOf(app, "browser");
    expect(built.artifact.entries[quoted]?.css).toBe(`${quoted}.css`);
  });

  it("builds again when a kept artifact's description can't be read, to the same pin", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const first = await buildOf(app, "browser");
    await env.FILES.put(`package-builds/${first.hash}.json`, "{not json");
    const again = await buildOf(app, "browser");
    expect([again.hash, again.stats === null]).toStrictEqual([
      first.hash,
      false,
    ]);
  });

  it("pins a build under the config it built, when a resolve changes the target while it builds", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    // Just before the build pins, a resolve sets other entries.
    let raced = false;
    const files = new Proxy(env.FILES, {
      get: (target, property): unknown =>
        property === "put"
          ? async (
              key: string,
              value: Parameters<R2Bucket["put"]>[1],
              options?: R2PutOptions
            ): Promise<R2Object | null> => {
              if (!raced && key.endsWith(".json")) {
                raced = true;
                await app.builder.api.dependencies.resolve(
                  intentFor(
                    app.app,
                    { [ui]: "^1.0.0" },
                    { entries: [ui, `${ui}/extra`] }
                  )
                );
              }
              return await target.put(key, value, options);
            }
          : bound(target, property),
    });
    const configBefore = await configOf(await storedLock(app), "browser");
    const built = await buildDependencies({ ...env, FILES: files }, identity, {
      app: app.app,
      graphHash: app.request.graphHash,
      target: "browser",
      policyGeneration,
    });
    const lock = await storedLock(app);
    const configNow = await configOf(lock, "browser");
    expect({
      raced,
      // The entries it built: the target's config as it read it.
      entries: Object.keys(built.artifact.entries),
      pinnedBefore: lock.artifacts?.[compilerVersion]?.[configBefore]?.hash,
      pinnedNow: lock.artifacts?.[compilerVersion]?.[configNow],
    }).toStrictEqual({
      raced: true,
      entries: [ui],
      pinnedBefore: built.hash,
      pinnedNow: undefined,
    });
  });

  it("hands out the kept artifact of the config it read, when a resolve changes the target as it is read", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const first = await buildOf(app, "browser");
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    // As the kept artifact's description is read, a resolve sets other
    // entries for the target.
    let raced = false;
    const files = new Proxy(env.FILES, {
      get: (target, property): unknown =>
        property === "get"
          ? async (key: string) => {
              if (!raced && key.endsWith(".json")) {
                raced = true;
                await app.builder.api.dependencies.resolve(
                  intentFor(
                    app.app,
                    { [ui]: "^1.0.0" },
                    { entries: [ui, `${ui}/extra`] }
                  )
                );
              }
              return await target.get(key);
            }
          : bound(target, property),
    });
    const kept = await buildDependencies({ ...env, FILES: files }, identity, {
      app: app.app,
      graphHash: app.request.graphHash,
      target: "browser",
      policyGeneration,
    });
    // Still pinned, under the config it was built for.
    const lock = await storedLock(app);
    const pinned = Object.values(lock.artifacts?.[compilerVersion] ?? {}).map(
      ({ hash }) => hash
    );
    expect({ raced, hash: kept.hash, pinned }).toStrictEqual({
      raced: true,
      hash: first.hash,
      pinned: [first.hash],
    });
  });

  it("makes a corrupt artifact again to its pin, recording nothing new, when a resolve changes the target while it builds", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const first = await buildOf(app, "browser");
    // The kept artifact can't be read, so the build makes it again.
    await env.FILES.put(`package-builds/${first.hash}.json`, "{not json");
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    let raced = false;
    const files = new Proxy(env.FILES, {
      get: (target, property): unknown =>
        property === "put"
          ? async (
              key: string,
              value: Parameters<R2Bucket["put"]>[1],
              options?: R2PutOptions
            ): Promise<R2Object | null> => {
              if (!raced && key.endsWith(".json")) {
                raced = true;
                await app.builder.api.dependencies.resolve(
                  intentFor(
                    app.app,
                    { [ui]: "^1.0.0" },
                    { entries: [ui, `${ui}/extra`] }
                  )
                );
              }
              return await target.put(key, value, options);
            }
          : bound(target, property),
    });
    let again: PackageBuild | undefined;
    const events = await auditedDuring(async () => {
      again = await buildDependencies({ ...env, FILES: files }, identity, {
        app: app.app,
        graphHash: app.request.graphHash,
        target: "browser",
        policyGeneration,
      });
    });
    expect({
      raced,
      hash: again?.hash,
      rebuilt: again?.stats !== null,
      recorded: pinsRecorded(events),
    }).toStrictEqual({
      raced: true,
      hash: first.hash,
      rebuilt: true,
      recorded: [],
    });
  });
});

describe("what a pin keeps and records", () => {
  it("records a pin with the write that makes it: a request that dies right after still leaves its event", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    const lockText = async (): Promise<string | null> =>
      await env.DB.prepare(
        "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
      )
        .bind(app.app, app.request.graphHash)
        .first<string>("lock");
    // The request dies right after the batch that changes the lock lands.
    const dying = new Proxy(env.DB, {
      get: (target, property): unknown =>
        property === "batch"
          ? async (statements: D1PreparedStatement[]) => {
              const before = await lockText();
              const results = await target.batch(statements);
              if ((await lockText()) !== before) {
                throw new Error("The request died");
              }
              return results;
            }
          : bound(target, property),
    });
    let died = false;
    const events = await auditedDuring(async () => {
      try {
        await buildDependencies({ ...env, DB: dying }, identity, {
          app: app.app,
          graphHash: app.request.graphHash,
          target: "browser",
          policyGeneration,
        });
      } catch (error) {
        died = error instanceof Error && error.message === "The request died";
      }
    });
    const lock = await storedLock(app);
    const pinned =
      lock.artifacts?.[compilerVersion]?.[await configOf(lock, "browser")];
    expect({
      died,
      recorded: pinsRecorded(events).map(({ hash }) => hash),
    }).toStrictEqual({ died: true, recorded: [pinned?.hash] });
  });

  it("keeps the config a target names now, and moves a pin's time on as it is handed out", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
    const lock = await storedLock(app);
    const config = await configOf(lock, "browser");
    const pinned = lock.artifacts?.[compilerVersion]?.[config];
    if (pinned === undefined) {
      throw new Error("No pin");
    }
    const day = 24 * 60 * 60 * 1000;
    const pinOf = (hash: string, daysAgo: number) => ({
      target: "browser" as const,
      hash,
      exports: {},
      pinnedAt: new Date(Date.now() - daysAgo * day).toISOString(),
    });
    // The config in use was pinned first of five: adding one more drops
    // the oldest of the others, never it.
    const { dropped } = withPin(
      {
        [compilerVersion]: {
          [config]: pinOf(hashOf("a"), 9),
          [hashOf("1")]: pinOf(hashOf("b"), 4),
          [hashOf("2")]: pinOf(hashOf("c"), 3),
          [hashOf("3")]: pinOf(hashOf("d"), 2),
        },
      },
      compilerVersion,
      hashOf("4"),
      pinOf(hashOf("e"), 0),
      config
    );
    // Handed out two days after it was pinned: its time moves on.
    await storeLock(app, {
      ...lock,
      artifacts: {
        [compilerVersion]: {
          [config]: { ...pinned, pinnedAt: pinOf("", 2).pinnedAt },
        },
      },
    });
    await buildOf(app, "browser");
    const after = await storedLock(app);
    const touched = after.artifacts?.[compilerVersion]?.[config];
    expect({
      dropped,
      touched: Date.now() - Date.parse(touched?.pinnedAt ?? "") < day,
    }).toStrictEqual({ dropped: [hashOf("b")], touched: true });
  });
});

describe("one build of an App's packages at a time", () => {
  it("has a build asked for while another runs wait for it, then hand out what it pinned without building", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    const asked = {
      app: app.app,
      graphHash: app.request.graphHash,
      target: "browser" as const,
      policyGeneration,
    };
    // The second build's looks at the App's lease: the second one means it
    // found the lease held, and waits.
    const { promise: secondWaits, resolve: waiting } =
      Promise.withResolvers<boolean>();
    let leaseLooks = 0;
    const secondDb = new Proxy(env.DB, {
      get: (target, property): unknown =>
        property === "prepare"
          ? (query: string) => {
              if (query.includes("dependency_build_leases")) {
                leaseLooks += 1;
                if (leaseLooks === 2) {
                  waiting(true);
                }
              }
              return target.prepare(query);
            }
          : bound(target, property),
    });
    let secondStarts = 0;
    const secondAssets = new Proxy(env.ASSETS, {
      get: (target, property): unknown =>
        property === "fetch"
          ? async (input: RequestInfo, init?: RequestInit) => {
              secondStarts += 1;
              return await target.fetch(input, init);
            }
          : bound(target, property),
    });
    let second: Promise<PackageBuild> | undefined;
    // The first build, holding the lease, starts its builder: the second
    // is asked for then, and the first goes on once the second waits.
    let started = false;
    const firstAssets = new Proxy(env.ASSETS, {
      get: (target, property): unknown =>
        property === "fetch"
          ? async (input: RequestInfo, init?: RequestInit) => {
              if (!started) {
                started = true;
                second = buildDependencies(
                  { ...env, DB: secondDb, ASSETS: secondAssets },
                  identity,
                  asked
                );
                await secondWaits;
              }
              return await target.fetch(input, init);
            }
          : bound(target, property),
    });

    const first = await buildDependencies(
      { ...env, ASSETS: firstAssets },
      identity,
      asked
    );
    const shared = await second;
    expect({
      same: shared?.hash === first.hash,
      built: [first.stats === null, shared?.stats === null],
      secondStarts,
    }).toStrictEqual({ same: true, built: [false, true], secondStarts: 0 });
  });
});

describe("what a build leaves behind", () => {
  it("deletes, from the cron, the files of a build that never pinned them", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const admin = await personApi("admin");
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    // As the build writes its description, the policy moves on: its pin
    // is refused, and its files are left.
    let written: string | undefined;
    const files = new Proxy(env.FILES, {
      get: (target, property): unknown =>
        property === "put"
          ? async (
              key: string,
              value: Parameters<R2Bucket["put"]>[1],
              options?: R2PutOptions
            ): Promise<R2Object | null> => {
              const put = await target.put(key, value, options);
              if (written === undefined && key.endsWith(".json")) {
                written = key;
                await admin.api.dependencies.grantApprover({
                  type: "person",
                  userId: identity.userId,
                });
              }
              return put;
            }
          : bound(target, property),
    });
    const { code } = await failure(
      buildDependencies({ ...env, FILES: files }, identity, {
        app: app.app,
        graphHash: app.request.graphHash,
        target: "browser",
        policyGeneration,
      })
    );
    const hash = /package-builds\/(?<hash>[0-9a-f]{64})\.json$/u.exec(
      written ?? ""
    )?.groups?.hash;
    const left = await env.FILES.list({ prefix: `package-builds/${hash}` });

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    for (let run = 0; run < 20; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await sweepPackageFiles(env, later);
    }
    const after = await env.FILES.list({ prefix: `package-builds/${hash}` });
    expect({
      code,
      left: left.objects.length > 0,
      after: after.objects.length,
    }).toStrictEqual({
      code: "dependency.policy_changed",
      left: true,
      after: 0,
    });
  });
});
