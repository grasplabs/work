import { kitModuleName, packageModuleName } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { appKind } from "../src/apps.ts";
import { decideDependency } from "../src/packages/requests.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { buildAppCode, buildPages } from "../src/pages.ts";
import { rollback } from "../src/publish.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { named, publish, reportToOsv, rescannedUntil } from "./npm.ts";
import { appWith, calledAs, seal, sweptAway } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { outcome } from "./sign-in.ts";

// An App's approved npm packages, from GRA-1636's threat model: imported
// in its pages and its server code as any package is, each bundled into
// the build's own modules, so a page's are served from the build's own
// directory under the frame's policy, and a server's load in its isolate,
// which has no network. Only the App's approved lock is importable; a
// page's React is the kit's, never a package's; and a graph revoked as
// malware is no longer built, loaded or served.

/** A package for a page: a component on the kit's React. */
const chart = async (): Promise<string> => {
  const name = named("chart");
  await publish({
    name,
    version: "1.0.0",
    manifest: {
      type: "module",
      license: "MIT",
      exports: { ".": "./index.js", "./server": "./server.js" },
      peerDependencies: { react: "*" },
      peerDependenciesMeta: { react: { optional: true } },
    },
    files: {
      "index.js":
        'import { createElement } from "react";\nexport const Bars = () => createElement("svg", { "aria-label": "bars" });',
      // What a package might do to bring a React of its own.
      "server.js": 'export { renderToString } from "react-dom/server";',
    },
  });
  return name;
};

/** A package for server code: arithmetic, and a reach for the network. */
const maths = async (): Promise<string> => {
  const name = named("maths");
  await publish({
    name,
    version: "1.0.0",
    manifest: { type: "module", main: "index.js", license: "MIT" },
    files: {
      "index.js":
        'export const double = (n) => n * 2;\nexport const reach = async () => String((await fetch("https://example.com/")).status);',
    },
  });
  return name;
};

/** The App's files: a page importing `page`, server code importing `server`. */
const appFiles = (page: string, server: string): TestApp =>
  testApp(
    {
      name: "Charts",
      tables: {
        points: {
          fields: { n: "v.number()" },
          access: { read: "appMembers", write: "appMembers" },
        },
      },
    },
    {
      "server/points.ts": `import { v } from "@grasp-os/sdk";
import { action, query } from "@server/_generated/server";
import { double, reach } from ${JSON.stringify(server)};

export const doubled = query({
  args: { n: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => double(args.n),
});

export const reached = action({
  args: {},
  returns: v.string(),
  handler: async () => await reach(),
});
`,
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Bars } from ${JSON.stringify(page)};

export const Route = createFileRoute("/")({ component: () => <Bars /> });
`,
    }
  );

/** An App whose pages alone import `page`: its server code imports none. */
const pageOnlyFiles = (page: string): TestApp =>
  withFiles(appFiles(page, page), {
    "server/points.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const doubled = query({
  args: { n: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => args.n * 2,
});
`,
  });

/** `packages` asked for App `fixture` by its builder, and approved by them. */
const approved = async (
  { owner, app }: Fixture,
  packages: string[],
  entries?: string[]
) => {
  const request = await resolveDependencies(env, owner, {
    app,
    purpose: "Chart the points.",
    dependencies: packages.map((name) => ({ name, range: "^1.0.0" })),
    ...(entries === undefined ? {} : { entries }),
  });
  await decideDependency(env, owner, request.id, {
    approved: true,
    graphHash: request.graphHash,
  });
  return request;
};

/** What a build said of its imports, as one text. */
const saidOf = (built: { ok: boolean } & object): string =>
  "diagnostics" in built ? JSON.stringify(built.diagnostics) : "";

describe("an App's approved packages", () => {
  it("are imported in its pages and server code, a page's from the build's own modules on the kit's React, a server's running in its isolate", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    const request = await approved(fixture, [page, server]);

    const pages = await buildPages(env, files.files, fixture.app);
    await seal(fixture);
    await rollback(env, appKind, fixture.owner, fixture.app, 1);
    const doubled = await calledAs(
      fixture.owner,
      fixture.app,
      { name: "points.doubled", kind: "query" },
      { n: 21 }
    );
    const module =
      pages.ok && "modules" in pages
        ? Object.entries(pages.modules).find(([name]) =>
            name.startsWith(
              packageModuleName(page, request.graphHash).slice(0, -3)
            )
          )
        : undefined;

    expect({
      built: pages.ok,
      // On the kit's React module, by name: never a copy of React.
      onKitReact: module?.[1].includes(kitModuleName("react")),
      doubled,
    }).toMatchObject({
      built: true,
      onKitReact: true,
      doubled: { ok: true, value: 42 },
    });
  });

  it("add up: a second request adds its package to the App's, and both stay usable", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    await approved(fixture, [page]);
    const second = await approved(fixture, [server]);

    const pages = await buildPages(env, files.files, fixture.app);
    await seal(fixture);
    await rollback(env, appKind, fixture.owner, fixture.app, 1);
    const doubled = await calledAs(
      fixture.owner,
      fixture.app,
      { name: "points.doubled", kind: "query" },
      { n: 21 }
    );

    expect({
      locked: Object.keys(second.lock.direct).toSorted(),
      built: pages.ok,
      doubled,
    }).toMatchObject({
      locked: [page, server].toSorted(),
      built: true,
      doubled: { ok: true, value: 42 },
    });
  });

  it("leave only by a removal the builder approves, and a build still importing a removed one says so", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    await approved(fixture, [page, server]);
    const removal = await resolveDependencies(env, fixture.owner, {
      app: fixture.app,
      purpose: "The points are no longer doubled.",
      dependencies: [],
      remove: [server],
    });
    const before = await buildAppCode(env, files.files, fixture.app);
    await decideDependency(env, fixture.owner, removal.id, {
      approved: true,
      graphHash: removal.graphHash,
    });

    const pages = await buildPages(env, files.files, fixture.app);
    const code = await buildAppCode(env, files.files, fixture.app);

    expect({
      removed: removal.removed,
      locked: Object.keys(removal.lock.direct),
      builtBefore: before.ok,
      pages: pages.ok,
      code: code.ok,
      said: saidOf(code).includes(server) && saidOf(code).includes("removed"),
    }).toStrictEqual({
      removed: [server],
      locked: [page],
      builtBefore: true,
      pages: true,
      code: false,
      said: true,
    });
  });

  it("are nothing a page or server code imports until approved: refused at compile, saying to ask for it", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");

    const pages = await buildPages(env, files.files, fixture.app);
    const code = await buildAppCode(env, files.files, fixture.app);

    expect({
      pages: saidOf(pages).includes("env.build.resolveDependencies"),
      server: saidOf(code).includes("env.build.resolveDependencies"),
    }).toStrictEqual({ pages: true, server: true });
  });

  it("never give a page a React of a package's own", async () => {
    const page = await chart();
    const fixture = await appWith(
      withFiles(appFiles(page, page), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from ${JSON.stringify(`${page}/server`)};

export const Route = createFileRoute("/")({ component: () => <p>{String(renderToString)}</p> });
`,
      }),
      "Charts"
    );
    await approved(fixture, [page], [page, `${page}/server`]);

    const pages = await buildPages(
      env,
      withFiles(appFiles(page, page), {
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from ${JSON.stringify(`${page}/server`)};

export const Route = createFileRoute("/")({ component: () => <p>{String(renderToString)}</p> });
`,
      }).files,
      fixture.app
    );

    expect({
      built: pages.ok,
      said: saidOf(pages).includes(`${page}/server`),
    }).toStrictEqual({ built: false, said: true });
  });

  it("reach no network from server code: the isolate has none", async () => {
    const [page, server] = [await chart(), await maths()];
    const fixture = await appWith(appFiles(page, server), "Charts");
    await approved(fixture, [page, server]);
    await seal(fixture);
    await rollback(env, appKind, fixture.owner, fixture.app, 1);

    const reached = await calledAs(fixture.owner, fixture.app, {
      name: "points.reached",
      kind: "action",
    });

    expect(reached.ok).toBeFalsy();
  });

  it("are checked for malware on every build, a graph built and cached before refused at once once reported", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    await approved(fixture, [page, server]);
    const first = await buildPages(env, files.files, fixture.app);
    await reportToOsv(page, "1.0.0", "MAL-2026-50002");

    const again = await outcome(buildPages(env, files.files, fixture.app));

    expect({ first: first.ok, again }).toStrictEqual({
      first: true,
      again: "dependency.malware",
    });
  });

  it("replaced by a later approval, are still scanned while a kept release bundles them in its pages, and withdrawn once it is swept", async () => {
    const page = await chart();
    const files = pageOnlyFiles(page);
    const fixture = await appWith(files, "Charts");
    const first = await approved(fixture, [page]);
    await seal(fixture, 1);
    await approved(fixture, [await chart()]);
    await commitDefined(
      env,
      fixture.owner,
      fixture.app,
      withFiles(files, {
        "src/routes/index.tsx": `${files.files["src/routes/index.tsx"]}// Again.\n`,
      })
    );
    await seal(fixture, 2);
    // Release 1, the one bundling the replaced graph, held past retention.
    const hold = env.DB.prepare(
      "INSERT INTO sdk_release_pins (app_id, version, holder_kind, holder_id, pinned_at) VALUES (?, 1, 'hold', 'test', ?)"
    ).bind(fixture.app, Date.now());
    await hold.run();
    const statusOf = async () =>
      await env.DB.prepare(
        "SELECT status, malware_checked_at AS scanned FROM dependency_requests WHERE id = ?"
      )
        .bind(first.id)
        .first<{ status: string; scanned: number | null }>();
    const at = new Date();

    await rescannedUntil(first.id, at);
    // Another release of the App goes: release 1 still bundles the graph.
    await sweptAway(fixture.app, 2);
    const kept = await statusOf();
    await env.DB.prepare("DELETE FROM sdk_release_pins WHERE app_id = ?")
      .bind(fixture.app)
      .run();
    await sweptAway(fixture.app, 1);
    const swept = await statusOf();

    expect({
      kept: { status: kept?.status, scanned: kept?.scanned === at.getTime() },
      swept: swept?.status,
    }).toStrictEqual({
      kept: { status: "retired", scanned: true },
      swept: "revoked",
    });
  });

  it("are imported by the App's own tests, which pass as it is published", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = withFiles(appFiles(page, server), {
      "tests/maths.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { expect } from "vitest";
import { double } from ${JSON.stringify(server)};
import schema from "../server/schema.ts";

export default appTest(schema, {
  "doubles": async () => {
    expect(double(2)).toBe(4);
  },
});
`,
    });
    const fixture = await appWith(files, "Charts");
    await approved(fixture, [page, server]);

    const published = await rollback(
      env,
      appKind,
      fixture.owner,
      fixture.app,
      1
    );

    expect(published.version).toBe(1);
  });

  it("are no longer loaded, built or served once revoked as malware", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    const request = await approved(fixture, [page, server]);
    await seal(fixture);
    await rollback(env, appKind, fixture.owner, fixture.app, 1);
    await reportToOsv(server, "1.0.0", "MAL-2026-50001");
    await rescannedUntil(request.id, new Date());

    const called = await calledAs(
      fixture.owner,
      fixture.app,
      { name: "points.doubled", kind: "query" },
      { n: 21 }
    );
    const pages = await buildPages(env, files.files, fixture.app);

    expect({ called, rebuilt: pages.ok }).toMatchObject({
      called: { ok: false, error: { code: "dependency.revoked" } },
      rebuilt: false,
    });
  });
});
