import { platformPeers } from "@grasp-os/compiler";
import { sha512Integrity, toHex } from "@grasp-os/shared/encoding";
import { packageErrors } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { admitDependencies } from "../src/dependencies/requests.ts";
import { sweepPackageFiles } from "../src/packages/cleanup.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  askedPaths,
  crafted,
  daysAgo,
  failure,
  intentFor,
  manifestEntry,
  named,
  noise,
  plain,
  publish,
  refusalsOf,
} from "./npm.ts";
import type { Entries } from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Resolving an App's npm packages (src/packages/resolve.ts) from its threat
// model: sources other than the registry, brand-new releases, a second
// React, graphs too deep, wide or heavy, and tarballs crafted to escape,
// link, explode, lie about themselves or run something on install. The
// registry is connect's strict fake of npm's (connect's
// test/npm-registry-fake.ts), behind the real connect Worker: real
// gzipped tarballs, real SHA-512 integrity. The tests' limits are set low
// enough to reach (vite.config.ts, `PACKAGE_LIMITS`).

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** A builder with a new App of theirs. */
const builderWithApp = async () => {
  const builder = await personApi("builder");
  const { id } = await builder.api.apps.create({ name: `App ${unique()}` });
  return { builder, app: id };
};

describe("resolving an App's packages", () => {
  it("resolves package.json to an exact lock and proposes its graph, admitting nothing", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    const tz = named("tz");
    const charts = named("charts");
    await publish(plain(tz, "2.1.0"));
    const tzIntegrity = await publish(plain(tz, "2.2.0"));
    await publish(
      plain(dates, "4.1.0", {
        dependencies: { [tz]: "^2.1.0" },
        exports: { ".": "./index.js", "./format": "./index.js" },
      })
    );
    await publish(
      plain(charts, "3.0.0", {
        dependencies: { [tz]: "^2.0.0" },
        peerDependencies: { react: "^19.0.0", "react-dom": ">=18" },
      })
    );

    const { request, lock } = await builder.api.dependencies.resolve(
      intentFor(
        app,
        { [dates]: "^4.0.0", [charts]: "3.x" },
        {
          targets: ["browser", "server"],
          entries: [dates, `${dates}/format`, charts],
        }
      )
    );

    const expected: GraspLock = {
      lockfileVersion: 1,
      registry: "https://registry.npmjs.org",
      requested: { [charts]: "3.x", [dates]: "^4.0.0" },
      direct: { [charts]: "3.0.0", [dates]: "4.1.0" },
      platformPeers: { ...platformPeers },
      targets: {
        browser: {
          conditions: ["browser", "import", "module", "default"],
          entries: [dates, `${dates}/format`, charts],
        },
        server: {
          conditions: ["workerd", "worker", "import", "module", "default"],
          entries: [dates, `${dates}/format`, charts],
        },
      },
      packages: {},
    };
    expect({ ...lock, packages: {} }).toStrictEqual(expected);
    // One copy of the time zones: 2.2.0 meets both ranges.
    expect(Object.keys(lock.packages).toSorted()).toStrictEqual(
      [`${charts}@3.0.0`, `${dates}@4.1.0`, `${tz}@2.2.0`].toSorted()
    );
    expect(lock.packages).toMatchObject({
      [`${tz}@2.2.0`]: { integrity: tzIntegrity, dependencies: {} },
      [`${charts}@3.0.0`]: {
        dependencies: { [tz]: "2.2.0" },
        peers: {
          react: {
            range: "^19.0.0",
            resolved: platformPeers.react,
            by: "platform",
          },
          "react-dom": {
            range: ">=18",
            resolved: platformPeers["react-dom"],
            by: "platform",
          },
        },
      },
    });
    expect(request).toMatchObject({
      status: "pending",
      targets: ["browser", "server"],
      counts: { direct: 2, packages: 3, findings: 0, refused: 0 },
    });
    const { policyGeneration } = await builder.api.dependencies.status(app);
    await expect(
      admitDependencies(
        env,
        { type: "person", userId: builder.userId },
        {
          app,
          graphHash: request.graphHash,
          targets: ["browser"],
          policyGeneration,
        }
      )
    ).rejects.toMatchObject({ code: "dependency.approval_required" });
  });

  it("keeps one lock per graph, with the targets and entries each resolve asks for", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(
      plain(dates, "1.0.0", {
        exports: { ".": "./index.js", "./format": "./index.js" },
      })
    );
    const browser = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "^1.0.0" })
    );
    const both = await builder.api.dependencies.resolve(
      intentFor(
        app,
        { [dates]: "^1.0.0" },
        { targets: ["browser", "server"], entries: [`${dates}/format`] }
      )
    );
    expect({
      sameGraph: both.request.graphHash === browser.request.graphHash,
      targets: both.lock.targets,
    }).toStrictEqual({
      sameGraph: true,
      targets: {
        browser: {
          conditions: ["browser", "import", "module", "default"],
          entries: [`${dates}/format`],
        },
        server: {
          conditions: ["workerd", "worker", "import", "module", "default"],
          entries: [`${dates}/format`],
        },
      },
    });
  });

  it("resolves the same package.json to the same request", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const intent = intentFor(app, { [dates]: "^1.0.0" });
    const first = await builder.api.dependencies.resolve(intent);
    const again = await builder.api.dependencies.resolve(intent);
    expect(again.request.id).toBe(first.request.id);
    expect(again.lock).toStrictEqual(first.lock);
  });

  it("keeps the bytes it unpacked in the deployment's own store, and fetches again what no longer matches", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    const integrity = await publish(plain(dates, "1.0.0"));
    // What was stored under the tarball's hash is no longer its bytes.
    const digest = toHex(
      Uint8Array.from(
        atob(integrity.slice("sha512-".length)),
        (char) => char.codePointAt(0) ?? 0
      )
    );
    await env.FILES.put(`npm-tarballs/${digest}.tgz`, "tampered");
    await builder.api.dependencies.resolve(intentFor(app, { [dates]: "1" }));
    const stored = await env.FILES.get(`npm-tarballs/${digest}.tgz`);
    const bytes = new Uint8Array(
      await (stored?.arrayBuffer() ?? new ArrayBuffer(0))
    );
    await expect(sha512Integrity(bytes)).resolves.toBe(integrity);
  });
});

describe("what a resolve takes from the registry", () => {
  it("resolves newly only to versions published three days ago or more", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish({ ...plain(dates, "1.0.0"), publishedAt: daysAgo(10) });
    await publish({ ...plain(dates, "1.1.0"), publishedAt: daysAgo(4) });
    await publish({ ...plain(dates, "1.2.0"), publishedAt: daysAgo(1) });
    const { lock } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "^1.0.0" })
    );
    expect(lock.direct).toStrictEqual({ [dates]: "1.1.0" });
  });

  it("keeps the versions of the App's approved lock, and resolves only what is new", async () => {
    const admin = await personApi("admin");
    const { builder, app } = await builderWithApp();
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: admin.userId,
    });
    const dates = named("dates");
    const charts = named("charts");
    await publish({ ...plain(dates, "1.0.0"), publishedAt: daysAgo(20) });
    await publish({ ...plain(charts, "1.0.0"), publishedAt: daysAgo(20) });
    const first = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "^1.0.0" })
    );
    const { policyGeneration } = await admin.api.dependencies.waiting();
    await admin.api.dependencies.decide(first.request.id, {
      approved: true,
      reviewed: { graphHash: first.request.graphHash, policyGeneration },
    });
    await publish({ ...plain(dates, "1.1.0"), publishedAt: daysAgo(10) });
    await publish({ ...plain(charts, "1.1.0"), publishedAt: daysAgo(10) });
    const { lock } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "^1.0.0", [charts]: "^1.0.0" })
    );
    expect(lock.direct).toStrictEqual({ [charts]: "1.1.0", [dates]: "1.0.0" });
  });

  it("refuses a range only a brand-new version meets", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish({ ...plain(dates, "1.0.0"), publishedAt: daysAgo(10) });
    await publish({ ...plain(dates, "2.0.0"), publishedAt: daysAgo(2) });
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [dates]: "^2.0.0" }))
      )
    ).resolves.toStrictEqual({
      code: "package.unresolvable",
      details: {
        package: dates,
        range: "^2.0.0",
        reason: `${dates}@2.0.0 was published less than three days ago`,
      },
    });
  });

  it("refuses a version without a SHA-512 integrity", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish({ ...plain(dates, "1.0.0"), sha1Only: true });
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [dates]: "1.0.0" }))
      )
    ).resolves.toMatchObject({ code: "package.unresolvable" });
  });

  it("refuses a package the registry doesn't have", async () => {
    const { builder, app } = await builderWithApp();
    await expect(
      failure(
        builder.api.dependencies.resolve(
          intentFor(app, { [named("missing")]: "^1.0.0" })
        )
      )
    ).resolves.toMatchObject({ code: "package.not_found" });
  });

  it("refuses a tarball other than the one the registry's metadata names", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish({
      ...plain(dates, "1.0.0"),
      integrity: `sha512-${"C".repeat(86)}==`,
    });
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [dates]: "1" }))
      )
    ).resolves.toMatchObject({ code: "package.integrity_mismatch" });
  });

  it("refuses sources other than the registry, in package.json and in a package's own dependencies", async () => {
    const { builder, app } = await builderWithApp();
    const specs = [
      "git+https://github.com/acme/dates.git",
      "github:acme/dates",
      "acme/dates",
      "file:../dates",
      "link:../dates",
      "https://evil.example/dates.tgz",
      "npm:other-dates@^1.0.0",
      "workspace:*",
      "latest",
    ];
    const outcomes = await Promise.all(
      specs.map(async (spec) => {
        const { code } = await failure(
          builder.api.dependencies.resolve(
            intentFor(app, { [named("dates")]: spec })
          )
        );
        return code;
      })
    );
    expect(new Set(outcomes)).toStrictEqual(
      new Set(["package.unsupported_source"])
    );
    const sneaky = named("sneaky");
    await publish(
      plain(sneaky, "1.0.0", {
        dependencies: { helper: "git+https://github.com/acme/helper.git" },
      })
    );
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [sneaky]: "1" }))
      )
    ).resolves.toStrictEqual({
      code: "package.unsupported_source",
      details: {
        package: `${sneaky}@1.0.0`,
        dependency: "helper",
        spec: "git+https://github.com/acme/helper.git",
      },
    });
  });
});

describe("the platform's own packages", () => {
  it("meets peers and dependencies on React with the platform's, and refuses another", async () => {
    const { builder, app } = await builderWithApp();
    const old = named("old-react-ui");
    const bundlesReact = named("brings-react");
    await publish(
      plain(old, "1.0.0", { peerDependencies: { react: "^18.0.0" } })
    );
    await publish(
      plain(bundlesReact, "1.0.0", { dependencies: { react: "^18.2.0" } })
    );
    await expect(
      failure(builder.api.dependencies.resolve(intentFor(app, { [old]: "1" })))
    ).resolves.toStrictEqual({
      code: "package.peer_conflict",
      details: {
        package: `${old}@1.0.0`,
        peer: "react",
        range: "^18.0.0",
        platform: platformPeers.react,
      },
    });
    await expect(
      failure(
        builder.api.dependencies.resolve(
          intentFor(app, { [bundlesReact]: "1" })
        )
      )
    ).resolves.toMatchObject({ code: "package.peer_conflict" });
    // package.json may name React itself only as the platform provides it.
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { react: "^18.0.0" }))
      )
    ).resolves.toMatchObject({ code: "package.peer_conflict" });
  });

  it("takes a dependency on React itself as the platform's, shown in the review", async () => {
    const { builder, app } = await builderWithApp();
    const hooks = named("react-hooks");
    await publish(
      plain(hooks, "1.0.0", {
        dependencies: { react: "^19.0.0", "react-dom": ">=18" },
      })
    );
    const { request, lock } = await builder.api.dependencies.resolve(
      intentFor(app, { [hooks]: "1" })
    );
    const review = await builder.api.dependencies.get(request.id);
    expect({
      locked: lock.packages[`${hooks}@1.0.0`]?.dependencies,
      reviewed: review.graph.packages.find(({ name }) => name === hooks)
        ?.dependencies,
      packages: review.graph.packages.map(({ name }) => name),
    }).toStrictEqual({
      locked: {
        react: platformPeers.react,
        "react-dom": platformPeers["react-dom"],
      },
      // In the graph's canonical order, by `name@version`.
      reviewed: [
        { name: "react-dom", version: platformPeers["react-dom"] },
        { name: "react", version: platformPeers.react },
      ],
      packages: [hooks],
    });
  });

  it("asks the registry nothing for peers it leaves out", async () => {
    const { builder, app } = await builderWithApp();
    const host = named("plugin-host");
    const optional = Array.from({ length: 20 }, (_, index) =>
      named(`optional-${index}`)
    );
    await publish(
      plain(host, "1.0.0", {
        peerDependencies: Object.fromEntries(
          optional.map((peer) => [peer, "^1.0.0"])
        ),
        peerDependenciesMeta: Object.fromEntries(
          optional.map((peer) => [peer, { optional: true }])
        ),
      })
    );
    await builder.api.dependencies.resolve(intentFor(app, { [host]: "1" }));
    const asked = await askedPaths();
    expect(
      asked.filter((path) => optional.some((peer) => path.includes(peer)))
    ).toStrictEqual([]);
  });

  it("refuses a peer the graph already has at a version that doesn't meet it, as npm does", async () => {
    const { builder, app } = await builderWithApp();
    const core = named("chart-core");
    const plugin = named("chart-plugin");
    await publish(plain(core, "1.0.0"));
    await publish(plain(core, "2.0.0"));
    await publish(
      plain(plugin, "1.0.0", { peerDependencies: { [core]: "^1.0.0" } })
    );
    await expect(
      failure(
        builder.api.dependencies.resolve(
          intentFor(app, { [core]: "^2.0.0", [plugin]: "1" })
        )
      )
    ).resolves.toStrictEqual({
      code: "package.peer_conflict",
      details: {
        package: `${plugin}@1.0.0`,
        peer: core,
        range: "^1.0.0",
        graph: "2.0.0",
      },
    });
  });

  it("refuses a registry package in the platform's own scope", async () => {
    const { builder, app } = await builderWithApp();
    const lookalike = named("ui-kit");
    await publish(
      plain(lookalike, "1.0.0", { dependencies: { "@grasp-os/ui": "^1.0.0" } })
    );
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [lookalike]: "1" }))
      )
    ).resolves.toMatchObject({
      code: "package.peer_conflict",
      details: { peer: "@grasp-os/ui" },
    });
  });
});

describe("a graph's limits", () => {
  it("refuses a chain of dependencies deeper than the limit", async () => {
    const { builder, app } = await builderWithApp();
    const base = named("chain");
    // Five deep: past the tests' limit of four.
    for (let depth = 5; depth >= 1; depth -= 1) {
      // Each depends on the next, so they are published from the end.
      // oxlint-disable-next-line no-await-in-loop
      await publish(
        plain(
          `${base}-${depth}`,
          "1.0.0",
          depth < 5 ? { dependencies: { [`${base}-${depth + 1}`]: "1" } } : {}
        )
      );
    }
    await expect(
      failure(
        builder.api.dependencies.resolve(intentFor(app, { [`${base}-1`]: "1" }))
      )
    ).resolves.toStrictEqual({
      code: "package.quota",
      details: { quota: "graphDepth", limit: 4 },
    });
  });

  it("refuses a graph of more packages than the limit", async () => {
    const { builder, app } = await builderWithApp();
    const base = named("wide");
    const leaves = Array.from({ length: 12 }, (_, index) => `${base}-${index}`);
    await Promise.all(leaves.map(async (leaf) => await publish(plain(leaf))));
    await publish(
      plain(base, "1.0.0", {
        dependencies: Object.fromEntries(leaves.map((leaf) => [leaf, "1"])),
      })
    );
    await expect(
      failure(builder.api.dependencies.resolve(intentFor(app, { [base]: "1" })))
    ).resolves.toStrictEqual({
      code: "package.quota",
      details: { quota: "graphPackages", limit: 12 },
    });
  });

  it("refuses tarballs heavier together than the limit, counting what was fetched", async () => {
    const { builder, app } = await builderWithApp();
    const base = named("heavy");
    // Four tarballs of about 190 KiB each: past the tests' 512 KiB.
    const parts = [0, 1, 2, 3].map((index) => `${base}-${index}`);
    await Promise.all(
      parts.map(
        async (part) =>
          await publish({
            ...plain(part),
            files: { "index.js": "export {};", "data.txt": noise(250 * 1024) },
          })
      )
    );
    await expect(
      failure(
        builder.api.dependencies.resolve(
          intentFor(app, Object.fromEntries(parts.map((part) => [part, "1"])))
        )
      )
    ).resolves.toMatchObject({
      code: "package.quota",
      details: { quota: "graphArchiveBytes" },
    });
  });
});

describe("a package's tarball", () => {
  it("is refused when it unpacks to more than the limit (an archive bomb)", async () => {
    const { builder, app } = await builderWithApp();
    const name = await crafted((own) => [
      manifestEntry(own),
      { path: "package/zeros.bin", zeros: 4 * 1024 * 1024 },
    ]);
    const refusals = await refusalsOf(
      builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
    );
    expect(refusals).toStrictEqual([
      `${name}@1.0.0: it unpacks to more than 1048576 bytes`,
    ]);
  });

  it("is refused when it has more entries than the limit", async () => {
    const { builder, app } = await builderWithApp();
    const name = await crafted((own) => [
      manifestEntry(own),
      ...Array.from({ length: 70 }, (_, index) => ({
        path: `package/files/${index}.js`,
        content: "export {};",
      })),
    ]);
    const refusals = await refusalsOf(
      builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
    );
    expect(refusals).toStrictEqual([
      `${name}@1.0.0: it has more than 64 entries`,
    ]);
  });

  it("is refused for any entry that would land outside the package, however its path is written", async () => {
    const { builder, app } = await builderWithApp();
    const attacks: { attack: string; entries: Entries }[] = [
      {
        attack: "parent segments",
        entries: [{ path: "package/../../evil.js", content: "x" }],
      },
      {
        attack: "an absolute path",
        entries: [{ path: "/etc/cron.d/evil", content: "x" }],
      },
      {
        attack: "a backslash",
        entries: [{ path: "package\\..\\..\\evil.js", content: "x" }],
      },
      {
        attack: "a drive letter",
        entries: [{ path: "C:/evil.js", content: "x" }],
      },
      {
        attack: "a PAX path",
        entries: [
          {
            path: "PaxHeader",
            type: "x",
            pax: { path: "package/../../evil.js" },
          },
          { path: "package/innocent.js", content: "x" },
        ],
      },
      {
        attack: "a GNU long name",
        entries: [
          {
            path: "././@LongLink",
            type: "L",
            content: "package/../../evil.js",
          },
          { path: "package/innocent.js", content: "x" },
        ],
      },
      {
        attack: "a dot segment",
        entries: [{ path: "package/./lib/../../evil.js", content: "x" }],
      },
    ];
    const outcomes = await Promise.all(
      attacks.map(async ({ attack, entries }) => {
        const name = await crafted((own) => [manifestEntry(own), ...entries]);
        const refusals = await refusalsOf(
          builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
        );
        return [
          attack,
          refusals.some((refusal) => refusal.includes("leaves the package")),
        ];
      })
    );
    expect(outcomes).toStrictEqual(attacks.map(({ attack }) => [attack, true]));
  });

  it("is read through a PAX path that isn't ASCII", async () => {
    const { builder, app } = await builderWithApp();
    const name = await crafted((own) => [
      manifestEntry(own),
      {
        path: "PaxHeader",
        type: "x",
        pax: { path: "package/lib/caf\u00E9.js" },
      },
      { path: "package/placeholder", content: "export const cafe = 1;" },
    ]);
    const { lock } = await builder.api.dependencies.resolve(
      intentFor(app, { [name]: "1" })
    );
    expect(Object.keys(lock.packages)).toStrictEqual([`${name}@1.0.0`]);
  });

  it("is refused for links, devices, FIFOs and two entries for one path", async () => {
    const { builder, app } = await builderWithApp();
    const cases: { expected: string; entries: Entries }[] = [
      {
        expected: "it has a symbolic link: package/index.js",
        entries: [
          { path: "package/index.js", type: "2", linkname: "/etc/passwd" },
        ],
      },
      {
        expected: "it has a hard link: package/index.js",
        entries: [
          {
            path: "package/index.js",
            type: "1",
            linkname: "package/package.json",
          },
        ],
      },
      {
        expected: "it has a character device: package/tty",
        entries: [{ path: "package/tty", type: "3" }],
      },
      {
        expected: "it has a FIFO: package/pipe",
        entries: [{ path: "package/pipe", type: "6" }],
      },
      {
        expected: "it has two entries for index.js",
        entries: [
          { path: "package/index.js", content: "export const safe = 1;" },
          { path: "package/index.js", content: "export const evil = 1;" },
        ],
      },
    ];
    const outcomes = await Promise.all(
      cases.map(async ({ entries }) => {
        const name = await crafted((own) => [manifestEntry(own), ...entries]);
        const refusals = await refusalsOf(
          builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
        );
        return refusals.map((refusal) =>
          refusal.slice(refusal.indexOf(": ") + 2)
        );
      })
    );
    expect(outcomes).toStrictEqual(cases.map(({ expected }) => [expected]));
  });

  it("is refused when it needs install scripts or native code, whatever the registry's metadata says", async () => {
    const { builder, app } = await builderWithApp();
    // The metadata says nothing of these; the tarball does.
    const scripted = await crafted((own) => [
      manifestEntry(own, { scripts: { postinstall: "node steal.js" } }),
    ]);
    const gyp = await crafted((own) => [
      manifestEntry(own),
      { path: "package/binding.gyp", content: "{}" },
    ]);
    const binary = await crafted((own) => [
      manifestEntry(own),
      { path: "package/build/Release/addon.node", content: "\u007FELF" },
    ]);
    const bundled = await crafted((own) => [
      manifestEntry(own),
      { path: "package/node_modules/hidden/index.js", content: "x" },
    ]);
    // The metadata says it has one.
    const declared = named("declared");
    await publish(
      plain(declared, "1.0.0", { scripts: { install: "node-gyp rebuild" } })
    );
    const results = await Promise.all(
      [scripted, gyp, binary, bundled, declared].map(
        async (name) =>
          await refusalsOf(
            builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
          )
      )
    );
    expect(results).toStrictEqual([
      [`${scripted}@1.0.0: it has install scripts: postinstall`],
      [`${gyp}@1.0.0: it builds native code (binding.gyp)`],
      [`${binary}@1.0.0: it ships native binaries: build/Release/addon.node`],
      [
        `${bundled}@1.0.0: it bundles packages the graph doesn't name: node_modules/hidden/index.js`,
      ],
      // The metadata's and the tarball's say the same: said once.
      [`${declared}@1.0.0: it has install scripts: install`],
    ]);
  });

  it("is refused when its tarball requires a peer the registry calls optional", async () => {
    const { builder, app } = await builderWithApp();
    const name = named("peer-confused");
    const peer = named("peer");
    await publish({
      name,
      version: "1.0.0",
      manifest: {
        peerDependencies: { [peer]: "^1.0.0" },
        peerDependenciesMeta: { [peer]: { optional: true } },
      },
      entries: [
        manifestEntry(name, { peerDependencies: { [peer]: "^1.0.0" } }),
      ],
    });
    await expect(
      refusalsOf(
        builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
      )
    ).resolves.toStrictEqual([
      `${name}@1.0.0: its package.json states other dependencies than the registry's metadata`,
    ]);
  });

  it("is refused for what its own package.json says, field by field, whatever else is in it", async () => {
    const { builder, app } = await builderWithApp();
    const scripted = await crafted((own) => [
      manifestEntry(own, {
        scripts: { postinstall: "node steal.js", other: null },
      }),
    ]);
    const prepared = await crafted((own) => [
      manifestEntry(own, { scripts: { prepare: "node build.js" } }),
    ]);
    const darwin = await crafted((own) => [
      manifestEntry(own, { os: ["darwin"], cpu: ["arm64"] }),
    ]);
    const bundling = await crafted((own) => [
      manifestEntry(own, { bundleDependencies: ["hidden"] }),
    ]);
    const malformed = await crafted((own) => [
      manifestEntry(own, { scripts: ["postinstall"] }),
    ]);
    await expect(
      Promise.all(
        [scripted, prepared, darwin, bundling, malformed].map(
          async (name) =>
            await refusalsOf(
              builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
            )
        )
      )
    ).resolves.toStrictEqual([
      [`${scripted}@1.0.0: it has install scripts: postinstall`],
      [`${prepared}@1.0.0: it has install scripts: prepare`],
      [`${darwin}@1.0.0: it runs only on some operating systems or processors`],
      [`${bundling}@1.0.0: it bundles packages the graph doesn't name`],
      [`${malformed}@1.0.0: its package.json can't be read`],
    ]);
  });

  it("is refused when its package.json says it is another package, or depends on others than the registry says", async () => {
    const { builder, app } = await builderWithApp();
    const impostor = named("impostor");
    await publish({
      name: impostor,
      version: "1.0.0",
      entries: [
        {
          path: "package/package.json",
          content: JSON.stringify({ name: "react", version: "1.0.0" }),
        },
      ],
    });
    const confused = named("confused");
    await publish({
      name: confused,
      version: "1.0.0",
      manifest: { dependencies: {} },
      entries: [
        {
          path: "package/package.json",
          content: JSON.stringify({
            name: confused,
            version: "1.0.0",
            dependencies: { "left-pad": "^1.0.0" },
          }),
        },
      ],
    });
    const missing = await crafted(() => [
      { path: "package/index.js", content: "x" },
    ]);
    await expect(
      Promise.all(
        [impostor, confused, missing].map(
          async (name) =>
            await refusalsOf(
              builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
            )
        )
      )
    ).resolves.toStrictEqual([
      [
        `${impostor}@1.0.0: its package.json says it is react@1.0.0, not ${impostor}@1.0.0`,
      ],
      [
        `${confused}@1.0.0: its package.json states other dependencies than the registry's metadata`,
      ],
      [`${missing}@1.0.0: its package.json can't be read`],
    ]);
  });
});

describe("a chat's agent", () => {
  it("resolves and proposes, getting the request and lock, and the graph waits for a person", async () => {
    const admin = await personApi("admin");
    const builder = await personApi("builder");
    const { id: existing } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, existing, { "AGENTS.md": "# Ledger\n" });
    const { id: app } = await builder.api.apps.create({
      name: `App ${unique()}`,
    });
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const chat = await chatOf(
      builder.userId,
      codeStep(`export default async (env) => {
        const { request, lock } = await env.build.resolveDependencies(${JSON.stringify(app)}, ${JSON.stringify(
          intentFor(app, { [dates]: "^1.0.0" })
        )});
        return { status: request.status, direct: lock.direct, keys: Object.keys(env.build).length };
      };`),
      says("Proposed the date library.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read", "write"],
      binding: "APP_LIBRARY",
    });

    await chat.ask("Add a date library");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const returned = z
      .object({ status: z.string(), direct: z.record(z.string(), z.string()) })
      .loose()
      .parse(JSON.parse(result?.text.replace("Returned:\n", "") ?? "null"));
    expect(returned).toMatchObject({
      status: "pending",
      direct: { [dates]: "1.0.0" },
    });
    const status = await builder.api.dependencies.status(app);
    expect(status.pending?.requestedVia).not.toBeNull();
    expect(status.approved).toBeNull();
  });
});

/** The graphs `app` holds a lock for, in no order. */
const lockedGraphs = async (app: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT graph_hash FROM dependency_locks WHERE app_id = ?"
  )
    .bind(app)
    .all<{ graph_hash: string }>();
  return results.map(({ graph_hash: hash }) => hash).toSorted();
};

/** Whether `key` is recorded for cleanup. */
const recordedForCleanup = async (key: string): Promise<boolean> =>
  (await env.DB.prepare("SELECT 1 FROM package_cleanups WHERE key = ?")
    .bind(key)
    .first()) !== null;

/** Where the deployment keeps the tarball whose integrity is `integrity`. */
const tarballKeyOf = (integrity: string): string =>
  `npm-tarballs/${toHex(
    Uint8Array.from(
      atob(integrity.slice("sha512-".length)),
      (char) => char.codePointAt(0) ?? 0
    )
  )}.tgz`;

/** An admin who approves dependencies, and a way to approve or deny a request. */
const approverOf = async () => {
  const admin = await personApi("admin");
  await admin.api.dependencies.grantApprover({
    type: "person",
    userId: admin.userId,
  });
  return async (
    request: { id: string; graphHash: string },
    approved = true
  ): Promise<void> => {
    const { policyGeneration } = await admin.api.dependencies.waiting();
    await admin.api.dependencies.decide(request.id, {
      approved,
      reviewed: { graphHash: request.graphHash, policyGeneration },
    });
  };
};

/** Connect, refusing as busy the first `times` asks for metadata. */
const busyFor = (times: number) => {
  const asked = { count: 0 };
  const connect = new Proxy(env.CONNECT, {
    get: (target, property): unknown => {
      if (property === "npmMetadata") {
        return async (name: string) => {
          asked.count += 1;
          if (asked.count <= times) {
            throw packageErrors.create("package.registry_busy");
          }
          return await target.npmMetadata(name);
        };
      }
      // An RPC binding's methods are called on it, never bound.
      return property === "npmTarball"
        ? async (request: Parameters<typeof target.npmTarball>[0]) =>
            await target.npmTarball(request)
        : Reflect.get(target, property);
    },
  });
  return { connect, asked };
};

describe("an App's locks and the files they name", () => {
  it("stores no lock when its request can't be stored", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const identity = await builder.api.whoami();
    // Just before each batch, another proposal for the App takes the
    // place of the one read: the batch's request can't be stored.
    const db = racingDb(async (target) => {
      await target
        .prepare(
          "INSERT OR IGNORE INTO dependency_requests (id, app_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation, decided_by, decided_at, decided_generation, reason) VALUES (?, ?, 'rev-0', ?, '[\"browser\"]', 'Another', '{}', '{\"direct\":[],\"findings\":[]}', 1, 1, 0, 0, NULL, 'pending', ?, NULL, ?, 0, NULL, NULL, NULL, NULL)"
        )
        .bind(
          crypto.randomUUID(),
          app,
          "f".repeat(64),
          identity.userId,
          Date.now()
        )
        .run();
      await target
        .prepare(
          "UPDATE dependency_requests SET id = ? WHERE app_id = ? AND status = 'pending'"
        )
        .bind(crypto.randomUUID(), app)
        .run();
    });

    const outcome = await failure(
      resolveDependencies(
        { ...env, DB: db },
        identity,
        intentFor(app, { [dates]: "^1.0.0" })
      )
    );
    expect({
      code: outcome.code,
      locks: await lockedGraphs(app),
    }).toStrictEqual({ code: "dependency.stale", locks: [] });
  });

  it("deletes a lock no pending or approved request names, records its tarballs, and the cron deletes those no lock names", async () => {
    const decide = await approverOf();
    const { builder, app } = await builderWithApp();
    const [kept, replaced, denied] = [
      named("kept"),
      named("replaced"),
      named("denied"),
    ];
    const keptIntegrity = await publish(plain(kept, "1.0.0"));
    const replacedIntegrity = await publish(plain(replaced, "1.0.0"));
    const deniedIntegrity = await publish(plain(denied, "1.0.0"));
    const resolve = async (name: string) =>
      await builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }));

    const approved = await resolve(kept);
    await decide(approved.request);
    // Replaced while it waits, then the one that replaced it denied.
    await resolve(replaced);
    const refused = await resolve(denied);
    await decide(refused.request, false);
    const locks = await lockedGraphs(app);
    const recorded = {
      replaced: await recordedForCleanup(replacedIntegrity),
      denied: await recordedForCleanup(deniedIntegrity),
    };

    // An hour on, the cron deletes what no lock names, and keeps the rest.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    for (let run = 0; run < 20; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await sweepPackageFiles(env, later);
    }
    const stored = async (integrity: string) =>
      (await env.FILES.head(tarballKeyOf(integrity))) !== null;

    expect({
      locks,
      recorded,
      after: {
        kept: await stored(keptIntegrity),
        replaced: await stored(replacedIntegrity),
        denied: await stored(deniedIntegrity),
        records: [
          await recordedForCleanup(keptIntegrity),
          await recordedForCleanup(replacedIntegrity),
          await recordedForCleanup(deniedIntegrity),
        ],
      },
    }).toStrictEqual({
      locks: [approved.request.graphHash],
      recorded: { replaced: true, denied: true },
      after: {
        kept: true,
        replaced: false,
        denied: false,
        records: [false, false, false],
      },
    });
  });

  it("keeps approving an App's new graphs past its number of locks, giving up those of older approvals", async () => {
    const decide = await approverOf();
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    const versions = Array.from({ length: 33 }, (_, index) => `1.0.${index}`);
    for (const version of versions) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await publish(plain(dates, version));
    }
    // The tests' limit is three locks (vite.config.ts): each new graph,
    // approved in turn, takes the room of the oldest approval's.
    const statuses: string[] = [];
    let first = "";
    for (const version of versions) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const { request } = await builder.api.dependencies.resolve(
        intentFor(app, { [dates]: version })
      );
      first ||= request.id;
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await decide(request);
      statuses.push(request.status);
    }
    const locks = await lockedGraphs(app);
    // Back to the first graph: its approval stands, and its lock is
    // written again.
    const back = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: versions[0] ?? "" })
    );
    const locksAfter = await lockedGraphs(app);
    expect({
      statuses: new Set(statuses),
      locks: locks.length <= 3,
      back: [back.request.id === first, back.request.status],
      backLocked: locksAfter.includes(back.request.graphHash),
    }).toStrictEqual({
      statuses: new Set(["pending"]),
      locks: true,
      back: [true, "approved"],
      backLocked: true,
    });
  });

  it("lets a graph take the room of the waiting request it replaces, at the limit, new or approved before", async () => {
    const decide = await approverOf();
    const { builder, app } = await builderWithApp();
    const [old, browser, server, waiting, replacing] = [
      named("one"),
      named("two"),
      named("three"),
      named("four"),
      named("five"),
    ];
    const names = [old, browser, server, waiting, replacing];
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await publish(plain(name, "1.0.0"));
    }
    const resolve = async (
      name: string,
      targets: ("browser" | "server" | "workflow")[]
    ) =>
      await builder.api.dependencies.resolve(
        intentFor(app, { [name]: "1" }, { targets })
      );
    // An approval no longer in use, then the latest approval for each of
    // two sets of targets: the tests' limit of three locks (vite.config.ts).
    for (const [name, targets] of [
      [old, ["browser"]],
      [browser, ["browser"]],
      [server, ["server"]],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const { request } = await resolve(name, [...targets]);
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await decide(request);
    }
    // A graph waiting for a decision takes the old approval's room.
    const first = await resolve(waiting, ["workflow"]);
    // Two locks in use and one waiting: another graph replaces the one
    // waiting, and takes its room.
    const replaced = await resolve(replacing, ["workflow"]);
    const afterReplace = await lockedGraphs(app);
    // Back to the old approval, whose lock went: it replaces the one
    // waiting too.
    const back = await resolve(old, ["browser"]);
    const afterBack = await lockedGraphs(app);
    expect({
      replaced: replaced.request.status,
      replacedLocked: afterReplace.includes(replaced.request.graphHash),
      firstGone: afterReplace.includes(first.request.graphHash),
      locks: afterReplace.length,
      back: back.request.status,
      backLocked: afterBack.includes(back.request.graphHash),
      replacedGone: afterBack.includes(replaced.request.graphHash),
      locksAfterBack: afterBack.length,
    }).toStrictEqual({
      replaced: "pending",
      replacedLocked: true,
      firstGone: false,
      locks: 3,
      back: "approved",
      backLocked: true,
      replacedGone: false,
      locksAfterBack: 3,
    });
  });

  it("refuses a lock past the limit when the room goes as the batch runs, with a clear refusal", async () => {
    const decide = await approverOf();
    const { builder, app } = await builderWithApp();
    const [browser, server, more] = [
      named("one"),
      named("two"),
      named("three"),
    ];
    for (const name of [browser, server, more]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await publish(plain(name, "1.0.0"));
    }
    // Two locks in use, each the latest approval for its targets: one
    // short of the tests' limit of three.
    for (const [name, targets] of [
      [browser, ["browser"]],
      [server, ["server"]],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      const { request } = await builder.api.dependencies.resolve(
        intentFor(app, { [name]: "1" }, { targets: [...targets] })
      );
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await decide(request);
    }
    const identity = await builder.api.whoami();
    // Just before the batch that stores the third, another lock in use
    // lands: the insert's own count refuses it.
    const db = racingDb(async (target) => {
      await target.batch([
        target
          .prepare(
            "INSERT OR IGNORE INTO dependency_requests (id, app_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation, decided_by, decided_at, decided_generation, reason) VALUES (?, ?, 'rev-0', ?, '[\"workflow\"]', 'Another', '{}', '{\"direct\":[],\"findings\":[]}', 1, 1, 0, 0, NULL, 'approved', ?, NULL, ?, 0, ?, ?, 0, NULL)"
          )
          .bind(
            `raced-${app}`,
            app,
            "e".repeat(64),
            identity.userId,
            Date.now(),
            identity.userId,
            Date.now()
          ),
        target
          .prepare(
            "INSERT OR IGNORE INTO dependency_locks (app_id, graph_hash, lock, created_at) VALUES (?, ?, '{}', ?)"
          )
          .bind(app, "e".repeat(64), Date.now()),
      ]);
    });
    const refused = await failure(
      resolveDependencies(
        { ...env, DB: db },
        identity,
        intentFor(app, { [more]: "1" })
      )
    );
    const locks = await lockedGraphs(app);
    expect({ refused, locks: locks.length }).toStrictEqual({
      refused: {
        code: "package.quota",
        details: { quota: "appLocks", limit: 3 },
      },
      locks: 3,
    });
  });

  it("starts over when another write changes the lock just before the batch, and says so after three tries", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const intent = intentFor(app, { [dates]: "^1.0.0" });
    await builder.api.dependencies.resolve(intent);
    const identity = await builder.api.whoami();
    // Just before each batch, the lock's text changes under it.
    const db = racingDb(async (target) => {
      await target
        .prepare(
          "UPDATE dependency_locks SET lock = lock || ' ' WHERE app_id = ?"
        )
        .bind(app)
        .run();
    });
    const outcome = await failure(
      resolveDependencies({ ...env, DB: db }, identity, intent)
    );
    expect(outcome.code).toBe("dependency.stale");
  });

  it("asks connect again after a pause while it is reading too much at once, and gives up after a few tries", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const identity = await builder.api.whoami();
    const once = busyFor(1);
    const resolved = await resolveDependencies(
      { ...env, CONNECT: once.connect },
      identity,
      intentFor(app, { [dates]: "^1.0.0" })
    );
    const always = busyFor(100);
    const refused = await failure(
      resolveDependencies(
        { ...env, CONNECT: always.connect },
        identity,
        intentFor(app, { [dates]: "^1.0.0" })
      )
    );
    expect({
      resolved: resolved.lock.direct,
      askedOnce: once.asked.count,
      refused: refused.code,
      askedAlways: always.asked.count,
    }).toStrictEqual({
      resolved: { [dates]: "1.0.0" },
      askedOnce: 2,
      refused: "package.registry_busy",
      askedAlways: 4,
    });
  });
});
