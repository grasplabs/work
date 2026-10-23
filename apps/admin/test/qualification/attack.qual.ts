/* oxlint-disable eslint/no-await-in-loop, eslint/no-nested-ternary, unicorn/no-await-expression-member, typescript/no-base-to-string, typescript/strict-boolean-expressions -- a hand-run qualification harness (GRA-430), never in CI or production: kept as it ran, for the record. */
/**
 * Real-account qualification (GRA-430), part 3, the attacks: client A, with
 * everything A holds (its router secret and core auth secret, derived as
 * the console derives them, and its place on the account), tries to reach
 * client B's core, connect, databases, buckets, Durable Objects and
 * secrets. Runs against what provision.qual.ts left, read back from the
 * account; prints every observation (relay log). QUAL_ATTACK=1 to run.
 */
import {
  deriveRouterSecret,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { it } from "vite-plus/test";
import { z } from "zod";

import { cloudflareApi } from "../../src/cloudflare/api.ts";
import { clientAuthSecret } from "../../src/deploy/secrets.ts";
import { probeCore } from "../../src/hosting/probe.ts";

const qual = z
  .object({ QUAL_ACCOUNT_ID: z.string(), QUAL_PREFIX: z.string() })
  .parse(env);
const accountPath = `/accounts/${qual.QUAL_ACCOUNT_ID}`;
const api = cloudflareApi({ token: "placeholder", retryDelayMs: 1000 });
// As the harness gave them to the console (test/secrets-store-admin.ts).
const keys = { routerKey: "test-router-key", clientKey: "test-client-key" };
const generation = 1;

const report = async (label: string, value: unknown): Promise<void> => {
  await fetch("https://qual-release.invalid/__report", {
    method: "POST",
    body: JSON.stringify({ label, value }),
  });
};

const clientIds = { a: `${qual.QUAL_PREFIX}-a`, b: `${qual.QUAL_PREFIX}-b` };
const script = (letter: "a" | "b", app: "core" | "connect"): string =>
  `g${qual.QUAL_PREFIX}-${letter}-grasp-os-${app}`;

const sha = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** One request, as the attacker sends it, and what came back. */
const attempt = async (url: string, init: RequestInit = {}) => {
  try {
    const response = await fetch(url, { redirect: "manual", ...init });
    const body = (await response.text()).slice(0, 300);
    return { status: response.status, body };
  } catch (error) {
    return { error: String(error) };
  }
};

const anyObject = z.record(z.string(), z.unknown());

it.runIf(Reflect.get(env, "QUAL_ATTACK") === "1")(
  "client A attacks client B",
  async () => {
    const { subdomain } = await api.call(
      { method: "GET", path: `${accountPath}/workers/subdomain` },
      z.object({ subdomain: z.string() })
    );
    const origin = (letter: "a" | "b", app: "core" | "connect") =>
      `https://${script(letter, app)}.${subdomain}.workers.dev`;
    const router = {
      a: await deriveRouterSecret(keys.routerKey, clientIds.a, generation),
      b: await deriveRouterSecret(keys.routerKey, clientIds.b, generation),
    };
    const auth = {
      a: await clientAuthSecret(keys, clientIds.a, generation),
      b: await clientAuthSecret(keys, clientIds.b, generation),
    };
    await report("secrets differ", {
      router: { a: await sha(router.a), b: await sha(router.b) },
      auth: { a: await sha(auth.a), b: await sha(auth.b) },
    });

    // Routes: B's core at its workers.dev origin, which only the router's
    // per-client secret opens.
    const health = async (letter: "a" | "b", secret?: string) =>
      await attempt(`${origin(letter, "core")}/health`, {
        headers: secret === undefined ? {} : { [routerSecretHeader]: secret },
      });
    await report("routes", {
      "B core /health, no secret": await health("b"),
      "B core /health, A's router secret": await health("b", router.a),
      "B core /, A's router secret": await attempt(`${origin("b", "core")}/`, {
        headers: { [routerSecretHeader]: router.a },
      }),
      "control: B core /health, B's router secret": await health("b", router.b),
      "control: A core /health, A's router secret": await health("a", router.a),
      "B connect (workers.dev), no secret": await attempt(
        `${origin("b", "connect")}/`
      ),
      "B connect (workers.dev), A's router secret": await attempt(
        `${origin("b", "connect")}/`,
        {
          headers: { [routerSecretHeader]: router.a },
        }
      ),
    });

    // The console's signed probe, which answers with the client's identity
    // and bindings: signed with A's auth secret, sent to B.
    const probe = async (
      letter: "a" | "b",
      routerSecret: string,
      authSecret: string
    ) =>
      await probeCore({
        origin: origin(letter, "core"),
        routerSecret,
        authSecret,
        fetch,
        timeoutMs: 15_000,
      });
    await report("probe", {
      "B core, A's router secret, A's auth secret":
        (await probe("b", router.a, auth.a)) ?? "refused",
      "B core, B's router secret, A's auth secret":
        (await probe("b", router.b, auth.a)) ?? "refused",
      "control: B core, B's secrets":
        (await probe("b", router.b, auth.b)) ?? "refused",
      "control: A core, A's secrets":
        (await probe("a", router.a, auth.a)) ?? "refused",
    });

    // What each client's Workers are bound to, as the account has it: every
    // database, bucket, namespace and service must be the client's own.
    const d1 = await api.call(
      {
        method: "GET",
        path: `${accountPath}/d1/database`,
        query: { per_page: "100" },
      },
      z.array(z.object({ uuid: z.string(), name: z.string() }))
    );
    const namespaces = await api.call(
      {
        method: "GET",
        path: `${accountPath}/workers/durable_objects/namespaces`,
        query: { per_page: "100" },
      },
      z.array(
        z.object({
          id: z.string(),
          name: z.string().nullish(),
          script: z.string().nullish(),
          class: z.string().nullish(),
        })
      )
    );
    const d1Name = new Map(d1.map(({ uuid, name }) => [uuid, name]));
    const namespaceOf = new Map(
      namespaces.map((namespace) => [namespace.id, namespace])
    );
    const audit: Record<string, unknown> = {};
    for (const letter of ["a", "b"] as const) {
      for (const app of ["core", "connect"] as const) {
        const name = script(letter, app);
        const live = await fetch(
          `https://api.cloudflare.com/client/v4${accountPath}/workers/scripts/${name}/settings`,
          { headers: { authorization: "Bearer placeholder" } }
        );
        await live.body?.cancel();
        if (!live.ok) {
          audit[name] = { missing: live.status };
          continue;
        }
        const settings = await api.call(
          {
            method: "GET",
            path: `${accountPath}/workers/scripts/${name}/settings`,
          },
          z.object({ bindings: z.array(anyObject) })
        );
        const secrets = await api.call(
          {
            method: "GET",
            path: `${accountPath}/workers/scripts/${name}/secrets`,
          },
          z.array(z.object({ name: z.string() }))
        );
        const exposure = await api.call(
          {
            method: "GET",
            path: `${accountPath}/workers/scripts/${name}/subdomain`,
          },
          anyObject
        );
        const bindings = settings.bindings.map((binding) => {
          const target =
            binding.type === "d1"
              ? d1Name.get(String(binding.id ?? binding.database_id))
              : binding.type === "r2_bucket"
                ? String(binding.bucket_name)
                : binding.type === "durable_object_namespace"
                  ? `${String(binding.script_name ?? namespaceOf.get(String(binding.namespace_id))?.script ?? name)}:${String(binding.class_name)}`
                  : binding.type === "service"
                    ? String(binding.service)
                    : undefined;
          const other = letter === "a" ? "b" : "a";
          return {
            name: binding.name,
            type: binding.type,
            target,
            ownClient:
              target === undefined
                ? null
                : target.startsWith(`g${qual.QUAL_PREFIX}-${letter}-`),
            otherClient:
              target === undefined
                ? null
                : target.includes(`g${qual.QUAL_PREFIX}-${other}-`),
          };
        });
        audit[name] = {
          bindings,
          secretNames: secrets.map((secret) => secret.name),
          workersDev: exposure,
        };
      }
    }
    await report("binding audit", audit);
    await report(
      "durable object namespaces",
      namespaces.filter((namespace) =>
        namespace.script?.includes(qual.QUAL_PREFIX)
      )
    );
  }
);
