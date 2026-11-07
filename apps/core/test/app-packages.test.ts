import { kitModuleName, packageModuleName } from "@grasp-os/compiler";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { publishVersion } from "../src/app-publish.ts";
import { decideDependency } from "../src/packages/requests.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { buildAppCode, buildPages } from "../src/pages.ts";
import { appDefinition } from "./app-definitions.ts";
import { named, publish, reportToOsv, rescannedUntil } from "./npm.ts";
import { appWith, calledAs, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

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
const appFiles = (page: string, server: string): Record<string, string> => ({
  ...appDefinition({
    name: "Charts",
    tables: {
      points: {
        fields: { n: "v.number()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
  }),
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
  uses: [],
  handler: async () => await reach(),
});
`,
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Bars } from ${JSON.stringify(page)};

export const Route = createFileRoute("/")({ component: () => <Bars /> });
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

    const pages = await buildPages(env, files, fixture.app);
    await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
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

    const pages = await buildPages(env, files, fixture.app);
    await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
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
    const before = await buildAppCode(env, files, fixture.app);
    await decideDependency(env, fixture.owner, removal.id, {
      approved: true,
      graphHash: removal.graphHash,
    });

    const pages = await buildPages(env, files, fixture.app);
    const code = await buildAppCode(env, files, fixture.app);

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

    const pages = await buildPages(env, files, fixture.app);
    const code = await buildAppCode(env, files, fixture.app);

    expect({
      pages: saidOf(pages).includes("env.build.resolveDependencies"),
      server: saidOf(code).includes("env.build.resolveDependencies"),
    }).toStrictEqual({ pages: true, server: true });
  });

  it("never give a page a React of a package's own", async () => {
    const page = await chart();
    const fixture = await appWith(
      {
        ...appFiles(page, page),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from ${JSON.stringify(`${page}/server`)};

export const Route = createFileRoute("/")({ component: () => <p>{String(renderToString)}</p> });
`,
      },
      "Charts"
    );
    await approved(fixture, [page], [page, `${page}/server`]);

    const pages = await buildPages(
      env,
      {
        ...appFiles(page, page),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { renderToString } from ${JSON.stringify(`${page}/server`)};

export const Route = createFileRoute("/")({ component: () => <p>{String(renderToString)}</p> });
`,
      },
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
    await publishVersion(env, fixture.owner, fixture.app, 1);

    const reached = await calledAs(fixture.owner, fixture.app, {
      name: "points.reached",
      kind: "action",
    });

    expect(reached.ok).toBeFalsy();
  });

  it("are no longer loaded, built or served once revoked as malware", async () => {
    const [page, server] = [await chart(), await maths()];
    const files = appFiles(page, server);
    const fixture = await appWith(files, "Charts");
    const request = await approved(fixture, [page, server]);
    await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
    await reportToOsv(server, "1.0.0", "MAL-2026-50001");
    await rescannedUntil(request.id, new Date());

    const called = await calledAs(
      fixture.owner,
      fixture.app,
      { name: "points.doubled", kind: "query" },
      { n: 21 }
    );
    const pages = await buildPages(env, files, fixture.app);

    expect({ called, rebuilt: pages.ok }).toMatchObject({
      called: { ok: false, error: { code: "dependency.revoked" } },
      rebuilt: false,
    });
  });
});
