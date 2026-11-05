import { dependencyGraphHash } from "@grasp-os/shared/dependencies";
import { toHex } from "@grasp-os/shared/encoding";
import { graspLockSchema, lockGraph } from "@grasp-os/shared/packages";
import type {
  DependencyIntent,
  GraspLock,
  PackageArtifactAddress,
  PackageBuild,
} from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { packageArtifactAddress } from "../src/packages/address.ts";
import { mockIdp } from "./idp.ts";
import { failure, intentFor, named, publish } from "./npm.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, coreOrigin, routed, signedInApi } from "./sign-in.ts";

// Serving an App's built packages (src/packages/serve.ts), from its threat
// model: a file served without the policy the build relies on, or as
// another type; a file of a graph no longer approved, of an artifact the
// lock no longer pins, or bytes other than the ones built; an artifact
// read by its hashes alone; code for Workers sent to a browser; a lock
// resolved against another React; the files reached by any other path;
// and the token read where a URL is logged (the router's and core's
// traces, core's request log, a Referer), so it rides in the query alone,
// which Workers redact, never the path. The packages are real builds, from
// connect's strict fake of the npm registry; what the browser then does
// under the policy is e2e/package-artifacts.e2e.ts.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** The policy every answer on the artifact path carries, exactly. */
const artifactPolicy = `default-src 'none'; script-src ${clientOrigin}; worker-src 'none'; connect-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self'; sandbox`;

/**
 * A package that does at run time what no build can see: a worker from a
 * computed name, `importScripts`, a fetch elsewhere, and CSS set from
 * script. Its stylesheet carries a font, an image and an SVG of its own.
 */
const hostilePackage = async (): Promise<string> => {
  const name = named("hostile");
  await publish({
    name,
    version: "1.0.0",
    manifest: { type: "module", main: "index.js", license: "MIT" },
    files: {
      "index.js": `import "./styles.css";
const Make = globalThis[["Wor", "ker"].join("")];
export const start = (to) => {
  globalThis.importScripts?.(to + "/imported.js");
  void fetch(to + "/fetched");
  document.documentElement.style.setProperty("--x", "url(" + to + "/var.png)");
  return new Make(new URL("./worker.js", import.meta.url));
};`,
      "styles.css": `@font-face { font-family: Hostile; src: url("./face.woff2") format("woff2"); }
.hostile { font-family: Hostile; background: url(./mark.svg), url(./photo.png); }`,
      "face.woff2": "wOF2 font bytes",
      "photo.png": "PNG image bytes",
      "mark.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`,
    },
  });
  return name;
};

/** An App whose package.json resolved to `dependencies`, approved. */
const approvedApp = async (
  dependencies: Record<string, string>,
  more: Partial<DependencyIntent> = {}
) => {
  const admin = await personApi("admin");
  await admin.api.dependencies.grantApprover({
    type: "person",
    userId: admin.userId,
  });
  const builder = await personApi("builder");
  const { id: app } = await builder.api.apps.create({
    name: `App ${named("served")}`,
  });
  const { request } = await builder.api.dependencies.resolve(
    intentFor(app, dependencies, more)
  );
  const { policyGeneration } = await admin.api.dependencies.waiting();
  await admin.api.dependencies.decide(request.id, {
    approved: true,
    reviewed: { graphHash: request.graphHash, policyGeneration },
  });
  return { admin, builder, app, graphHash: request.graphHash, request };
};

type Approved = Awaited<ReturnType<typeof approvedApp>>;

const buildOf = async (
  { builder, app, graphHash }: Approved,
  target: PackageBuild["artifact"]["target"] = "browser"
): Promise<PackageBuild> => {
  const { policyGeneration } = await builder.api.dependencies.status({
    app,
  });
  return await builder.api.dependencies.build({
    app,
    graphHash,
    target,
    policyGeneration,
  });
};

/** A hostile package's browser build, with where it is served. */
const servedBuild = async () => {
  const name = await hostilePackage();
  const approved = await approvedApp({ [name]: "1.0.0" });
  const built = await buildOf(approved);
  if (built.address === null) {
    throw new Error("A browser build has an address");
  }
  return { ...approved, name, built, address: built.address };
};

/** The App's lock, as core stores it. */
const lockFor = async ({ app, graphHash }: Approved): Promise<GraspLock> => {
  const row = await env.DB.prepare(
    "SELECT lock FROM dependency_locks WHERE subject_type = 'app' AND subject_id = ? AND graph_hash = ?"
  )
    .bind(app, graphHash)
    .first<{ lock: string }>();
  return graspLockSchema.parse(JSON.parse(row?.lock ?? "null"));
};

/** Stores `lock` as the App's, as if core had written it. */
const storeLockFor = async (
  { app, graphHash }: Approved,
  lock: GraspLock
): Promise<void> => {
  await env.DB.prepare(
    "UPDATE dependency_locks SET lock = ? WHERE subject_type = 'app' AND subject_id = ? AND graph_hash = ?"
  )
    .bind(JSON.stringify(lock), app, graphHash)
    .run();
};

/** The fields of each line `level` logged while `run` ran. */
const loggedDuring = async (
  level: "warn" | "error",
  run: () => Promise<unknown>
): Promise<unknown[]> => {
  const spy = vi.spyOn(console, level).mockReturnValue();
  try {
    await run();
    return spy.mock.calls.map(([fields]: unknown[]) => fields);
  } finally {
    spy.mockRestore();
  }
};

/** Where file `path` of an artifact at `address` is asked for, under `query`. */
const fileAt = (
  { directory, query }: PackageArtifactAddress,
  path: string,
  asked = query
): string => `${directory}${path}${asked}`;

/** The token of an address's query. */
const tokenOf = ({ query }: PackageArtifactAddress): string =>
  new URLSearchParams(query).get("token") ?? "";

/** A query with `token`. */
const withToken = (token: string): string =>
  `?${new URLSearchParams({ token }).toString()}`;

/** The status core answers `path` with. */
const statusOf = async (path: string): Promise<number> => {
  const response = await routed(path);
  return response.status;
};

/** The lines among `logged` for `event`. */
const eventsNamed = (logged: unknown[], event: string): unknown[] =>
  logged.filter(
    (fields) =>
      typeof fields === "object" &&
      fields !== null &&
      Reflect.get(fields, "event") === event
  );

const sha256 = async (bytes: BufferSource): Promise<string> =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

/** A file's bytes as core keeps them. */
const keptBytes = async (hash: string, path: string): Promise<string> => {
  const file = await env.FILES.get(`package-builds/${hash}/${path}`);
  return (await file?.text()) ?? "";
};

/** What a browser holds of an answer: its policy, sniffing, referrer and body. */
const seen = async (response: Response) => ({
  status: response.status,
  policy: response.headers.get("content-security-policy"),
  sniffing: response.headers.get("x-content-type-options"),
  referrer: response.headers.get("referrer-policy"),
  body: await response.text(),
});

describe("serving an App's built packages", () => {
  it("serves each file of a browser build as built, with its exact type, under the artifact policy", async () => {
    const { built, address } = await servedBuild();

    const files = await Promise.all(
      Object.entries(built.artifact.files).map(async ([path, file]) => {
        const response = await routed(fileAt(address, path));
        const bytes = await response.arrayBuffer();
        // A stylesheet's URLs of its own carry the address's query.
        const asBuilt = path.endsWith(".css")
          ? new TextEncoder().encode(
              new TextDecoder().decode(bytes).replaceAll(address.query, "")
            )
          : bytes;
        return {
          path,
          status: response.status,
          type: response.headers.get("content-type"),
          policy: response.headers.get("content-security-policy"),
          sniffing: response.headers.get("x-content-type-options"),
          referrer: response.headers.get("referrer-policy"),
          cache: response.headers.get("cache-control"),
          matches: (await sha256(asBuilt)) === file.sha256,
        };
      })
    );

    const typeOf: Record<string, string> = {
      js: "text/javascript; charset=utf-8",
      css: "text/css; charset=utf-8",
      svg: "image/svg+xml",
      png: "image/png",
      woff2: "font/woff2",
    };
    expect(files).toStrictEqual(
      Object.keys(built.artifact.files).map((path) => ({
        path,
        status: 200,
        type: typeOf[path.slice(path.lastIndexOf(".") + 1)],
        policy: artifactPolicy,
        sniffing: "nosniff",
        // Its query carries a token: never sent on as a Referer.
        referrer: "no-referrer",
        cache: "no-store",
        matches: true,
      }))
    );
    // An SVG among them, so `sandbox` covers one a browser opens as a page.
    expect(files.filter(({ type }) => type === "image/svg+xml")).toHaveLength(
      1
    );
  });

  it("puts the policy on every answer on its path, refusals and failures included, and never a file's bytes in a refusal", async () => {
    const { built, address, name } = await servedBuild();
    const module = `${name}.js`;
    const code = await keptBytes(built.hash, module);
    const token = tokenOf(address);
    const otherToken = `${Date.now() + 60_000}.${"A".repeat(43)}`;
    const answers = await Promise.all([
      routed(fileAt(address, module)),
      routed(fileAt(address, module, withToken(otherToken))),
      routed(
        fileAt(
          address,
          module,
          withToken(`${String(Date.now() - 1)}.${token.split(".")[1]}`)
        )
      ),
      routed(fileAt(address, module, "")),
      // The token in the path, as it once was.
      routed(`${address.directory}${token}/${module}`),
      routed(fileAt(address, "missing.js")),
      routed(fileAt(address, `..%2F..%2F${module}`)),
      routed(fileAt(address, "%E0%A4%A")),
      routed("/package-artifacts"),
      routed("/package-artifacts/"),
      routed(fileAt(address, module), { method: "POST", body: "x" }),
      // Without the router's secret: refused before any route.
      worker.fetch(
        new Request(`${coreOrigin}${fileAt(address, module)}`),
        env,
        createExecutionContext()
      ),
    ]);
    const seenAll = await Promise.all(answers.map(seen));
    expect(
      seenAll.map(({ policy, sniffing, referrer }) => ({
        policy,
        sniffing,
        referrer,
      }))
    ).toStrictEqual(
      seenAll.map(() => ({
        policy: artifactPolicy,
        sniffing: "nosniff",
        referrer: "no-referrer",
      }))
    );
    const [served, ...rest] = seenAll;
    expect(served?.body).toBe(code);
    expect(
      rest.filter(({ status, body }) => status === 200 || body.includes(code))
    ).toStrictEqual([]);
  });

  it("serves an artifact only with a token for exactly it", async () => {
    const one = await servedBuild();
    const two = await servedBuild();
    const module = `${two.name}.js`;
    // Two's token on one's artifact, and two's artifact under one's App.
    const borrowed = await routed(
      fileAt(one.address, `${one.name}.js`, two.address.query)
    );
    const moved = await routed(
      fileAt(
        {
          ...two.address,
          directory: two.address.directory.replace(two.app, one.app),
        },
        module
      )
    );
    expect([borrowed.status, moved.status]).toStrictEqual([403, 403]);
  });

  it("refuses another artifact's token of the same App", async () => {
    const served = await servedBuild();
    const admin = await personApi("admin");
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: admin.userId,
    });
    const name = named("other");
    await publish({
      name,
      version: "1.0.0",
      manifest: { type: "module", main: "index.js", license: "MIT" },
      files: { "index.js": "export const other = 1;" },
    });
    const { request } = await served.builder.api.dependencies.resolve(
      intentFor(served.app, { [name]: "1.0.0" })
    );
    const { policyGeneration } = await admin.api.dependencies.waiting();
    await admin.api.dependencies.decide(request.id, {
      approved: true,
      reviewed: { graphHash: request.graphHash, policyGeneration },
    });
    const other = await buildOf({ ...served, graphHash: request.graphHash });
    if (other.address === null) {
      throw new Error("A browser build has an address");
    }
    expect({
      own: await statusOf(fileAt(other.address, `${name}.js`)),
      // Approved, pinned and of the same App: only the token refuses it.
      borrowed: await statusOf(
        fileAt(other.address, `${name}.js`, served.address.query)
      ),
    }).toStrictEqual({ own: 200, borrowed: 403 });
  });

  it("refuses another App's token for the very artifact this App pins", async () => {
    // Two Apps approved for the same package build the same graph and the
    // same artifact: admission and the pin pass for either, so only the
    // App the token names can refuse the other's.
    const name = await hostilePackage();
    const one = await approvedApp({ [name]: "1.0.0" });
    const two = await approvedApp({ [name]: "1.0.0" });
    const [oneBuilt, twoBuilt] = [await buildOf(one), await buildOf(two)];
    if (oneBuilt.address === null || twoBuilt.address === null) {
      throw new Error("A browser build has an address");
    }
    expect({
      same: one.graphHash === two.graphHash && oneBuilt.hash === twoBuilt.hash,
      own: await statusOf(fileAt(twoBuilt.address, `${name}.js`)),
      borrowed: await statusOf(
        fileAt(twoBuilt.address, `${name}.js`, oneBuilt.address.query)
      ),
    }).toStrictEqual({ same: true, own: 200, borrowed: 403 });
  });

  it("holds a token at most six hours", async () => {
    const { app, graphHash, built, name } = await servedBuild();
    const ref = { app, graphHash, hash: built.hash };
    const hour = 60 * 60 * 1000;
    const minted = async (ago: number): Promise<number> =>
      await statusOf(
        fileAt(
          await packageArtifactAddress(env, ref, Date.now() - ago),
          `${name}.js`
        )
      );
    expect({
      threeHours: await minted(3 * hour - 60_000),
      sixHours: await minted(6 * hour + 60_000),
    }).toStrictEqual({ threeHours: 200, sixHours: 403 });
  });

  it("serves nothing once the graph is no longer approved, and logs each refusal without filling the audit trail", async () => {
    const { admin, app, request, address, name } = await servedBuild();
    const { policyGeneration, endings } = await admin.api.dependencies.impact(
      request.id
    );
    await admin.api.dependencies.revoke(request.id, {
      reviewed: {
        graphHash: request.graphHash,
        policyGeneration,
        approvalsDigest: endings.revoke.digest,
      },
      reason: "The package reads more than it says.",
    });

    const warn = vi.spyOn(console, "warn").mockReturnValue();
    let statuses: number[] = [];
    let warned: unknown[] = [];
    let events: Awaited<ReturnType<typeof auditedDuring>> = [];
    try {
      events = await auditedDuring(async () => {
        // A page asking for its files again and again.
        const responses = await Promise.all(
          Array.from(
            { length: 5 },
            async () => await routed(fileAt(address, `${name}.js`))
          )
        );
        statuses = responses.map(({ status }) => status);
      });
      warned = warn.mock.calls.map(([fields]: unknown[]) => fields);
    } finally {
      warn.mockRestore();
    }

    expect(statuses).toStrictEqual([403, 403, 403, 403, 403]);
    expect(events).toStrictEqual([]);
    expect(
      warned.filter(
        (fields) =>
          typeof fields === "object" &&
          fields !== null &&
          Reflect.get(fields, "event") === "packages.serve_refused" &&
          Reflect.get(fields, "app") === app &&
          Reflect.get(fields, "reason") === "revoked"
      )
    ).toHaveLength(5);
  });

  it("serves a browser build the lock pins, by either release whose pins it keeps, and nothing it no longer pins", async () => {
    const served = await servedBuild();
    const file = fileAt(served.address, `${served.name}.js`);
    // A resolve that sets other entries for the browser leaves the pin of
    // the entries built as it was.
    await served.builder.api.dependencies.resolve(
      intentFor(
        served.app,
        { [served.name]: "1.0.0" },
        { entries: [served.name, `${served.name}/index.js`] }
      )
    );
    const afterResolve = await statusOf(file);
    const lock = await lockFor(served);
    const pins = Object.values(lock.artifacts ?? {}).flatMap((each) =>
      Object.entries(each)
    );
    // Pinned by another release, running beside this one, and none of
    // this one's.
    await storeLockFor(served, {
      ...lock,
      artifacts: { "release-beside": Object.fromEntries(pins) },
    });
    const otherRelease = await statusOf(file);
    // Dropped, as a pin one too many is.
    await storeLockFor(served, { ...lock, artifacts: {} });
    const dropped = await statusOf(file);

    expect({ afterResolve, otherRelease, dropped }).toStrictEqual({
      afterResolve: 200,
      otherRelease: 200,
      dropped: 404,
    });
  });

  it("keeps serving a build whose address is out while newer graphs take the App's room, and refuses one more graph until it expires", async () => {
    const served = await servedBuild();
    const file = fileAt(served.address, `${served.name}.js`);
    const admin = await personApi("admin");
    await admin.api.dependencies.grantApprover({
      type: "person",
      userId: admin.userId,
    });
    /** Resolves `served`'s App to a graph of its own and approves it. */
    const approveAnother = async (): Promise<void> => {
      const name = named("next");
      await publish({
        name,
        version: "1.0.0",
        manifest: { type: "module", main: "index.js", license: "MIT" },
        files: { "index.js": "export const next = 1;" },
      });
      const { request } = await served.builder.api.dependencies.resolve(
        intentFor(served.app, { [name]: "1.0.0" })
      );
      const { policyGeneration } = await admin.api.dependencies.waiting();
      await admin.api.dependencies.decide(request.id, {
        approved: true,
        reviewed: { graphHash: request.graphHash, policyGeneration },
      });
    };
    // The tests' limit is three locks (vite.config.ts): the served graph,
    // then two more, approved in turn. The fourth takes the room of the
    // oldest approval whose files nobody was handed, never the served one.
    await approveAnother();
    await approveAnother();
    await approveAnother();
    const kept = await statusOf(file);
    // Every lock left is the latest approval, or one whose address is
    // out: none gives up its room, and the next graph is refused.
    const { builder, app } = served;
    const latest = await env.DB.prepare(
      "SELECT graph_hash FROM dependency_locks WHERE subject_type = 'app' AND subject_id = ? AND graph_hash != ? ORDER BY created_at ASC LIMIT 1"
    )
      .bind(app, served.graphHash)
      .first<{ graph_hash: string }>();
    const { policyGeneration } = await builder.api.dependencies.status({
      app,
    });
    await builder.api.dependencies.build({
      app,
      graphHash: latest?.graph_hash ?? "",
      target: "browser",
      policyGeneration,
    });
    const refused = await failure(approveAnother());
    // Once every address handed out has expired, the oldest approval's
    // lock gives up its room again.
    // As the hours since leave them: each lock's time to hold, gone by.
    await env.DB.prepare(
      "UPDATE dependency_locks SET served_until = ? WHERE subject_type = 'app' AND subject_id = ? AND served_until IS NOT NULL"
    )
      .bind(Date.now() - 1, app)
      .run();
    await approveAnother();
    const after = await env.DB.prepare(
      "SELECT 1 FROM dependency_locks WHERE subject_type = 'app' AND subject_id = ? AND graph_hash = ?"
    )
      .bind(app, served.graphHash)
      .first();

    expect({ kept, refused, after }).toStrictEqual({
      kept: 200,
      refused: {
        code: "package.quota",
        details: { quota: "appLocks", limit: 3 },
      },
      after: null,
    });
  });

  it("serves no bytes but the ones built, and the next build makes them again, to the pin", async () => {
    const served = await servedBuild();
    const { built, address, name } = served;
    await env.FILES.put(
      `package-builds/${built.hash}/${name}.js`,
      `fetch("https://attacker.test/swapped");`
    );

    const response = await seen(await routed(fileAt(address, `${name}.js`)));
    const again = await buildOf(served);
    const healed = await seen(await routed(fileAt(address, `${name}.js`)));
    expect({
      status: response.status,
      attacker: response.body.includes("attacker"),
      again: [again.hash, again.stats === null],
      healed: [healed.status, healed.body.includes("attacker")],
    }).toStrictEqual({
      status: 404,
      attacker: false,
      again: [built.hash, false],
      healed: [200, false],
    });
  });

  it("serves nothing of a lock this release can't read, and answers not found", async () => {
    const served = await servedBuild();
    // As an older release wrote it, its pins in another shape.
    const lock = await lockFor(served);
    await env.DB.prepare(
      "UPDATE dependency_locks SET lock = ? WHERE subject_type = 'app' AND subject_id = ? AND graph_hash = ?"
    )
      .bind(
        JSON.stringify({
          ...lock,
          artifacts: { older: { browser: { hash: served.built.hash } } },
        }),
        served.app,
        served.graphHash
      )
      .run();
    const response = await routed(fileAt(served.address, `${served.name}.js`));
    expect(response.status).toBe(404);
  });

  it("builds and serves nothing of a lock resolved against another React, and says to resolve again", async () => {
    const served = await servedBuild();
    // As a release with another React finds a lock, and its approval,
    // from before it.
    const lock = await lockFor(served);
    const older: GraspLock = {
      ...lock,
      platformPeers: { react: "18.3.1", "react-dom": "18.3.1" },
    };
    const olderHash = await dependencyGraphHash(lockGraph(older));
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE dependency_locks SET graph_hash = ?, lock = ? WHERE subject_type = 'app' AND subject_id = ? AND graph_hash = ?"
      ).bind(olderHash, JSON.stringify(older), served.app, served.graphHash),
      env.DB.prepare(
        "UPDATE dependency_requests SET graph_hash = ? WHERE id = ?"
      ).bind(olderHash, served.request.id),
    ]);
    const old = { ...served, graphHash: olderHash };
    const address = await packageArtifactAddress(env, {
      app: served.app,
      graphHash: olderHash,
      hash: served.built.hash,
    });

    let code = "";
    let status = 0;
    let errors: unknown[] = [];
    const warned = await loggedDuring("warn", async () => {
      errors = await loggedDuring("error", async () => {
        ({ code } = await failure(buildOf(old)));
        ({ status } = await routed(fileAt(address, `${served.name}.js`)));
      });
    });

    expect({
      code,
      status,
      warned: eventsNamed(warned, "packages.platform_changed").length > 0,
      errors: eventsNamed(errors, "packages.lock_changed"),
    }).toStrictEqual({
      code: "package.platform_changed",
      status: 404,
      warned: true,
      errors: [],
    });
  });

  it("serves no target but the browser's, even with a token for it: the lock pins only the browser build as the browser's", async () => {
    const name = await hostilePackage();
    const approved = await approvedApp(
      { [name]: "1.0.0" },
      { targets: ["browser", "server"] }
    );
    const browserBuild = await buildOf(approved, "browser");
    const serverBuild = await buildOf(approved, "server");
    // A token core made for the server build, as if it had handed one out.
    const address = await packageArtifactAddress(env, {
      app: approved.app,
      graphHash: approved.graphHash,
      hash: serverBuild.hash,
    });

    const response = await routed(fileAt(address, `${name}.js`));
    // The same App and graph, whose browser build is served.
    const browser = await routed(
      browserBuild.address === null
        ? "/"
        : fileAt(browserBuild.address, `${name}.js`)
    );
    expect({
      address: serverBuild.address,
      status: response.status,
      browser: browser.status,
    }).toStrictEqual({ address: null, status: 404, browser: 200 });
  });

  it("serves no file to the product page's own request for it", async () => {
    const { address, name } = await servedBuild();
    const asked = async (site?: string) => {
      const response = await routed(fileAt(address, `${name}.js`), {
        headers: site === undefined ? {} : { "sec-fetch-site": site },
      });
      return [response.status, response.headers.get("vary")];
    };

    // Only screens' frames load these, from an opaque origin: cross-site
    // to a browser. The product page's own requests are same-origin,
    // whatever token they carry. Each answer varies on the header, so a
    // copy a frame's load left in the browser's cache never answers the
    // page.
    expect({
      frame: await asked("cross-site"),
      productPage: await asked("same-origin"),
      unsaid: await asked(),
    }).toStrictEqual({
      frame: [200, "sec-fetch-site"],
      productPage: [403, "sec-fetch-site"],
      unsaid: [200, "sec-fetch-site"],
    });
  });

  it("is the only way to an artifact's files", async () => {
    const { built, name } = await servedBuild();
    const module = `${name}.js`;
    const code = await keptBytes(built.hash, module);
    const elsewhere = await Promise.all(
      [
        `/package-builds/${built.hash}/${module}`,
        `/package-builds/${built.hash}.json`,
        `/screen-modules/${built.hash}.js`,
        `/api/package-builds/${built.hash}/${module}`,
        `/Package-Artifacts/${built.hash}/${module}`,
      ].map(async (path) => await seen(await routed(path)))
    );
    expect(elsewhere.filter(({ body }) => body.includes(code))).toStrictEqual(
      []
    );
  });
});

// No path core or the router logs holds the token: an address read from
// a log reads nothing.
describe("logging an artifact's request", () => {
  it("carries the token in the query alone, in no path logged, and on each URL of its own a stylesheet fetches", async () => {
    const { address, built, name } = await servedBuild();
    const token = tokenOf(address);
    const stylesheet =
      Object.keys(built.artifact.files).find((path) => path.endsWith(".css")) ??
      "";
    const info = vi.spyOn(console, "info").mockReturnValue();
    let lines: string[] = [];
    let css = "";
    try {
      await routed(fileAt(address, `${name}.js`));
      const served = await routed(fileAt(address, stylesheet));
      css = await served.text();
      lines = info.mock.calls.map((call) => JSON.stringify(call));
    } finally {
      info.mockRestore();
    }
    const logged = lines.filter((line) => line.includes("/package-artifacts"));
    const urls = [...css.matchAll(/url\((?<url>[^)]*)\)/gu)].map(
      ({ groups }) => groups?.url ?? ""
    );
    expect({
      inDirectory: address.directory.includes(token),
      logged: logged.length,
      loggedWithToken: logged.filter((line) => line.includes(token)),
      urls: urls.length > 0,
      urlsWithoutToken: urls.filter((url) => !url.includes(address.query)),
    }).toStrictEqual({
      inDirectory: false,
      logged: 2,
      loggedWithToken: [],
      urls: true,
      urlsWithoutToken: [],
    });
  });
});
