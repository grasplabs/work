import { toHex } from "@grasp-os/shared/encoding";
import type { DependencyIntent, PackageBuild } from "@grasp-os/shared/packages";
import type { Role } from "@grasp-os/shared/roles";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { packageArtifactAddress } from "../src/packages/address.ts";
import { mockIdp } from "./idp.ts";
import { intentFor, named, publish } from "./npm.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { auditedDuring, coreOrigin, routed, signedInApi } from "./sign-in.ts";

// Serving an App's built packages (src/packages/serve.ts), from its threat
// model: a file served without the policy the build relies on, or as
// another type; a file of a graph no longer approved, of an artifact the
// lock no longer pins, or bytes other than the ones built; an artifact
// read by its hashes alone; code for Workers sent to a browser; and the
// files reached by any other path. The packages are real builds, from
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
  return { builder, app, graphHash: request.graphHash, request };
};

type Approved = Awaited<ReturnType<typeof approvedApp>>;

const buildOf = async (
  { builder, app, graphHash }: Approved,
  target: PackageBuild["artifact"]["target"] = "browser"
): Promise<PackageBuild> => {
  const { policyGeneration } = await builder.api.dependencies.status(app);
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

const sha256 = async (bytes: ArrayBuffer): Promise<string> =>
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
        const response = await routed(`${address}${path}`);
        return {
          path,
          status: response.status,
          type: response.headers.get("content-type"),
          policy: response.headers.get("content-security-policy"),
          sniffing: response.headers.get("x-content-type-options"),
          referrer: response.headers.get("referrer-policy"),
          cache: response.headers.get("cache-control"),
          matches: (await sha256(await response.arrayBuffer())) === file.sha256,
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
        // Its address carries a token: never sent on as a Referer.
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
    const [base, token] = [
      address.slice(0, address.lastIndexOf("/", address.length - 2) + 1),
      address.split("/").at(-2) ?? "",
    ];
    const otherToken = `${Date.now() + 60_000}.${"A".repeat(43)}`;
    const answers = await Promise.all([
      routed(`${address}${module}`),
      routed(`${base}${otherToken}/${module}`),
      routed(
        `${base}${String(Date.now() - 1)}.${token.split(".")[1]}/${module}`
      ),
      routed(`${base}${module}`),
      routed(`${address}missing.js`),
      routed(`${address}..%2F..%2F${module}`),
      routed(`${address}%E0%A4%A`),
      routed("/package-artifacts"),
      routed("/package-artifacts/"),
      routed(`${address}${module}`, { method: "POST", body: "x" }),
      // Without the router's secret: refused before any route.
      worker.fetch(
        new Request(`${coreOrigin}${address}${module}`),
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
    const twoToken = two.address.split("/").at(-2) ?? "";
    const oneBase = one.address.slice(
      0,
      one.address.lastIndexOf("/", one.address.length - 2) + 1
    );
    const twoBase = two.address.slice(
      0,
      two.address.lastIndexOf("/", two.address.length - 2) + 1
    );
    // Two's token on one's artifact, and two's artifact under one's App.
    const borrowed = await routed(`${oneBase}${twoToken}/${one.name}.js`);
    const moved = await routed(
      `${twoBase.replace(two.app, one.app)}${twoToken}/${module}`
    );
    expect([borrowed.status, moved.status]).toStrictEqual([403, 403]);
  });

  it("serves nothing once the graph is no longer approved, and logs each refusal without filling the audit trail", async () => {
    const { app, request, address, name } = await servedBuild();
    // An approval taken back: nothing in the product does it yet, so the
    // test does what such a decision would leave behind.
    await env.DB.prepare(
      "UPDATE dependency_requests SET status = 'denied' WHERE id = ?"
    )
      .bind(request.id)
      .run();

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
            async () => await routed(`${address}${name}.js`)
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
          Reflect.get(fields, "reason") === "not_approved"
      )
    ).toHaveLength(5);
  });

  it("serves nothing the lock no longer pins", async () => {
    const served = await servedBuild();
    // A resolve that changes the browser target's entries unpins its build.
    await served.builder.api.dependencies.resolve(
      intentFor(
        served.app,
        { [served.name]: "1.0.0" },
        { entries: [served.name, `${served.name}/index.js`] }
      )
    );

    const response = await routed(`${served.address}${served.name}.js`);
    expect(response.status).toBe(404);
  });

  it("serves no bytes but the ones built", async () => {
    const { built, address, name } = await servedBuild();
    await env.FILES.put(
      `package-builds/${built.hash}/${name}.js`,
      `fetch("https://attacker.test/swapped");`
    );

    const response = await seen(await routed(`${address}${name}.js`));
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("attacker");
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

    const response = await routed(`${address}${name}.js`);
    // The same App and graph, whose browser build is served.
    const browser = await routed(`${browserBuild.address ?? ""}${name}.js`);
    expect({
      address: serverBuild.address,
      status: response.status,
      browser: browser.status,
    }).toStrictEqual({ address: null, status: 404, browser: 200 });
  });

  it("serves no file to the product page's own request for it", async () => {
    const { address, name } = await servedBuild();
    const asked = async (site?: string): Promise<number> => {
      const response = await routed(`${address}${name}.js`, {
        headers: site === undefined ? {} : { "sec-fetch-site": site },
      });
      return response.status;
    };

    // Only screens' frames load these, from an opaque origin: cross-site
    // to a browser. The product page's own requests are same-origin,
    // whatever token they carry.
    expect({
      frame: await asked("cross-site"),
      productPage: await asked("same-origin"),
      unsaid: await asked(),
    }).toStrictEqual({ frame: 200, productPage: 403, unsaid: 200 });
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

// The request log keeps no token: an address read from it reads nothing.
describe("logging an artifact's request", () => {
  it("leaves the token out of the path it logs", async () => {
    const { address, name } = await servedBuild();
    const token = address.split("/").at(-2) ?? "";
    const info = vi.spyOn(console, "info").mockReturnValue();
    let lines: string[] = [];
    try {
      await routed(`${address}${name}.js`);
      lines = info.mock.calls.map((call) => JSON.stringify(call));
    } finally {
      info.mockRestore();
    }
    const logged = lines.filter((line) => line.includes("/package-artifacts/"));
    expect(logged).toHaveLength(1);
    expect(logged.filter((line) => line.includes(token))).toStrictEqual([]);
  });
});
