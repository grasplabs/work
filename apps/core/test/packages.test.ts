import { platformPeers } from "@grasp-os/compiler";
import { dependencyMaxFindings } from "@grasp-os/shared/dependencies";
import { sha512Integrity, toHex } from "@grasp-os/shared/encoding";
import { packageErrors } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  admitDependencies,
  decideDependency,
} from "../src/dependencies/requests.ts";
import { sweepPackageFiles } from "../src/packages/cleanup.ts";
import { resolveDependencies } from "../src/packages/resolve.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  advise,
  askedPaths,
  crafted,
  daysAgo,
  failure,
  intentFor,
  manifestEntry,
  named,
  osvAnswers,
  noise,
  plain,
  tarballBytes,
  publish,
  reportToOsv,
  refusalsOf,
} from "./npm.ts";
import type { Entries } from "./npm.ts";
import { racingDb } from "./racing-db.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

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

/** An advisory as the registry sends one. */
const advisory = (more: Record<string, unknown>) => ({
  id: 1_000_001,
  url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  title: "Regular expression denial of service",
  severity: "high",
  vulnerable_versions: "<1.2.1",
  ...more,
});
/** How a decision went: `ok`, or the code and details it was refused with. */
type Decided = "ok" | { code: string; details: Record<string, unknown> };

/** A decision's outcome as its code, `ok` when it went through. */
const decidedCode = (decided: Decided | undefined) =>
  typeof decided === "object" ? decided.code : decided;

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
    const { policyGeneration } = await builder.api.dependencies.status({
      app,
    });
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

  it("shows the approver each package named like a popular one, and each advisory affecting its exact version", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    // One letter swapped in lodash's name; normalised alike to react-dom.
    const squat = "loadsh";
    const merged = "reactdom";
    await publish(plain(dates, "1.2.0"));
    await publish(plain(squat, "1.0.0"));
    await publish(plain(merged, "1.0.0"));
    const beta = named("beta");
    await publish(plain(beta, "2.0.0-beta.1"));
    // A scope's package named after the popular one it serves: noted only.
    const scoped = `@${named("octo")}/request`;
    await publish(plain(scoped, "1.0.0"));
    await advise(dates, advisory({}));
    // A prerelease of the release a range stops before: inside it.
    await advise(
      beta,
      advisory({
        id: 4,
        url: undefined,
        vulnerable_versions: "<2.0.0",
        severity: "info",
      })
    );
    // Not this version: left out.
    await advise(
      dates,
      advisory({
        id: 2,
        url: undefined,
        vulnerable_versions: "<1.0.0",
        severity: "critical",
      })
    );
    // A range it can't read: kept, as it can't be ruled out.
    await advise(
      dates,
      advisory({
        id: 3,
        url: undefined,
        vulnerable_versions: "not a range",
        severity: "low",
      })
    );
    const { request } = await builder.api.dependencies.resolve(
      intentFor(app, {
        [dates]: "1.2.0",
        [squat]: "1.0.0",
        [merged]: "1.0.0",
        [beta]: "2.0.0-beta.1",
        [scoped]: "1.0.0",
      })
    );
    const review = await builder.api.dependencies.get(request.id);
    const clean = named("clean");
    await publish(plain(clean, "1.0.0"));
    const { request: cleanRequest } = await builder.api.dependencies.resolve(
      intentFor(app, { [clean]: "1.0.0" })
    );
    const cleanReview = await builder.api.dependencies.get(cleanRequest.id);
    // A name Object.prototype also has: asked of the registry as any
    // other, which never answers for it, and says so.
    await publish(plain("constructor", "1.0.0"));
    const inherited = await failure(
      resolveDependencies(
        env,
        await builder.api.whoami(),
        intentFor(app, { constructor: "1.0.0" })
      )
    );
    expect({
      findings: review.findings.map(({ kind, package: ref, severity, id }) => ({
        kind,
        package: `${ref.name}@${ref.version}`,
        severity,
        id,
      })),
      lookalikes: review.findings
        .filter(({ kind }) => kind === "lookalike")
        .map(({ summary }) => summary),
      clean: cleanReview.findings,
      inherited: inherited.code,
    }).toStrictEqual({
      // Gravest first.
      findings: [
        {
          kind: "security",
          package: `${dates}@1.2.0`,
          severity: "high",
          id: "GHSA-aaaa-bbbb-cccc",
        },
        {
          kind: "lookalike",
          package: `${squat}@1.0.0`,
          severity: "moderate",
          id: null,
        },
        {
          kind: "lookalike",
          package: `${merged}@1.0.0`,
          severity: "moderate",
          id: null,
        },
        {
          kind: "security",
          package: `${dates}@1.2.0`,
          severity: "low",
          id: "npm:3",
        },
        {
          kind: "lookalike",
          package: `${scoped}@1.0.0`,
          severity: "info",
          id: null,
        },
        {
          kind: "security",
          package: `${beta}@2.0.0-beta.1`,
          severity: "info",
          id: "npm:4",
        },
      ],
      lookalikes: [
        "Its name looks like lodash's, a popular package: check it is the one meant.",
        "Its name looks like react-dom's, a popular package: check it is the one meant.",
        `Published under ${scoped.split("/")[0]}, not the unscoped request, a popular package: check it is the one meant.`,
      ],
      clean: [],
      inherited: "package.advisories_unchecked",
    });
  });

  it("refuses a graph with a version known as malware, audited and stored as no request, and only warns on any other advisory", async () => {
    const { builder, app } = await builderWithApp();
    // A name as long as npm allows, near enough: what is audited of it fits.
    const stream = named(`flatmap-stream-${"x".repeat(180)}`);
    const dates = named("dates");
    // Its install script would refuse it too: malware is refused as such.
    await publish(
      plain(stream, "0.1.1", {
        dependencies: { [dates]: "^1.0.0" },
        scripts: { postinstall: "node steal.js" },
      })
    );
    await publish(plain(dates, "1.0.0"));
    // Embedded Malicious Code: malware, however grave the registry says.
    await advise(
      stream,
      advisory({
        url: "https://github.com/advisories/GHSA-9x64-5r7x-2q53",
        vulnerable_versions: "=0.1.1",
        severity: "moderate",
        cwe: ["CWE-506"],
      })
    );
    // Critical, but not malware: shown, never refused.
    await advise(
      dates,
      advisory({
        severity: "critical",
        cwe: ["CWE-94"],
        vulnerable_versions: "*",
      })
    );
    let refused: Awaited<ReturnType<typeof failure>> | undefined;
    const events = await auditedDuring(async () => {
      refused = await failure(
        builder.api.dependencies.resolve(intentFor(app, { [stream]: "0.1.1" }))
      );
    });
    const { pending } = await builder.api.dependencies.status({ app });
    const { request } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "1.0.0" })
    );
    const review = await builder.api.dependencies.get(request.id);
    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "dependency.malware_refused")
        .map(({ detail }) => detail),
      pendingAfterRefusal: pending,
      warned: review.findings.map(({ severity, id }) => ({ severity, id })),
    }).toStrictEqual({
      refused: {
        code: "dependency.malware",
        details: { packages: [`${stream}@0.1.1 (GHSA-9x64-5r7x-2q53)`] },
      },
      audited: [
        {
          app,
          package: stream,
          version: "0.1.1",
          advisory: "GHSA-9x64-5r7x-2q53",
          found: 1,
        },
      ],
      pendingAfterRefusal: null,
      warned: [{ severity: "critical", id: "GHSA-aaaa-bbbb-cccc" }],
    });
  });

  it("refuses a graph with a version OSV.dev reports as malware, which the registry's advisories don't carry, ignores its other entries, and proposes nothing when OSV can't be read", async () => {
    const { builder, app } = await builderWithApp();
    // As GitHub's malware advisories are: absent from the registry's bulk
    // answer, present in OSV.dev as an OpenSSF malicious-packages report.
    const squat = named("geeksquad-core");
    const dates = named("dates");
    await publish(
      plain(squat, "9999.0.0", { dependencies: { [dates]: "^1.0.0" } })
    );
    await publish(plain(dates, "1.0.0"));
    await reportToOsv(squat, "9999.0.0", "MAL-2026-12435");
    // OSV's other entries are the registry's advisories' to show: not
    // refused here.
    await reportToOsv(dates, "1.0.0", "GHSA-35jh-r3h4-6jhm");
    let refused: Awaited<ReturnType<typeof failure>> | undefined;
    const events = await auditedDuring(async () => {
      refused = await failure(
        builder.api.dependencies.resolve(intentFor(app, { [squat]: "9999" }))
      );
    });
    const { request } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "1.0.0" })
    );
    // Unread, never taken as none: no request is proposed.
    const unread = named("unread");
    await publish(plain(unread, "1.0.0"));
    await osvAnswers(unread, 503);
    let unchecked: Awaited<ReturnType<typeof failure>> | undefined;
    try {
      unchecked = await failure(
        builder.api.dependencies.resolve(intentFor(app, { [unread]: "1" }))
      );
    } finally {
      await osvAnswers(unread, null);
    }
    const { pending } = await builder.api.dependencies.status({ app });
    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "dependency.malware_refused")
        .map(({ detail }) => detail),
      proposed: request.status,
      unchecked: unchecked?.code,
      pending: pending?.id,
    }).toStrictEqual({
      refused: {
        code: "dependency.malware",
        details: { packages: [`${squat}@9999.0.0 (MAL-2026-12435)`] },
      },
      audited: [
        {
          app,
          package: squat,
          version: "9999.0.0",
          advisory: "MAL-2026-12435",
          found: 1,
        },
      ],
      proposed: "pending",
      unchecked: "package.malware_unchecked",
      pending: request.id,
    });
  });

  it("refuses to approve a graph reported as malware after it was proposed, by OSV.dev or the registry, fails closed when OSV can't be read, and still lets an admin deny it", async () => {
    const { builder, app } = await builderWithApp();
    const admin = await personApi("admin");
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: admin.userId,
    });
    const decide = async (
      request: { id: string; graphHash: string },
      approved: boolean
    ): Promise<Decided> => {
      const { policyGeneration } = await admin.api.dependencies.waiting();
      try {
        await admin.api.dependencies.decide(request.id, {
          approved,
          reviewed: { graphHash: request.graphHash, policyGeneration },
        });
        return "ok";
      } catch (error) {
        const { code, details } = z
          .object({
            code: z.string(),
            details: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(error);
        return { code, details: details ?? {} };
      }
    };
    // Proposed while OSV.dev knew nothing of it; reported before the
    // admin looked.
    const turned = named("turned");
    const dates = named("dates");
    await publish(
      plain(turned, "1.0.0", { dependencies: { [dates]: "^1.0.0" } })
    );
    await publish(plain(dates, "1.0.0"));
    const { request: reported } = await builder.api.dependencies.resolve(
      intentFor(app, { [turned]: "1.0.0" })
    );
    await reportToOsv(dates, "1.0.0", "MAL-2026-20001");
    let refused: Decided | undefined;
    const events = await auditedDuring(async () => {
      refused = await decide(reported, true);
    });
    const afterRefusal = await builder.api.dependencies.status({ app });
    // OSV.dev unread at approval: never taken as no report.
    const other = await builderWithApp();
    const unread = named("unread");
    await publish(plain(unread, "1.0.0"));
    const { request: unchecked } = await other.builder.api.dependencies.resolve(
      intentFor(other.app, { [unread]: "1.0.0" })
    );
    await osvAnswers(unread, 503);
    let unreadApproval: Decided | undefined;
    let denial: Decided | undefined;
    let pendingWhileUnread: string | undefined;
    let unreadEvents: Awaited<ReturnType<typeof auditedDuring>> = [];
    try {
      unreadEvents = await auditedDuring(async () => {
        unreadApproval = await decide(unchecked, true);
      });
      const whileUnread = await other.builder.api.dependencies.status({
        app: other.app,
      });
      pendingWhileUnread = whileUnread.pending?.id;
      // Saying no never needs OSV.dev.
      denial = await decide(unchecked, false);
    } finally {
      await osvAnswers(unread, null);
    }
    // Reported by the registry instead, as malware (CWE-506), after it
    // was proposed: refused as at a resolve.
    const fourth = await builderWithApp();
    const advised = named("advised");
    await publish(plain(advised, "1.0.0"));
    const { request: advisedRequest } =
      await fourth.builder.api.dependencies.resolve(
        intentFor(fourth.app, { [advised]: "1.0.0" })
      );
    await advise(
      advised,
      advisory({
        url: "https://github.com/advisories/GHSA-mmmm-wwww-2026",
        vulnerable_versions: "=1.0.0",
        severity: "low",
        cwe: ["CWE-506"],
      })
    );
    const advisedApproval = await decide(advisedRequest, true);
    // connect failing outright, not as a refusal of its own: refused all
    // the same, and audited as unexpected.
    const fifth = await builderWithApp();
    const broken = named("broken");
    await publish(plain(broken, "1.0.0"));
    const { request: brokenRequest } =
      await fifth.builder.api.dependencies.resolve(
        intentFor(fifth.app, { [broken]: "1.0.0" })
      );
    const failing = new Proxy(env.CONNECT, {
      get: (target, property): unknown => {
        if (property === "npmMalwareReports") {
          return async () => {
            await Promise.resolve();
            throw new Error("connect went away");
          };
        }
        // An RPC binding's methods are called on it, never bound.
        return property === "npmAdvisories"
          ? async (request: Parameters<typeof target.npmAdvisories>[0]) =>
              await target.npmAdvisories(request)
          : Reflect.get(target, property);
      },
    });
    const { policyGeneration: brokenGeneration } =
      await admin.api.dependencies.waiting();
    const adminIdentity = await admin.api.whoami();
    let uncoded = "approved";
    const uncodedEvents = await auditedDuring(async () => {
      try {
        await decideDependency(
          { ...env, CONNECT: failing },
          adminIdentity,
          brokenRequest.id,
          {
            approved: true,
            reviewed: {
              graphHash: brokenRequest.graphHash,
              policyGeneration: brokenGeneration,
            },
          }
        );
      } catch (error) {
        uncoded = error instanceof Error ? error.message : "thrown";
      }
    });
    const afterUncoded = await fifth.builder.api.dependencies.status({
      app: fifth.app,
    });
    // A graph nobody reported is approved as before.
    const third = await builderWithApp();
    const clean = named("clean");
    await publish(plain(clean, "1.0.0"));
    const { request: cleanRequest } =
      await third.builder.api.dependencies.resolve(
        intentFor(third.app, { [clean]: "1.0.0" })
      );
    const approved = await decide(cleanRequest, true);
    // Decided already: stale, before OSV.dev is asked, so even while it
    // can't be read.
    await osvAnswers(clean, 503);
    let again: Decided | undefined;
    try {
      again = await decide(cleanRequest, true);
    } finally {
      await osvAnswers(clean, null);
    }

    expect({
      refused,
      audited: events
        .filter(({ action }) => action === "dependency.malware_refused")
        .map(({ detail }) => detail),
      approvedEvents: events.filter(
        ({ action }) => action === "dependency.approved"
      ).length,
      stillPending: afterRefusal.pending?.id,
      unreadApproval: decidedCode(unreadApproval),
      unreadAudited: unreadEvents
        .filter(({ action }) =>
          ["dependency.approval_refused", "dependency.approved"].includes(
            action
          )
        )
        .map(({ action, detail }) => ({
          action,
          errorCode: detail.errorCode,
        })),
      pendingWhileUnread,
      denial: decidedCode(denial),
      advisedApproval,
      uncoded: {
        refused: uncoded,
        audited: uncodedEvents
          .filter(({ action }) =>
            ["dependency.approval_refused", "dependency.approved"].includes(
              action
            )
          )
          .map(({ action, detail }) => ({
            action,
            errorCode: detail.errorCode,
          })),
        stillPending: afterUncoded.pending?.id,
      },
      approved: decidedCode(approved),
      again: decidedCode(again),
    }).toStrictEqual({
      refused: {
        code: "dependency.malware",
        details: { packages: [`${dates}@1.0.0 (MAL-2026-20001)`] },
      },
      audited: [
        {
          app,
          package: dates,
          version: "1.0.0",
          advisory: "MAL-2026-20001",
          found: 1,
          request: reported.id,
          at: "approval",
        },
      ],
      approvedEvents: 0,
      stillPending: reported.id,
      unreadApproval: "package.malware_unchecked",
      // Refused for want of a check, audited so, and nothing approved.
      unreadAudited: [
        {
          action: "dependency.approval_refused",
          errorCode: "package.malware_unchecked",
        },
      ],
      pendingWhileUnread: unchecked.id,
      denial: "ok",
      advisedApproval: {
        code: "dependency.malware",
        details: { packages: [`${advised}@1.0.0 (GHSA-mmmm-wwww-2026)`] },
      },
      uncoded: {
        refused: "connect went away",
        audited: [
          {
            action: "dependency.approval_refused",
            errorCode: "internal.unexpected",
          },
        ],
        stillPending: brokenRequest.id,
      },
      approved: "ok",
      again: "dependency.stale",
    });
  });

  it("keeps the gravest findings a request can hold, and counts the rest", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    // One more than a request keeps, the gravest last.
    for (let id = 1; id <= dependencyMaxFindings; id += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await advise(dates, advisory({ id, url: undefined, severity: "low" }));
    }
    await advise(
      dates,
      advisory({ id: 9999, url: undefined, severity: "critical" })
    );
    const { request } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "1.0.0" })
    );
    const review = await builder.api.dependencies.get(request.id);
    // One more found, below those kept: the same findings, another total.
    await advise(
      dates,
      advisory({ id: 5000, url: undefined, severity: "info" })
    );
    const { request: again } = await builder.api.dependencies.resolve(
      intentFor(app, { [dates]: "1.0.0" })
    );
    const reviewAgain = await builder.api.dependencies.get(again.id);
    expect({
      kept: review.findings.length,
      counted: review.counts.findings,
      gravest: review.findings[0]?.id,
      countedAgain: reviewAgain.counts.findings,
      keptAgain: reviewAgain.findings,
    }).toStrictEqual({
      kept: dependencyMaxFindings,
      counted: dependencyMaxFindings + 1,
      gravest: "npm:9999",
      countedAgain: dependencyMaxFindings + 2,
      keptAgain: review.findings,
    });
  });

  it("takes every dependency the API is sent, a name Object.prototype also has included, each once", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    // Never deleted on the way in, as a key of an object would be: it
    // reaches the registry's advisories, which never answer for it.
    await publish(plain("constructor", "1.0.1"));
    const inherited = await failure(
      builder.api.dependencies.resolve(
        intentFor(app, { constructor: "1.0.1", [dates]: "1.0.0" })
      )
    );
    const twice = await failure(
      builder.api.dependencies.resolve({
        ...intentFor(app, { [dates]: "1.0.0" }),
        dependencies: [
          { name: dates, range: "1.0.0" },
          { name: dates, range: "^1.0.0" },
        ],
      })
    );
    expect({
      inherited: inherited.code,
      twice: twice.code,
    }).toStrictEqual({
      inherited: "package.advisories_unchecked",
      twice: "dependency.invalid",
    });
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

/** The tests' package limits (vite.config.ts, `PACKAGE_LIMITS`). */
const testPackageLimits = z
  .record(z.string(), z.number())
  .parse(env.PACKAGE_LIMITS);

/** The tests' environment with one package's tarball limit set to `archiveBytes`. */
const withArchiveLimit = (archiveBytes: number): Env => ({
  ...env,
  PACKAGE_LIMITS: { ...testPackageLimits, archiveBytes },
});

/** A chain of `length` packages, each depending on the next: its first. */
const chainOf = async (length: number): Promise<string> => {
  const base = named("chain");
  for (let depth = length; depth >= 1; depth -= 1) {
    // Each depends on the next, so they are published from the end.
    // oxlint-disable-next-line no-await-in-loop
    await publish(
      plain(
        `${base}-${depth}`,
        "1.0.0",
        depth < length
          ? { dependencies: { [`${base}-${depth + 1}`]: "1" } }
          : {}
      )
    );
  }
  return `${base}-1`;
};

/** A package with `width` dependencies of its own: `width + 1` in all. */
const wideOf = async (width: number): Promise<string> => {
  const base = named("wide");
  const leaves = Array.from(
    { length: width },
    (_, index) => `${base}-${index}`
  );
  await Promise.all(leaves.map(async (leaf) => await publish(plain(leaf))));
  await publish(
    plain(base, "1.0.0", {
      dependencies: Object.fromEntries(leaves.map((leaf) => [leaf, "1"])),
    })
  );
  return base;
};

/** "ok" once `promise` resolves, or its refusal's code and details. */
const okOrRefusal = async (promise: Promise<unknown>): Promise<unknown> => {
  let resolved = false;
  const refusal = await failure(
    promise.then(() => {
      resolved = true;
    })
  ).catch((error: unknown) => {
    if (resolved) {
      return;
    }
    throw error;
  });
  return refusal ?? "ok";
};

/** Resolves `name` for `app`: "ok", or the refusal's code and details. */
const resolvedOrRefused = async (
  builder: Person,
  app: string,
  name: string
): Promise<unknown> =>
  await okOrRefusal(
    builder.api.dependencies.resolve(intentFor(app, { [name]: "1" }))
  );

describe("a graph's limits", () => {
  it("takes a chain of dependencies exactly as deep as the limit, and refuses one deeper", async () => {
    const { builder, app } = await builderWithApp();
    // The tests' limit is four.
    const [deepest, tooDeep] = await Promise.all([chainOf(4), chainOf(5)]);
    expect({
      deepest: await resolvedOrRefused(builder, app, deepest),
      tooDeep: await resolvedOrRefused(builder, app, tooDeep),
    }).toStrictEqual({
      deepest: "ok",
      tooDeep: {
        code: "package.quota",
        details: { quota: "graphDepth", limit: 4 },
      },
    });
  });

  it("takes a graph of exactly as many packages as the limit, and refuses one more", async () => {
    const { builder, app } = await builderWithApp();
    // The tests' limit is twelve: eleven dependencies and the package.
    const [widest, tooWide] = await Promise.all([wideOf(11), wideOf(12)]);
    expect({
      widest: await resolvedOrRefused(builder, app, widest),
      tooWide: await resolvedOrRefused(builder, app, tooWide),
    }).toStrictEqual({
      widest: "ok",
      tooWide: {
        code: "package.quota",
        details: { quota: "graphPackages", limit: 12 },
      },
    });
  });

  it("takes one package's tarball exactly as large as the limit, compressed, and refuses one a byte larger", async () => {
    const { builder, app } = await builderWithApp();
    const name = named("bulky");
    // Noise doesn't compress: its tarball is about as large as it.
    await publish({
      ...plain(name),
      files: { "index.js": "export {};", "data.txt": noise(200 * 1024) },
    });
    const bytes = await tarballBytes(name, "1.0.0");
    const by = await builder.api.whoami();
    // The limit set at the tarball's size, then a byte under it.
    const at = await okOrRefusal(
      resolveDependencies(
        withArchiveLimit(bytes),
        by,
        intentFor(app, { [name]: "1" })
      )
    );
    const past = await okOrRefusal(
      resolveDependencies(
        withArchiveLimit(bytes - 1),
        by,
        intentFor(app, { [name]: "1" })
      )
    );
    expect({ at, past }).toStrictEqual({
      at: "ok",
      past: {
        code: "package.quota",
        details: { quota: "archiveBytes", limit: bytes - 1 },
      },
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
      codeStep(`export default async (self, env) => {
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
    const status = await builder.api.dependencies.status({ app });
    expect(status.pending?.requestedVia).not.toBeNull();
    expect(status.approved).toBeNull();
  });
});

/** The graphs `app` holds a lock for, in no order. */
const lockedGraphs = async (app: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT graph_hash FROM dependency_locks WHERE subject_type = 'app' AND subject_id = ?"
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

/** Connect, refusing as busy the first `times` asks of `busy`. */
const busyFor = (
  times: number,
  busy: "npmMetadata" | "npmAdvisories" = "npmMetadata"
) => {
  const asked = { count: 0 };
  const refuse = () => {
    asked.count += 1;
    if (asked.count <= times) {
      throw packageErrors.create("package.registry_busy");
    }
  };
  const connect = new Proxy(env.CONNECT, {
    get: (target, property): unknown => {
      // An RPC binding's methods are called on it, never bound.
      if (property === "npmMetadata") {
        return async (name: string) => {
          if (busy === "npmMetadata") {
            refuse();
          }
          return await target.npmMetadata(name);
        };
      }
      if (property === "npmAdvisories") {
        return async (request: Parameters<typeof target.npmAdvisories>[0]) => {
          if (busy === "npmAdvisories") {
            refuse();
          }
          return await target.npmAdvisories(request);
        };
      }
      return property === "npmTarball"
        ? async (request: Parameters<typeof target.npmTarball>[0]) =>
            await target.npmTarball(request)
        : Reflect.get(target, property);
    },
  });
  return { connect, asked };
};

describe("an App's locks and the files they name", () => {
  it("refuses a resolution whose advisories couldn't be read, storing no request as one without findings", async () => {
    const { builder, app } = await builderWithApp();
    const dates = named("dates");
    await publish(plain(dates, "1.0.0"));
    const identity = await builder.api.whoami();
    const unread = new Proxy(env.CONNECT, {
      get: (target, property): unknown => {
        if (property === "npmAdvisories") {
          return async () => {
            await Promise.resolve();
            throw packageErrors.create("package.registry_unavailable");
          };
        }
        // An RPC binding's methods are called on it, never bound.
        if (property === "npmMetadata") {
          return async (name: string) => await target.npmMetadata(name);
        }
        return property === "npmTarball"
          ? async (request: Parameters<typeof target.npmTarball>[0]) =>
              await target.npmTarball(request)
          : Reflect.get(target, property);
      },
    });
    const outcome = await failure(
      resolveDependencies(
        { ...env, CONNECT: unread },
        identity,
        intentFor(app, { [dates]: "^1.0.0" })
      )
    );
    expect({
      code: outcome.code,
      locks: await lockedGraphs(app),
    }).toStrictEqual({
      code: "package.registry_unavailable",
      locks: [],
    });
  });

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
          "INSERT OR IGNORE INTO dependency_requests (id, subject_type, subject_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation, decided_by, decided_at, decided_generation, reason) VALUES (?, 'app', ?, 'rev-0', ?, '[\"browser\"]', 'Another', '{}', '{\"direct\":[],\"findings\":[]}', 1, 1, 0, 0, NULL, 'pending', ?, NULL, ?, 0, NULL, NULL, NULL, NULL)"
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
          "UPDATE dependency_requests SET id = ? WHERE subject_type = 'app' AND subject_id = ? AND status = 'pending'"
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
            "INSERT OR IGNORE INTO dependency_requests (id, subject_type, subject_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation, decided_by, decided_at, decided_generation, reason) VALUES (?, 'app', ?, 'rev-0', ?, '[\"workflow\"]', 'Another', '{}', '{\"direct\":[],\"findings\":[]}', 1, 1, 0, 0, NULL, 'approved', ?, NULL, ?, 0, ?, ?, 0, NULL)"
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
            "INSERT OR IGNORE INTO dependency_locks (subject_type, subject_id, graph_hash, lock, created_at) VALUES ('app', ?, ?, '{}', ?)"
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
          "UPDATE dependency_locks SET lock = lock || ' ' WHERE subject_type = 'app' AND subject_id = ?"
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
    // The advisories too, asked once the whole graph is read.
    const advisoriesOnce = busyFor(1, "npmAdvisories");
    const advised = await resolveDependencies(
      { ...env, CONNECT: advisoriesOnce.connect },
      identity,
      intentFor(app, { [dates]: "^1.0.0" })
    );
    expect({
      resolved: resolved.lock.direct,
      askedOnce: once.asked.count,
      refused: refused.code,
      askedAlways: always.asked.count,
      advised: advised.lock.direct,
      advisoriesAsked: advisoriesOnce.asked.count,
    }).toStrictEqual({
      resolved: { [dates]: "1.0.0" },
      askedOnce: 2,
      refused: "package.registry_busy",
      askedAlways: 4,
      advised: { [dates]: "1.0.0" },
      advisoriesAsked: 2,
    });
  });
});
