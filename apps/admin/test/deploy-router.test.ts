import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { coreAddressOf } from "../src/clients/core-address.ts";
import type { CoreAddress } from "../src/clients/core-address.ts";
import { registerHostname, smokeAnswering } from "../src/deploy/router.ts";
import type { RouterHosts } from "../src/deploy/router.ts";

/** Acme's core in the clients' namespace, its script answering as `answer` does. */
const acmeCore = (answer: typeof fetch): CoreAddress => {
  const core = coreAddressOf(
    { kind: "dispatch", script: "acme-core" },
    "acme.grasp.test",
    { get: () => ({ fetch: answer }) }
  );
  if (core === undefined) {
    throw new Error("Acme's core should be reachable through the namespace");
  }
  return core;
};

/** A `fetch` to core that never answers until its signal aborts. */
const hanging = async (
  _: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  const stalled = Promise.withResolvers<Response>();
  init?.signal?.addEventListener("abort", () => {
    stalled.reject(new Error("aborted"));
  });
  return await stalled.promise;
};

describe("the smoke check", () => {
  it("gives each try its own deadline, so a stalled one moves on to the next", async () => {
    let tries = 0;
    const core = acmeCore(async (input, init) => {
      tries += 1;
      return tries === 1
        ? await hanging(input, init)
        : Response.json({ ok: true, version: "version-2" });
    });
    const { attempts } = await smokeAnswering(core, "secret", {
      retryDelayMs: 0,
      attemptTimeoutMs: 5,
    });

    expect(attempts).toBe(2);
  });

  it("fails as smoke_check_failed when every try stalls", async () => {
    await expect(
      smokeAnswering(acmeCore(hanging), "secret", {
        retryDelayMs: 0,
        attemptTimeoutMs: 5,
      })
    ).rejects.toMatchObject({ code: "smoke_check_failed" });
  });
});

/** The router's map, as the admin binds it (wrangler.jsonc). */
const kv = env.ROUTER_HOSTS;

/**
 * The hostname map in the test pool's KV, whose reads after a write can be
 * made to answer `readBack` instead, as another writer's entry landing
 * after this one would.
 */
const hostsWith = (readBack?: string): RouterHosts & { writes: number } => {
  const hosts = {
    writes: 0,
    get: async (key: string): Promise<unknown> => {
      const stored: unknown = await kv.get(key, "json");
      const lagging: unknown =
        readBack === undefined ? undefined : JSON.parse(readBack);
      return hosts.writes > 0 && lagging !== undefined ? lagging : stored;
    },
    put: async (key: string, value: string) => {
      hosts.writes += 1;
      await kv.put(key, value);
    },
    delete: async (key: string) => {
      await kv.delete(key);
    },
  };
  return hosts;
};

const entry = {
  clientId: "acme",
  script: "acme-core",
  generation: 2,
};

describe("registering a hostname", () => {
  it("checks the deploy is still the latest as the last thing before it writes", async () => {
    const hostname = `${crypto.randomUUID().slice(0, 8)}.grasp.test`;
    const hosts = hostsWith();
    const seen: unknown[] = [];

    await registerHostname(hosts, hostname, entry, async () => {
      seen.push(await kv.get(hostname));
    });

    expect({ seen, writes: hosts.writes }).toStrictEqual({
      seen: [null],
      writes: 1,
    });
  });

  it("fails loudly when the entry reads back at a lower generation than it wrote", async () => {
    const hostname = `${crypto.randomUUID().slice(0, 8)}.grasp.test`;
    const hosts = hostsWith(JSON.stringify({ ...entry, generation: 1 }));

    await expect(
      registerHostname(hosts, hostname, entry, async () => {
        await kv.get(hostname);
      })
    ).rejects.toMatchObject({ code: "generation_behind" });
  });
});
