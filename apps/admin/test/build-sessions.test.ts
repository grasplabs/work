import { verifySessionDispatch } from "@grasp-os/connector-kit/session-ticket";
import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approvePlan,
  buildOf,
  recordPlan,
  recordPullRequest,
  requestBuild,
} from "../src/builds/builds.ts";
import type { BuildPlan } from "../src/builds/plan.ts";
import { adminDatabase } from "../src/db/act.ts";
import { auditEvents } from "../src/db/schema.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import {
  ended,
  hurry,
  journalOf,
  stepResult,
  stepSucceeded,
  timedOut,
} from "./runs.ts";
import { setStoreSecret, useStoreSecrets } from "./secrets-store.ts";

// The agent's session for a build (src/builds/session.ts), from its threat
// model: a session starts only from a plan a person approved, with a plan
// and ticket the workflow can verify, naming this build, this plan and a
// nonce kept on the build, so a start made again pushes once; nothing
// starts until a person stored the admin's GitHub token; and however the
// session ends on GitHub (failed, no pull request, refused), the build
// stops for a person rather than going on. GitHub's API is a stand-in.

const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
const builds = adminWorkflows.integrationBuild;
const dispatchToken = "dispatch-token";
const dispatchRoute =
  "/repos/grasplabs/work/actions/workflows/connector-agent.yml/dispatches";

/** A new app's connector name, unique to the test. */
const newApp = () => `app-${crypto.randomUUID().slice(0, 8)}`;

/** A plan for `app`, signed in to with an API key: straight to writing once approved. */
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

const dispatchSchema = z.object({
  ref: z.string(),
  inputs: z.object({
    plan: z.string(),
    plan_signature: z.string(),
    ticket: z.string(),
    ticket_signature: z.string(),
  }),
  return_run_details: z.boolean(),
});

/** Base64 as text. */
const decoded = (text: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(text), (char) => char.codePointAt(0) ?? 0)
  );

/** A run's path in GitHub's API. */
const runPath = /^\/repos\/grasplabs\/work\/actions\/runs\/(?<run>\d+)$/u;

/** One run of the workflow, as the stand-in reports it. */
interface FakeRun {
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | null;
}

/**
 * A stand-in for GitHub's API, as the admin's dispatch token reaches it:
 * it records each request, answers dispatches with a new run (or
 * `refuse`'s status, once each), runs as `runs` says, and lists `pulls`.
 */
const fakeGitHub = () => {
  const requests: {
    method: string;
    path: string;
    auth: string | null;
    body: unknown;
  }[] = [];
  const runs = new Map<number, FakeRun>();
  const refuse: number[] = [];
  let pulls: { number: number; head: { ref: string } }[] = [];
  let next = 9000;
  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body: unknown =
      request.method === "POST" ? await request.json() : undefined;
    requests.push({
      method: request.method,
      path: url.pathname,
      auth: request.headers.get("authorization"),
      body,
    });
    if (url.hostname !== "api.github.com") {
      return new Response("Not GitHub", { status: 599 });
    }
    if (request.method === "POST" && url.pathname === dispatchRoute) {
      const status = refuse.shift();
      if (status !== undefined) {
        return new Response("{}", { status });
      }
      next += 1;
      runs.set(next, { status: "in_progress", conclusion: null });
      return Response.json({
        workflow_run_id: next,
        run_url: `https://api.github.com/repos/grasplabs/work/actions/runs/${next}`,
        html_url: `https://github.com/grasplabs/work/actions/runs/${next}`,
      });
    }
    const run = runPath.exec(url.pathname)?.groups?.run;
    if (run !== undefined) {
      const found = runs.get(Number(run));
      return found === undefined
        ? new Response("{}", { status: 404 })
        : Response.json(found);
    }
    if (url.pathname === "/repos/grasplabs/work/pulls") {
      const head = url.searchParams.get("head") ?? "";
      return Response.json(
        pulls.filter((pull) => head === `grasplabs:${pull.head.ref}`)
      );
    }
    return new Response("{}", { status: 404 });
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
  return {
    requests,
    dispatches: () =>
      requests
        .filter(({ path }) => path === dispatchRoute)
        .map(({ body }) => dispatchSchema.parse(body)),
    end: (id: number, conclusion: FakeRun["conclusion"]) => {
      runs.set(id, { status: "completed", conclusion });
    },
    refuseNext: (status: number) => {
      refuse.push(status);
    },
    openPull: (number: number, ref: string) => {
      pulls = [...pulls, { number, head: { ref } }];
    },
  };
};

/** The admin's keys stored: the plan key's public half, as CI holds it. */
const storeKeys = async (token: string | null = dispatchToken) => {
  const { privateKey, publicKey } = await keyPair();
  await setStoreSecret(env.PLAN_SIGNING_KEY, "PLAN_SIGNING_KEY", privateKey);
  if (token !== null) {
    await setStoreSecret(
      env.AGENT_DISPATCH_TOKEN,
      "AGENT_DISPATCH_TOKEN",
      token
    );
  }
  return publicKey;
};

/** A build of a new app whose plan a person approved: its run starts writing. */
const approvedBuild = async () => {
  const app = newApp();
  const runId = await requestBuild(env, staff, { app, name: "Example HR" });
  await stepSucceeded(builds, runId, "plan 1 check");
  await recordPlan(env, app, planFor(app));
  await stepSucceeded(builds, runId, "decision 1 check");
  await approvePlan(env, staff, app, 1);
  return { app, runId };
};

/** The build of `app`'s audit actions, in order. */
const actionsOf = async (app: string) => {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.target, app))
    .orderBy(asc(auditEvents.at));
  return rows.map(({ action, detail }) => ({
    action,
    detail: z
      .record(z.string(), z.unknown())
      .nullable()
      .parse(JSON.parse(detail ?? "null")),
  }));
};

describe("the agent's session for a build", () => {
  useStoreSecrets({ deployer: "deployer-token" });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts once from the approved plan, signed so the workflow verifies it, and moves on with the pull request it opens", async () => {
    const github = fakeGitHub();
    const publicKey = await storeKeys();
    const { app, runId } = await approvedBuild();
    await stepSucceeded(builds, runId, "session");
    const [dispatch] = github.dispatches();
    const started = await buildOf(db, app);
    const verified =
      dispatch === undefined
        ? undefined
        : await verifySessionDispatch(
            publicKey,
            {
              plan: decoded(dispatch.inputs.plan),
              planSignature: dispatch.inputs.plan_signature,
              ticket: decoded(dispatch.inputs.ticket),
              ticketSignature: dispatch.inputs.ticket_signature,
            },
            Date.now()
          );
    const run = started?.sessionRun ?? 0;
    github.end(run, "success");
    github.openPull(77, `feat/connector-${app}`);
    await timedOut(builds, runId, "session 1");
    await stepSucceeded(builds, runId, "session 1 check");
    const reviewed = await buildOf(db, app);
    const trail = await actionsOf(app);

    expect({
      dispatches: github.dispatches().length,
      ref: dispatch?.ref,
      auth: github.requests[0]?.auth,
      verified:
        verified === undefined || "problems" in verified
          ? verified
          : {
              app: verified.ticket.app,
              round: verified.ticket.round,
              run: verified.ticket.run,
              nonce: verified.ticket.nonce,
              hosts: verified.plan.plan.hosts,
            },
      session: {
        run: started?.sessionRun,
        url: started?.sessionUrl,
      },
      reviewed: {
        stage: reviewed?.stage,
        pullRequest: reviewed?.pullRequest,
        branch: reviewed?.branch,
      },
      trail: trail.filter(({ action }) =>
        ["build.session", "build.pull_request"].includes(action)
      ),
    }).toStrictEqual({
      dispatches: 1,
      ref: "main",
      auth: `Bearer ${dispatchToken}`,
      verified: {
        app,
        round: 1,
        run: runId,
        nonce: started?.sessionNonce,
        hosts: ["api.example-hr.test"],
      },
      session: {
        run,
        url: `https://github.com/grasplabs/work/actions/runs/${run}`,
      },
      reviewed: {
        stage: "in_review",
        pullRequest: 77,
        branch: `feat/connector-${app}`,
      },
      trail: [
        {
          action: "build.session",
          detail: { stage: "writing", run, round: 1 },
        },
        {
          action: "build.pull_request",
          detail: { stage: "in_review", pull_request: 77 },
        },
      ],
    });
  });

  it("dispatches again with the same nonce when GitHub failed the first, so the session it starts pushes once", async () => {
    const github = fakeGitHub();
    await storeKeys();
    github.refuseNext(502);
    const { app, runId } = await approvedBuild();
    // The retry made due at once, as its delay had passed.
    await vi.waitFor(
      async () => {
        await hurry(builds, runId);
        const { steps } = await journalOf(builds, runId);
        if (
          !steps.some(
            ({ name, state }) => name === "session" && state === "succeeded"
          )
        ) {
          throw new Error("The session hasn't started yet");
        }
      },
      { timeout: 10_000, interval: 50 }
    );
    const tickets = github.dispatches().map(({ inputs }) => {
      const [, body = "{}"] = decoded(inputs.ticket).split("\n");
      return z.object({ nonce: z.string() }).parse(JSON.parse(body)).nonce;
    });
    const kept = await buildOf(db, app);

    expect({
      tickets: tickets.length,
      nonces: new Set(tickets).size,
      kept: kept?.sessionNonce,
    }).toStrictEqual({
      tickets: 2,
      nonces: 1,
      kept: tickets[0],
    });
  });

  it("stops the build for a person when its session fails, or ends with no pull request from the build's own branch", async () => {
    const github = fakeGitHub();
    await storeKeys();
    const failing = await approvedBuild();
    const elsewhere = await approvedBuild();
    await stepSucceeded(builds, failing.runId, "session");
    await stepSucceeded(builds, elsewhere.runId, "session");
    const sessionOf = async (app: string): Promise<number> => {
      const build = await buildOf(db, app);
      return build?.sessionRun ?? 0;
    };
    github.end(await sessionOf(failing.app), "failure");
    github.end(await sessionOf(elsewhere.app), "success");
    github.openPull(78, `feat/connector-${elsewhere.app}-2`);
    await timedOut(builds, failing.runId, "session 1");
    await timedOut(builds, elsewhere.runId, "session 1");
    await ended(builds, failing.runId);
    await ended(builds, elsewhere.runId);
    const stopped = async (app: string) => {
      const build = await buildOf(db, app);
      return {
        stage: build?.stage,
        reason: build?.reason,
        pullRequest: build?.pullRequest,
      };
    };

    expect({
      failing: await stopped(failing.app),
      elsewhere: await stopped(elsewhere.app),
    }).toStrictEqual({
      failing: {
        stage: "needs_person",
        reason: "session_failed",
        pullRequest: null,
      },
      elsewhere: {
        stage: "needs_person",
        reason: "session_without_pull_request",
        pullRequest: null,
      },
    });
  });

  it("stops the build for a person when GitHub refuses to start its session", async () => {
    const github = fakeGitHub();
    await storeKeys();
    github.refuseNext(404);
    const { app, runId } = await approvedBuild();
    await ended(builds, runId);
    const build = await buildOf(db, app);

    expect({
      stage: build?.stage,
      reason: build?.reason,
      session: build?.sessionRun,
    }).toStrictEqual({
      stage: "needs_person",
      reason: "github_404",
      session: null,
    });
  });

  it("starts nothing until a person stores the dispatch token, and the build waits for its pull request as before", async () => {
    const github = fakeGitHub();
    await storeKeys(null);
    const { app, runId } = await approvedBuild();
    const started = await stepResult(builds, runId, "session");
    await recordPullRequest(env, app, {
      number: 79,
      branch: `feat/connector-${app}`,
    });
    await stepSucceeded(builds, runId, "merge check");
    const build = await buildOf(db, app);

    expect({
      started,
      requests: github.requests.length,
      stage: build?.stage,
      nonce: build?.sessionNonce,
    }).toStrictEqual({
      started: null,
      requests: 0,
      stage: "in_review",
      nonce: null,
    });
  });
});
