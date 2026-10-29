import {
  planDocumentText,
  signedPlanSchema,
  verifyPlanSignature,
} from "@grasp-os/connector-kit/plan-signature";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  approvePlan,
  recordPlan,
  requestBuild,
  sendBackPlan,
} from "../src/builds/builds.ts";
import { signedPlan } from "../src/builds/plan-signing.ts";
import type { BuildPlan } from "../src/builds/plan.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { stepSucceeded } from "./runs.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// The approved plan of a build, signed (src/builds/plan-signing.ts), from
// its threat model: the agent can't sign a plan, so a signature must mean
// a person approved exactly that plan, for that app and that round. Not
// before the approval, not for a plan sent back, not without the admin's
// key; and a signature passes for no other app, host or key.

const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A new app's connector name, unique to the test. */
const newApp = () => `app-${crypto.randomUUID().slice(0, 8)}`;

/** A plan for `app`, signed in to with an API key: no credentials stage. */
const planFor = (app: string): BuildPlan => ({
  app,
  signIn: "api_key",
  hosts: ["api.example-hr.test"],
  actions: [
    {
      action: "employees.read",
      description: "Reads the company's employees.",
      changes: false,
      hosts: ["api.example-hr.test"],
    },
  ],
  docs: ["https://developer.example-hr.test/docs"],
});

/** Bytes as standard base64. */
const base64 = (bytes: ArrayBuffer): string =>
  btoa(String.fromCodePoint(...new Uint8Array(bytes)));

/** An Ed25519 key pair: the private half as the store keeps it, the public as CI does. */
const keyPair = async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) {
    throw new Error("Expected a key pair");
  }
  return {
    privateKey: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: base64(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
};

/** The code an action was refused with, or `resolved`. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error && "code" in error ? error.code : error;
  }
  return "resolved";
};

/** A build of a new app whose run is waiting for its first plan. */
const awaitingPlan = async () => {
  const app = newApp();
  const runId = await requestBuild(env, staff, { app, name: "Example HR" });
  await stepSucceeded(adminWorkflows.integrationBuild, runId, "plan 1 check");
  return { app, runId };
};

describe("an approved plan, signed", () => {
  useStoreSecrets({ deployer: "deployer-token", tenant: "tenant-token" });

  it("is signed only once a person approved it, and passes for nothing else", async () => {
    const { privateKey, publicKey } = await keyPair();
    const other = await keyPair();
    await setStoreSecret(env.PLAN_SIGNING_KEY, "PLAN_SIGNING_KEY", privateKey);
    const { app, runId } = await awaitingPlan();

    const unknown = await codeOf(signedPlan(env, newApp()));
    const asked = await codeOf(signedPlan(env, app));
    await recordPlan(env, app, planFor(app));
    const waiting = await codeOf(signedPlan(env, app));
    await stepSucceeded(
      adminWorkflows.integrationBuild,
      runId,
      "decision 1 check"
    );
    await sendBackPlan(env, staff, app, 1, "Only what reads employees.");
    const sentBack = await codeOf(signedPlan(env, app));
    await stepSucceeded(adminWorkflows.integrationBuild, runId, "plan 2 check");
    await recordPlan(env, app, planFor(app));
    await approvePlan(env, staff, app, 2);
    const { text, signature } = await signedPlan(env, app);
    const document = signedPlanSchema.parse(JSON.parse(text));
    const anotherApp = planDocumentText({
      app: newApp(),
      round: 2,
      plan: planFor(app),
    });
    const moreHosts = planDocumentText({
      app,
      round: 2,
      plan: { ...planFor(app), hosts: ["api.example-hr.test", "evil.test"] },
    });

    expect({
      unknown,
      asked,
      waiting,
      sentBack,
      document: {
        app: document.app,
        round: document.round,
        hosts: document.plan.hosts,
      },
      verifies: await verifyPlanSignature(publicKey, text, signature),
      anotherApp: await verifyPlanSignature(publicKey, anotherApp, signature),
      moreHosts: await verifyPlanSignature(publicKey, moreHosts, signature),
      anotherKey: await verifyPlanSignature(other.publicKey, text, signature),
    }).toStrictEqual({
      unknown: "unknown_build",
      asked: "wrong_stage",
      waiting: "wrong_stage",
      sentBack: "wrong_stage",
      document: { app, round: 2, hosts: ["api.example-hr.test"] },
      verifies: true,
      anotherApp: false,
      moreHosts: false,
      anotherKey: false,
    });
  });

  it("signs nothing while the admin has no key", async () => {
    const { app } = await awaitingPlan();
    await recordPlan(env, app, planFor(app));
    await approvePlan(env, staff, app, 1);

    await expect(signedPlan(env, app)).rejects.toThrow(
      "PLAN_SIGNING_KEY is missing from Secrets Store"
    );
  });
});
