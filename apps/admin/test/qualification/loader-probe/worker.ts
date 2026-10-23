import { platformLimits } from "@grasp-os/shared/platform-limits";
import { isolateBase } from "@grasp-os/shared/runtime";
/* oxlint-disable typescript/no-unsafe-type-assertion, typescript/method-signature-style, typescript/strict-boolean-expressions, typescript/prefer-nullish-coalescing, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, unicorn/no-await-expression-member, unicorn/consistent-function-scoping, eslint/no-plusplus, eslint/no-await-in-loop, eslint/class-methods-use-this -- a hand-run qualification harness (GRA-430), never in CI or production: kept as it ran, for the record. */
/**
 * Qualification probe (GRA-430): what a dynamic Loader isolate, loaded with
 * core's sandbox options, can do with the Cache API, and how the Loader's
 * `limits.cpuMs` ends a busy loop. Every request needs the QUAL_KEY secret.
 */
import { RpcTarget } from "cloudflare:workers";

interface Env {
  LOADER: WorkerLoader;
  QUAL_KEY: string;
}

// Core's `sandbox` (apps/core/src/sandbox.ts), restated so the probe needs
// none of core's modules.
// Workers' CacheStorage, which the console's DOM lib types without `default`.
const workerCaches = caches as unknown as {
  default: Cache;
  open: (name: string) => Promise<Cache>;
};

const sandbox = {
  ...isolateBase,
  globalOutbound: null,
  limits: { cpuMs: platformLimits.serverInvocationCpuMs },
};

const cacheApp = `
import { WorkerEntrypoint } from "cloudflare:workers";
const attempt = async (what, fn) => {
  try { return { what, ok: true, value: await fn() }; }
  catch (error) { return { what, ok: false, error: String(error) }; }
};
export class App extends WorkerEntrypoint {
  async write(key, value) {
    const url = "https://qual.invalid/" + key;
    const body = () => new Response(value, { headers: { "cache-control": "max-age=600" } });
    return [
      await attempt("caches.default.put", () => caches.default.put(url, body()).then(() => "put")),
      await attempt("caches.open(shared).put", async () => (await caches.open("shared")).put(url, body()).then(() => "put")),
      await attempt("caches.open(core).put", async () => (await caches.open("core")).put(url, body()).then(() => "put")),
    ];
  }
  async read(key) {
    const url = "https://qual.invalid/" + key;
    const text = async (r) => (r === undefined ? null : await r.text());
    return [
      await attempt("caches.default.match", async () => text(await caches.default.match(url))),
      await attempt("caches.open(shared).match", async () => text(await (await caches.open("shared")).match(url))),
      await attempt("caches.open(core).match", async () => text(await (await caches.open("core")).match(url))),
    ];
  }
}
export default { async fetch() { return new Response("app"); } };
`;

// Busy loops of a given number of iterations; time doesn't move inside an
// isolate without I/O, so the host times them.
const cpuApp = `
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
const spin = (n) => { let x = 0; for (let i = 0; i < n; i++) { x = (x + i * 7) % 1000003; } return x; };
class Step extends RpcTarget {
  constructor(n) { super(); this.n = n; }
  run() { return spin(this.n); }
}
export class Busy extends WorkerEntrypoint {
  spin(n) { return spin(n); }
  // A run activation as core's: the isolate calls the host, which calls
  // each step's function back over RPC.
  async activation(host, n, steps) {
    const out = [];
    for (let i = 0; i < steps; i++) { out.push(await host.step(new Step(n))); }
    return out;
  }
  // The same, with the busy loops in the isolate's own call.
  async inline(host, n, steps) {
    const out = [];
    for (let i = 0; i < steps; i++) { await host.tick(); out.push(spin(n)); }
    return out;
  }
}
export default {
  async fetch(request) {
    const n = Number(new URL(request.url).searchParams.get("n"));
    return new Response(String(spin(n)));
  },
};
`;

// App code that tries to reach a URL by every way out an isolate has.
const netApp = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class App extends WorkerEntrypoint {
  async reach(url) {
    const out = {};
    try { const r = await fetch(url); out.fetch = { status: r.status }; } catch (e) { out.fetch = String(e); }
    try { const { connect } = await import("cloudflare:sockets"); const s = connect({ hostname: new URL(url).hostname, port: 443 }); await s.opened; out.socket = "opened"; } catch (e) { out.socket = String(e); }
    out.env = Object.keys(this.env ?? {});
    return out;
  }
}
export default { async fetch() { return new Response("app"); } };
`;

class Host extends RpcTarget {
  readonly log: { step: number; ms: number; ok: boolean; error?: string }[] =
    [];
  async step(fn: { run(): Promise<number> }): Promise<unknown> {
    const started = Date.now();
    try {
      const value = await fn.run();
      this.log.push({
        step: this.log.length,
        ms: Date.now() - started,
        ok: true,
      });
      return value;
    } catch (error) {
      this.log.push({
        step: this.log.length,
        ms: Date.now() - started,
        ok: false,
        error: String(error),
      });
      throw error;
    }
  }
  async tick(): Promise<void> {
    await Promise.resolve();
  }
}

const timed = async (fn: () => Promise<unknown>) => {
  const started = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - started, value };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error) };
  }
};

const cacheIsolate = (env: Env, id: string | null) =>
  env.LOADER.get(id, () => ({
    ...sandbox,
    mainModule: "app.js",
    modules: { "app.js": cacheApp },
    env: {},
  })).getEntrypoint("App") as unknown as {
    write(key: string, value: string): Promise<unknown>;
    read(key: string): Promise<unknown>;
  };

const cpuIsolate = (env: Env, id: string | null, cpuMs: number) =>
  env.LOADER.get(id, () => ({
    ...sandbox,
    limits: { cpuMs },
    mainModule: "busy.js",
    modules: { "busy.js": cpuApp },
    env: {},
  }));

const netRoute = async (env: Env, url: URL): Promise<unknown> => {
  const target = url.searchParams.get("url") ?? "";
  const app = env.LOADER.get(null, () => ({
    ...sandbox,
    mainModule: "net.js",
    modules: { "net.js": netApp },
    env: {},
  })).getEntrypoint("App") as unknown as {
    reach: (target: string) => Promise<unknown>;
  };
  return await app.reach(target);
};

const cacheRoutes = async (env: Env, url: URL): Promise<unknown> => {
  const key = url.searchParams.get("key") ?? "none";
  const app = url.searchParams.get("app");
  const id = app === "anon" ? null : `qual-app-${app}`;
  switch (url.pathname) {
    case "/cache/write": {
      return await cacheIsolate(env, id).write(key, `written by ${app}`);
    }
    case "/cache/read": {
      return await cacheIsolate(env, id).read(key);
    }
    // The host Worker's own cache, as core's would be.
    case "/cache/host-write": {
      const target = `https://qual.invalid/${key}`;
      const body = () =>
        new Response("written by host", {
          headers: { "cache-control": "max-age=600" },
        });
      await workerCaches.default.put(target, body());
      await (await workerCaches.open("shared")).put(target, body());
      return "host put";
    }
    case "/cache/host-read": {
      const target = `https://qual.invalid/${key}`;
      const a = await workerCaches.default.match(target);
      const b = await (await workerCaches.open("shared")).match(target);
      const c = await (await workerCaches.open("core")).match(target);
      return {
        default: a === undefined ? null : await a.text(),
        shared: b === undefined ? null : await b.text(),
        core: c === undefined ? null : await c.text(),
      };
    }
    default: {
      return null;
    }
  }
};

const cpuRoutes = async (env: Env, url: URL): Promise<unknown> => {
  const n = Number(url.searchParams.get("n"));
  const steps = Number(url.searchParams.get("steps") ?? "1");
  const cpuMs = Number(url.searchParams.get("cpuMs") ?? sandbox.limits.cpuMs);
  const id = url.searchParams.get("id") || null;
  const worker = cpuIsolate(env, id, cpuMs);
  const busy = worker.getEntrypoint("Busy") as unknown as {
    spin(n: number): Promise<number>;
    activation(host: Host, n: number, steps: number): Promise<number[]>;
    inline(host: Host, n: number, steps: number): Promise<number[]>;
  };
  switch (url.pathname) {
    case "/cpu/fetch": {
      return await timed(async () => {
        const response = await worker
          .getEntrypoint()
          .fetch(`https://busy.invalid/?n=${n}`);
        return { status: response.status, body: await response.text() };
      });
    }
    case "/cpu/rpc": {
      return await timed(async () => await busy.spin(n));
    }
    case "/cpu/rpc-sequence": {
      const calls = [];
      for (let i = 0; i < steps; i++) {
        calls.push(await timed(async () => await busy.spin(n)));
      }
      return calls;
    }
    // Each call in a fresh isolate of its own, as different Apps' would be.
    case "/cpu/rpc-fresh": {
      const calls = [];
      for (let i = 0; i < steps; i++) {
        const fresh = cpuIsolate(
          env,
          id === null ? null : `${id}-${i}`,
          cpuMs
        ).getEntrypoint("Busy") as unknown as {
          spin(n: number): Promise<number>;
        };
        calls.push(await timed(async () => await fresh.spin(n)));
      }
      return calls;
    }
    case "/cpu/activation": {
      const host = new Host();
      const result = await timed(
        async () => await busy.activation(host, n, steps)
      );
      return { result, steps: host.log };
    }
    case "/cpu/inline": {
      const host = new Host();
      return await timed(async () => await busy.inline(host, n, steps));
    }
    default: {
      return null;
    }
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("x-qual-key") !== env.QUAL_KEY) {
      return new Response("no", { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/net") {
      return Response.json({
        path: url.pathname,
        query: url.search,
        body: await netRoute(env, url),
      });
    }
    const body = url.pathname.startsWith("/cache/")
      ? await cacheRoutes(env, url)
      : await cpuRoutes(env, url);
    return Response.json({ path: url.pathname, query: url.search, body });
  },
};
