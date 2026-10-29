/**
 * scripts/store-secrets.ts run as Deploy platform runs it, against a
 * stand-in for Cloudflare's Secrets Store API (the outside system) that
 * keeps the store's secrets in memory: each stage's runtime secrets copied
 * from the env, which holds them by their plain names as 1Password does,
 * into the store under the stage's names.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { optionalSecrets } from "./optional-secrets.ts";

/** What the stand-in takes: a create's secrets, and an update's value. */
const createdSchema = z.array(
  z.object({ name: z.string(), value: z.string() })
);
const updatedSchema = z.object({ value: z.string() });

const script = path.join(import.meta.dirname, "store-secrets.ts");

/** Runs the script, resolving with its stdout; failing with its stderr. */
const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<string> => {
  const child = spawn("node", [script, ...args], { env });
  const closed = once(child, "close");
  const [stdout, stderr] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
  ]);
  await closed;
  if (child.exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout;
};

/** How a run ended: "ok", or what it said on its way out. */
const outcomeOf = async (running: Promise<unknown>): Promise<string> => {
  try {
    await running;
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** A secret in the stand-in store. */
interface Stored {
  id: string;
  value: string;
}

/** Every secret the admin and router bind, by binding name. */
const required = [
  "DEPLOYER_API_TOKEN",
  "ROUTER_KEY",
  "CLIENT_KEY",
  "ENTRA_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "COMPOSIO_API_KEY",
];
const optional = [...optionalSecrets];

/** An env with every secret set to `value-<NAME>`, as 1Password names them. */
const everySecret = (): Record<string, string> =>
  Object.fromEntries(
    [...required, ...optional].map((name) => [name, `value-${name}`])
  );

describe("copying the runtime secrets into the Secrets Store", () => {
  let server: Server | undefined;
  let store = new Map<string, Stored>();
  let writes: string[] = [];
  let api = "";

  beforeEach(async () => {
    store = new Map();
    writes = [];
    const current = store;
    const written = writes;
    server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "", "http://stand-in");
        const parts = url.pathname.split("/").filter(Boolean);
        const id = parts.at(-1) === "secrets" ? undefined : parts.at(-1);
        const body = await text(request);
        if (request.method === "GET") {
          response.end(
            JSON.stringify({
              result: [...current].map(([name, { id: secretId }]) => ({
                name,
                id: secretId,
              })),
              result_info: { total_pages: 1 },
            })
          );
          return;
        }
        if (request.method === "POST") {
          for (const { name, value } of createdSchema.parse(JSON.parse(body))) {
            current.set(name, { id: `id-${name}`, value });
            written.push(`create ${name}`);
          }
          response.end(JSON.stringify({ result: [] }));
          return;
        }
        const entry = [...current].find(
          ([, { id: secretId }]) => secretId === id
        );
        if (request.method === "PATCH" && entry !== undefined) {
          const { value } = updatedSchema.parse(JSON.parse(body));
          current.set(entry[0], { ...entry[1], value });
          written.push(`update ${entry[0]}`);
          response.end(JSON.stringify({ result: {} }));
          return;
        }
        response.writeHead(404).end();
      })();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port for the stand-in");
    }
    api = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server?.close();
    if (server) {
      await once(server, "close");
    }
  });

  const copy = async (
    stage: string,
    secrets: Record<string, string>
  ): Promise<string> =>
    await run(["copy", stage], {
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_API_URL: api,
      ...secrets,
    });

  it("names every secret the admin and router bind, by the name 1Password keeps", async () => {
    const printed = await run(["names", "staging"], { PATH: process.env.PATH });
    const names = printed.trim().split(" ");
    expect(names.toSorted()).toStrictEqual(
      [...required, ...optional].toSorted()
    );
  });

  it("writes a staging run's secrets only under _STAGING names, and production's under their own", async () => {
    await copy("staging", everySecret());
    const staging = [...store.keys()];
    store.clear();
    await copy("production", everySecret());

    expect({
      staging: staging.toSorted(),
      production: [...store.keys()].toSorted(),
      value: store.get("ROUTER_KEY")?.value,
    }).toStrictEqual({
      staging: [...required, ...optional]
        .map((name) => `${name}_STAGING`)
        .toSorted(),
      production: [...required, ...optional].toSorted(),
      value: "value-ROUTER_KEY",
    });
  });

  it("writes nothing when a required secret is missing, naming every one", async () => {
    const secrets = everySecret();
    delete secrets.ROUTER_KEY;
    secrets.COMPOSIO_API_KEY = "";

    const outcome = await outcomeOf(copy("staging", secrets));
    expect({
      outcome: outcome.includes(
        "Empty in the staging 1Password Environment, nothing written: ROUTER_KEY, COMPOSIO_API_KEY"
      ),
      writes,
    }).toStrictEqual({ outcome: true, writes: [] });
  });

  it("updates what the store has, and leaves an optional secret 1Password lacks as the store has it", async () => {
    store.set("ROUTER_KEY_STAGING", { id: "id-old-router", value: "old" });
    store.set("STRIPE_RESTRICTED_KEY_STAGING", {
      id: "id-old-stripe",
      value: "kept",
    });
    const secrets = everySecret();
    delete secrets.STRIPE_RESTRICTED_KEY;

    const stdout = await copy("staging", secrets);

    expect({
      router: store.get("ROUTER_KEY_STAGING"),
      stripe: store.get("STRIPE_RESTRICTED_KEY_STAGING"),
      stripeWritten: writes.some((write) => write.includes("STRIPE")),
      reported: stdout.includes("left as they are: STRIPE_RESTRICTED_KEY"),
    }).toStrictEqual({
      router: { id: "id-old-router", value: "value-ROUTER_KEY" },
      stripe: { id: "id-old-stripe", value: "kept" },
      stripeWritten: false,
      reported: true,
    });
  });
});
