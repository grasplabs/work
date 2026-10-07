import { compilerVersion } from "@grasp-os/compiler";
import type { DependencyIntent, PackageBuild } from "@grasp-os/shared/packages";
import { graspLockSchema } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { buildDependencies } from "../src/packages/build.ts";
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

  it("pins each target's artifact in the lock, and builds the same bytes again from it", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const first = await buildOf(app, "browser");
    const again = await buildOf(app, "browser");
    const row = await env.DB.prepare(
      "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(app.app, app.request.graphHash)
      .first<{ lock: string }>();
    const lock = graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
    // A kept file no longer what was built: built again, to the pin.
    const [path] = Object.keys(first.artifact.files);
    await env.FILES.put(`package-builds/${first.hash}/${path}`, "tampered");
    const rebuilt = await buildOf(app, "browser");
    expect({
      pinned: lock.artifacts?.[compilerVersion]?.browser,
      again: [again.hash, again.stats],
      rebuilt: rebuilt.hash,
    }).toStrictEqual({
      pinned: {
        hash: first.hash,
        exports: { [ui]: `${ui}@1.0.0/browser.js` },
      },
      again: [first.hash, null],
      rebuilt: first.hash,
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

  it("builds a target again once a resolve changes its entries", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
    const { lock } = await app.builder.api.dependencies.resolve(
      intentFor(app.app, { [ui]: "^1.0.0" }, { entries: [ui, `${ui}/extra`] })
    );
    expect(lock.artifacts?.[compilerVersion]?.browser).toBeUndefined();
  });

  it("pins one artifact when two builds race to pin it", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const [first, second] = await Promise.all([
      buildOf(app, "browser"),
      buildOf(app, "browser"),
    ]);
    const row = await env.DB.prepare(
      "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(app.app, app.request.graphHash)
      .first<{ lock: string }>();
    const lock = graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
    expect({
      same: first.hash === second.hash,
      pinned: lock.artifacts?.[compilerVersion]?.browser?.hash,
      versions: Object.keys(lock.artifacts ?? {}),
    }).toStrictEqual({
      same: true,
      pinned: first.hash,
      versions: [compilerVersion],
    });
  });

  it("refuses a build that makes other bytes than the lock pinned", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
    const row = await env.DB.prepare(
      "SELECT lock FROM dependency_locks WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(app.app, app.request.graphHash)
      .first<{ lock: string }>();
    const lock = graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
    const pinned = lock.artifacts?.[compilerVersion]?.browser;
    const forged = {
      ...lock,
      artifacts: {
        [compilerVersion]: {
          browser: { exports: pinned?.exports ?? {}, hash: "0".repeat(64) },
        },
      },
    };
    await env.DB.prepare(
      "UPDATE dependency_locks SET lock = ? WHERE app_id = ? AND graph_hash = ?"
    )
      .bind(JSON.stringify(forged), app.app, app.request.graphHash)
      .run();
    const { code } = await failure(buildOf(app, "browser"));
    expect(code).toBe("package.artifact_mismatch");
  });

  it("records in the audit trail the approval each build relied on, kept or built", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    const events = await auditedDuring(async () => {
      await buildOf(app, "browser");
      await buildOf(app, "browser");
    });
    const built = events
      .filter(({ action }) => action === "dependency.built")
      .map(({ detail }) =>
        z
          .object({
            approval: z.string(),
            kept: z.boolean(),
            graphHash: z.string(),
          })
          .parse(detail)
      );
    expect(built).toStrictEqual([
      {
        approval: app.request.id,
        kept: false,
        graphHash: app.request.graphHash,
      },
      {
        approval: app.request.id,
        kept: true,
        graphHash: app.request.graphHash,
      },
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

  it("re-admits after reading a kept artifact: a change while it was read wins", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
    const admin = await personApi("admin");
    const identity = await app.builder.api.whoami();
    const { policyGeneration } = await app.builder.api.dependencies.status(
      app.app
    );
    let changed = false;
    const files = new Proxy(env.FILES, {
      get: (target, property): unknown =>
        property === "get"
          ? async (key: string) => {
              if (!changed && key.endsWith(".json")) {
                changed = true;
                await admin.api.dependencies.grantApprover({
                  type: "person",
                  userId: identity.userId,
                });
              }
              return await target.get(key);
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
    expect(code).toBe("dependency.policy_changed");
  });

  it("never pins a build onto a target a resolve changed while it built", async () => {
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
    const { code } = await failure(
      buildDependencies({ ...env, FILES: files }, identity, {
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
    expect([code, lock.artifacts?.[compilerVersion]?.browser]).toStrictEqual([
      "dependency.stale",
      undefined,
    ]);
  });

  it("returns a kept artifact only while its pin holds: a resolve while it is read makes the build stale", async () => {
    const { ui } = await badgeLibrary();
    const app = await approvedApp({ [ui]: "^1.0.0" });
    await buildOf(app, "browser");
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
    const { code } = await failure(
      buildDependencies({ ...env, FILES: files }, identity, {
        app: app.app,
        graphHash: app.request.graphHash,
        target: "browser",
        policyGeneration,
      })
    );
    expect([raced, code]).toStrictEqual([true, "dependency.stale"]);
  });

  it("returns an artifact built again under a pin only while the pin holds: a resolve while it builds makes the build stale", async () => {
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
    const { code } = await failure(
      buildDependencies({ ...env, FILES: files }, identity, {
        app: app.app,
        graphHash: app.request.graphHash,
        target: "browser",
        policyGeneration,
      })
    );
    expect([raced, code]).toStrictEqual([true, "dependency.stale"]);
  });
});
