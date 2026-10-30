import { clientsNamespace } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import { clientPlacements, clientProvisions } from "../src/db/schema.ts";
import { signInApps } from "../src/deploy/context.ts";
import type { DeploySecrets } from "../src/deploy/secrets.ts";
import {
  runClientProvision,
  provisionSteps,
} from "../src/hosting/operation.ts";
import { cloudLines, provisioningProgress } from "../src/hosting/progress.ts";
import {
  checkClientIdFn,
  detectSignInFn,
  startClient,
} from "../src/provision/functions.ts";
import { claimRun } from "../src/runners.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, staff } from "./hosting.ts";
import { namespaceRelease } from "./namespace-release.ts";
import { graspAccount, ownId } from "./own-destination.ts";
import { callServerFn } from "./pages.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Creating an organization from its three fields (src/routes/new-organization.tsx):
// its web address checked as it is typed, how its people sign in found
// from its email domain, and creating it, which sets it up with nothing
// else asked of anyone. How it can fail, each tried below:
// - A web address taken, reserved or malformed let through.
// - Sign-in guessed wrong from a domain, or a lookup that fails taken for
//   an answer (DNS-over-HTTPS and Microsoft's sign-in service are outside
//   systems here, answered by stand-ins).
// - Creating it leaving anything for staff to do before it is live.
// - Its progress drifting from the steps that actually run.

const token = "test-deployer-token-create-org-91d2";
const cloudflare = mockCloudflareApi(token);
mockAccess();

const tenant = "4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** What the stand-ins for DNS and Microsoft answer, by domain. */
const mailHosts: Readonly<Record<string, string[]>> = {
  "acme.test": ["1 aspmx.l.google.com."],
  "contoso.test": ["0 contoso-test.mail.protection.outlook.com."],
  "plain.test": ["10 mx.plain.test."],
};

/** Answers DNS-over-HTTPS and Microsoft's OpenID configuration; the rest goes to the fake Cloudflare API. */
const standInsForLookups = () => {
  const earlier = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.host === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      if (name === "down.test") {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        Status: 0,
        Answer: (mailHosts[name] ?? []).map((data) => ({ type: 15, data })),
      });
    }
    if (url.host === "login.microsoftonline.com") {
      return url.pathname.startsWith("/contoso.test/")
        ? Response.json({
            issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
          })
        : new Response("not found", { status: 400 });
    }
    if (earlier === undefined) {
      throw new Error(`Unexpected request to ${url.href}`);
    }
    return await earlier(input, init);
  });
};

const secrets: DeploySecrets = {
  routerKey: "test-router-key",
  clientKey: "test-client-key",
  shared: { connect: { COMPOSIO_API_KEY: "composio" } },
};

describe("creating an organization", () => {
  useStoreSecrets({ deployer: token });
  beforeEach(() => {
    standInsForLookups();
    // A run that stops logs why.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("finds how a company signs in from its domain, and finds nothing rather than guess", async () => {
    // Loaded once before the calls at once: in the test pool a server
    // function's module loads lazily through Vite's module runner, a round
    // trip of the first request's own, which requests at once can't share
    // (workerd refuses another request's I/O). A built Worker has every
    // module bundled, so production loads nothing this way.
    await callServerFn(
      detectSignInFn,
      { domain: "plain.test" },
      { email: staff.email }
    );
    const found = await Promise.all(
      [
        "acme.test",
        "contoso.test",
        "plain.test",
        "down.test",
        "not a domain",
      ].map(
        async (domain) =>
          await callServerFn(detectSignInFn, { domain }, { email: staff.email })
      )
    );

    expect(found).toStrictEqual([
      { provider: "google", googleHostedDomain: "acme.test" },
      { provider: "microsoft", entraTenantId: tenant },
      { provider: null },
      { provider: null },
      { provider: null },
    ]);
  });

  it("checks its web address as it is typed: free, taken, reserved or malformed", async () => {
    graspAccount(cloudflare);
    await namespaceRelease();
    const taken = `taken-${crypto.randomUUID().slice(0, 6)}`;
    await callServerFn(
      startClient,
      {
        clientId: taken,
        name: "Taken",
        hosting: "on_prem",
        signIn: {
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          googleHostedDomain: "acme.test",
        },
      },
      { email: staff.email }
    );

    const answers = await Promise.all(
      [
        `free-${crypto.randomUUID().slice(0, 6)}`,
        taken,
        "admin",
        "Acme Inc",
      ].map(async (clientId) => {
        const { problem } = await callServerFn(
          checkClientIdFn,
          { clientId },
          { email: staff.email }
        );
        return problem;
      })
    );

    expect(answers).toStrictEqual([
      null,
      `${taken} is taken: choose another.`,
      "admin is reserved for Grasp itself: choose another.",
      "Use only lowercase letters, digits and dashes.",
    ]);
  });

  it("sets it up end to end from its three fields, with nothing else asked of staff, and its progress follows every step", async () => {
    const account = graspAccount(cloudflare);
    const manifest = await namespaceRelease();
    const clientId = `acme-${crypto.randomUUID().slice(0, 8)}`;
    const signIn = await callServerFn(
      detectSignInFn,
      { domain: "acme.test" },
      { email: staff.email }
    );
    // In the tests' pool its attempt can't reach Cloudflare's dispatch
    // namespace: its first migration fails, so the attempt waits after
    // its resources, and is ended there; its step then runs on, as the
    // attempt would, with the fake namespace's dispatcher.
    cloudflare.failNext(
      (call) => call.path.endsWith("/query"),
      "statement-failed"
    );
    using attempts = startsOf(adminWorkflows.provisionPlacedClient);

    const created = await callServerFn(
      startClient,
      {
        clientId,
        name: "Acme",
        signIn: {
          domains: ["acme.test"],
          admins: ["ada@acme.test"],
          ...(signIn.provider === "google"
            ? { googleHostedDomain: signIn.googleHostedDomain }
            : {}),
        },
      },
      { email: staff.email }
    );
    const attemptId = attempts.started.at(-1) ?? "";
    const midway = await provisioningProgress(env, clientId);
    await vi.waitFor(async () => {
      const operation = await db
        .select({ step: clientProvisions.step })
        .from(clientProvisions)
        .where(eq(clientProvisions.clientId, clientId))
        .get();
      if (operation?.step !== "resources") {
        throw new Error("Its attempt hasn't made its resources yet");
      }
    });
    const attempt = await adminWorkflow(
      env,
      adminWorkflows.provisionPlacedClient
    ).get(attemptId);
    await attempt.terminate();
    // Ended before the step runs on: nothing of it is left going after.
    await ended(adminWorkflows.provisionPlacedClient, attemptId);
    const runId = await claimRun(
      db,
      "system",
      clientId,
      attemptId,
      { action: "client.provision_placed", clientId },
      { kind: "provision_placed", runId: `${clientId}-p2` }
    );
    await runClientProvision(
      {
        api: cloudflareApi({ token, retryDelayMs: 0 }),
        db,
        store: env.RELEASES,
        secrets,
        router: {
          hosts: env.ROUTER_HOSTS,
          domain: "grasp.test",
          smoke: { retryDelayMs: 0 },
          namespace: clientsNamespace("production"),
          dispatcher: cloudflare.dispatcher(
            account.id,
            clientsNamespace("production")
          ),
        },
        observe: { retryDelayMs: 0 },
        signInApps: signInApps(env),
      },
      { clientId, runId: runId ?? "" }
    );
    const ready = await provisioningProgress(env, clientId);
    const operation = await db
      .select({ releaseId: clientProvisions.releaseId })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId))
      .get();

    expect({
      created: created.refused,
      placed: await db
        .select({ destinationId: clientPlacements.destinationId })
        .from(clientPlacements)
        .where(eq(clientPlacements.clientId, clientId))
        .get(),
      release: operation?.releaseId,
      midway: midway?.lines.map(({ id }) => id),
      ready: {
        state: ready?.state,
        hostname: ready?.hostname,
        admins: ready?.admins,
        lines: ready?.lines.map(({ label, state }) => [label, state]),
      },
    }).toStrictEqual({
      created: null,
      placed: { destinationId: ownId },
      release: manifest.releaseId,
      midway: [
        "reserve",
        "storage",
        "install",
        "sign_in",
        "reachable",
        "publish",
        "admins",
      ],
      ready: {
        state: "ready",
        hostname: `${clientId}.grasp.test`,
        admins: ["ada@acme.test"],
        lines: [
          [`Reserving ${clientId}.grasp.test`, "done"],
          ["Creating its databases and file storage", "done"],
          ["Installing Grasp", "done"],
          ["Setting up sign-in with Google Workspace", "done"],
          [
            `Making sure ${clientId}.grasp.test is reachable and everything answers`,
            "done",
          ],
          [`Publishing ${clientId}.grasp.test`, "done"],
          ["Inviting admins", "done"],
        ],
      },
    });
  });

  it("shows an on-premises organization the steps of its own install, waiting for GRA-1291", async () => {
    const clientId = `own-${crypto.randomUUID().slice(0, 8)}`;
    await callServerFn(
      startClient,
      {
        clientId,
        name: "Own Servers",
        hosting: "on_prem",
        signIn: {
          domains: ["contoso.test"],
          admins: ["ada@contoso.test"],
          entraTenantId: tenant,
        },
      },
      { email: staff.email }
    );

    const progress = await provisioningProgress(env, clientId);

    expect({
      state: progress?.state,
      notice: progress?.notice,
      lines: progress?.lines.map(({ label, state }) => [label, state]),
    }).toStrictEqual({
      state: "waiting",
      notice:
        "On-prem setup arrives with GRA-1291: its install will pair, connect and report here by itself.",
      lines: [
        ["Create pairing credential", "waiting"],
        ["Waiting for your install to connect", "waiting"],
        ["First heartbeat received", "waiting"],
        ["Up to date on the newest release", "waiting"],
      ],
    });
  });
});

describe("an organization's progress", () => {
  it("has every step of the operation in exactly one line, in order", () => {
    expect(cloudLines.flatMap(({ steps }) => steps)).toStrictEqual([
      ...provisionSteps,
    ]);
  });
});
