import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { requestIdHeader } from "@grasp-os/shared/http";
import { onboardingSummaryPurpose } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import {
  connectVersionPath,
  connectVersionPurpose,
  provisionProbePath,
  provisionProbePurpose,
  provisionProbeSchema,
} from "@grasp-os/shared/provision-probe";
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { clock, clockTasks } from "../src/clock.ts";
import worker from "../src/index.ts";
import { connectVersionMetadata } from "./connect-providers.ts";
import { coreOrigin } from "./sign-in.ts";

// The admin's provisioning probe (src/provision-probe.ts). The ways it
// can fail, tried here:
//
// - Anyone but the admin asking: through the router (its secret, and no
//   signature or a wrong one), with another client's key, with a key for
//   another purpose, with a request signed long ago, without the router
//   secret, or with another client's.
// - The endpoint telling it exists: a refused request answered otherwise
//   than one to a path core has no route for.
// - A refused request making core do anything: its clock armed.
// - The answer leaking a secret, a resource's id or an error's words.
// - A binding or clock that doesn't answer passing as one that does.

/** The client the admin deployed this core as. */
const clientId = "acme";

/** Core's env as the admin deploys it. */
const deployed: Env = { ...env, CLIENT_ID: clientId };

/** `body`'s signature as the admin makes it, with the key `secret` gives for `purpose`. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = provisionProbePurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

interface Sent {
  path?: string;
  body?: string;
  signature?: string;
  method?: string;
  routerSecret?: string | null;
  coreEnv?: Env;
}

/**
 * Sends a request to core as the router would, by default the admin's
 * probe, and waits for everything it left running.
 */
const send = async ({
  path = provisionProbePath,
  body = bodyAt(),
  signature,
  method = "POST",
  routerSecret = env.ROUTER_SECRET,
  coreEnv = deployed,
}: Sent = {}): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (routerSecret !== null) {
    headers.set(routerSecretHeader, routerSecret);
  }
  if (signature !== undefined) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${coreOrigin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
    }),
    coreEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
};

/** The admin's probe, signed. */
const probe = async (coreEnv = deployed): Promise<Response> => {
  const body = bodyAt();
  return await send({ body, signature: await signatureOf(body), coreEnv });
};

/** A response as a caller can tell it apart: everything but its request id, wherever it is. */
const seen = async (response: Response) => {
  const requestId = response.headers.get(requestIdHeader) ?? "";
  const headers = new Headers(response.headers);
  headers.delete(requestIdHeader);
  const body = await response.text();
  return {
    status: response.status,
    headers: [...headers],
    body: body.replaceAll(requestId, "<request>"),
  };
};

/** `binding` gone: whatever is asked of it fails with `reason`. */
const down = <T extends object>(binding: T, reason: string): T =>
  new Proxy(binding, {
    get: () => {
      throw new Error(reason);
    },
  });

/** Clears core's clock's alarm, as anything that lost it would. */
const disarm = async (): Promise<void> => {
  await runInDurableObject(clock(env), async (_, state) => {
    await state.storage.deleteAlarm();
  });
};

const alarmOf = async (): Promise<number | null> =>
  await runInDurableObject(
    clock(env),
    async (_, state) => await state.storage.getAlarm()
  );

describe("the console's provisioning probe", () => {
  it("answers the console with core's identity, its bindings and its clocks, armed", async () => {
    // The isolate's own clock starter runs on its first request; then the
    // alarm is lost.
    await send({ path: "/health", method: "GET" });
    await disarm();

    const response = await probe();
    const text = await response.text();
    const { clocks, ...answer } = provisionProbeSchema.parse(JSON.parse(text));

    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      answer,
      core: clocks.core,
      connect: clocks.connect?.armed,
      alarmArmed: (await alarmOf()) !== null,
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      answer: {
        version: env.CF_VERSION_METADATA.id,
        // Connect's, as connect named it over its binding.
        connectVersion: connectVersionMetadata.id,
        clientId,
        bindings: {
          DB: true,
          KNOWLEDGE: true,
          FILES: true,
          AUDIT_ARCHIVE: true,
          BRAIN_OBJECTS: true,
          // The sandbox App code runs in, with a fresh isolate's answer.
          LOADER: true,
          CONNECT: true,
          // Every Durable Object namespace, in core's jurisdiction.
          WORKSPACES: true,
          APPS: true,
          AUDIT_LOG: true,
          BUILTINS: true,
          CLOCK: true,
          ONBOARDING: true,
          MODEL_LEDGER: true,
          DATA_STORES: true,
          WORKFLOW_RUNS: true,
          ACTION_INVOCATIONS: true,
          CHAT_STATE: true,
          // Connect's own, as connect answered for them.
          "connect.DB": true,
          "connect.LOADER": true,
          "connect.CLOCK": true,
        },
      },
      core: { armed: true, tasks: clockTasks.map(({ name }) => name) },
      connect: true,
      alarmArmed: true,
    });
    // Connect's clock, through its binding: its own tasks.
    expect(clocks.connect?.tasks).toContain("oauth.flows");
    for (const secret of [
      env.ROUTER_SECRET,
      env.BETTER_AUTH_SECRET,
      env.CAPABILITY_SIGNING_KEY,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers anyone else as core answers a path it has no route for, and does nothing for them", async () => {
    await send({ path: "/health", method: "GET" });
    await disarm();
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const otherClient = "another-client-auth-secret-of-32-chars-or-more";
    const refused: Sent[] = [
      // Through the router, as anyone's request comes.
      { body: fresh },
      { body: fresh, signature: "0".repeat(64) },
      // Another client's console signature.
      { body: fresh, signature: await signatureOf(fresh, otherClient) },
      // The onboarding summary's, which the admin signs with this
      // client's key for another purpose.
      {
        body: fresh,
        signature: await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          onboardingSummaryPurpose
        ),
      },
      // Caught on its way and sent again later.
      { body: old, signature: await signatureOf(old) },
      { body: "{}", signature: await signatureOf("{}") },
      { method: "GET", signature: await signatureOf(fresh) },
    ];

    const answers = await Promise.all(
      refused.map(async (request) => [
        await seen(await send(request)),
        await seen(await send({ ...request, path: "/platform/nothing" })),
      ])
    );

    for (const [probed, unknown] of answers) {
      expect(probed).toStrictEqual(unknown);
    }
    await expect(alarmOf()).resolves.toBeNull();
  });

  it("refuses a signed probe without the router secret, or with another client's, as it refuses any path", async () => {
    const body = bodyAt();
    const signature = await signatureOf(body);
    const answers = await Promise.all(
      [null, "another-clients-router-secret"].map(async (routerSecret) => [
        await seen(await send({ body, signature, routerSecret })),
        await seen(
          await send({
            body,
            signature,
            routerSecret,
            path: "/platform/nothing",
          })
        ),
      ])
    );

    for (const [probed, unknown] of answers) {
      expect(probed).toMatchObject({ status: 403 });
      expect(probed).toStrictEqual(unknown);
    }
  });

  it("says which binding and clock didn't answer, without why", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: Env = {
      ...deployed,
      FILES: down(env.FILES, "bucket 4f1c0a77d2 is gone"),
      CONNECT: down(env.CONNECT, "connect isn't deployed"),
      APPS: down(env.APPS, "namespace 9b3e7d10aa isn't bound"),
      // Neither sandbox runs App code: the host this test pool binds, nor
      // the Loader.
      ...(env.SANDBOX_HOST === undefined
        ? {}
        : { SANDBOX_HOST: down(env.SANDBOX_HOST, "pool 51c2e9 is full") }),
      LOADER: down(env.LOADER, "pool 51c2e9 is full"),
    };

    const response = await probe(failing);
    warnings.mockRestore();
    const text = await response.text();

    expect(provisionProbeSchema.parse(JSON.parse(text))).toMatchObject({
      bindings: {
        DB: true,
        FILES: false,
        CONNECT: false,
        APPS: false,
        WORKSPACES: true,
        LOADER: false,
        "connect.CLOCK": false,
      },
      clocks: { core: { armed: true }, connect: null },
    });
    expect(text).not.toContain("4f1c0a77d2");
    expect(text).not.toContain("9b3e7d10aa");
    expect(text).not.toContain("51c2e9");
    expect(text).not.toContain("deployed");
  });

  it("says when it runs as no client the console deployed", async () => {
    const response = await probe(env);
    expect(provisionProbeSchema.parse(await response.json())).toMatchObject({
      clientId: null,
    });
  });
});

/** Connect as core's binding reaches it, with `version` answering as given. */
const connectWhose = (version: () => Promise<string | null>) =>
  new Proxy(env.CONNECT, {
    get: (target, property): unknown =>
      property === "version" ? version : Reflect.get(target, property),
  });

// The admin's request for connect's version (connectVersionResponse), on
// the probe's model: only the admin's, signed for this purpose, answers;
// anyone else, the router's secret alone included, is answered as a path
// core has no route for.
describe("the admin's request for connect's version", () => {
  /** The admin's request, signed with this purpose's key, to core with `coreEnv`. */
  const asked = async (coreEnv = deployed): Promise<Response> => {
    const body = bodyAt();
    return await send({
      path: connectVersionPath,
      body,
      signature: await signatureOf(
        body,
        env.BETTER_AUTH_SECRET,
        connectVersionPurpose
      ),
      coreEnv,
    });
  };

  it("names the version connect answers as, as connect names it, never cached", async () => {
    const response = await asked();
    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      body: { ok: true, version: connectVersionMetadata.id },
    });
  });

  it("answers the public, and anything the admin didn't sign for it, as a path core has no route for", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const refused: Sent[] = [
      // Through the router, as anyone's request comes: its secret alone.
      { body: fresh },
      { method: "GET" },
      { body: fresh, signature: "0".repeat(64) },
      // The probe's signature: this client's key for another purpose.
      { body: fresh, signature: await signatureOf(fresh) },
      // Caught on its way and sent again later.
      {
        body: old,
        signature: await signatureOf(
          old,
          env.BETTER_AUTH_SECRET,
          connectVersionPurpose
        ),
      },
    ];

    const answers = await Promise.all(
      refused.map(async (request) => [
        await seen(await send({ ...request, path: connectVersionPath })),
        await seen(await send({ ...request, path: "/platform/nothing" })),
      ])
    );

    for (const [askedFor, unknown] of answers) {
      expect(askedFor).toStrictEqual(unknown);
    }
  });

  it("names no version for a connect that doesn't answer, or has none", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const responses = await Promise.all(
      [
        connectWhose(
          async () => await Promise.reject(new Error("connect unavailable"))
        ),
        connectWhose(async () => await Promise.resolve(null)),
      ].map(async (connect) => await asked({ ...deployed, CONNECT: connect }))
    );
    warnings.mockRestore();
    await expect(
      Promise.all(
        responses.map(async (response) => ({
          status: response.status,
          body: await response.json(),
        }))
      )
    ).resolves.toStrictEqual([
      { status: 503, body: { ok: false } },
      { status: 503, body: { ok: false } },
    ]);
  });
});
