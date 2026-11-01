import { env } from "cloudflare:workers";
import { and, asc, eq } from "drizzle-orm";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { clientGrid } from "../src/clients/grid.ts";
import { auditEvents, clientProvisions, releases } from "../src/db/schema.ts";
import {
  autoResumeAction,
  episodeOf,
  markNeedsAttention,
  needsAttentionAction,
} from "../src/hosting/attention.ts";
import { retryProvisioningFn } from "../src/hosting/functions.ts";
import {
  reconcileClient,
  reconcileProvisioning,
} from "../src/hosting/reconcile.ts";
import { failureCause } from "../src/hosting/words.ts";
import { createClient } from "../src/provision/control.ts";
import { getProvisioning } from "../src/provision/queries.ts";
import worker from "../src/server.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, release, staff } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { ended, startsOf } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// Provisioning that heals itself (src/hosting/reconcile.ts): the admin's
// cron resumes a client that isn't getting anywhere, and tells staff only
// when it can't. How it can fail, each tried below:
// - A stuck client left for a person: an attempt gone, a step that failed
//   for something passing, a release fixed by a newer one.
// - Resuming on every tick, or never backing off.
// - Staff told on every tick, or never; or for something passing it got
//   through by itself.
// - Resuming what a person must look at first, such as a hosting check
//   that didn't hold.
// - Two runs at once starting two attempts, or telling staff twice.
// - Staff's own retry not counting: its automatic retries never start
//   again.

const token = "test-deployer-token-reconcile-4c7d20";
mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const hour = 60 * 60 * 1000;

/** Far enough ahead that any backoff has passed. */
const later = (): Date => new Date(Date.now() + 5 * hour);

/** A release imported to provision with, built now: newer than any before it. */
const importedRelease = async (): Promise<string> => {
  const manifest = await release();
  const now = new Date();
  await db.insert(releases).values({
    id: manifest.releaseId,
    commitSha: manifest.commit,
    manifest: JSON.stringify(manifest),
    manifestSha256: "0".repeat(64),
    builtAt: now,
    importedAt: now,
  });
  return manifest.releaseId;
};

/** A client added by staff, as the new-organization form does, with nothing started. */
const added = async (
  hosting: "grasp_cloud" | "on_prem" = "grasp_cloud"
): Promise<string> =>
  await createClient(env, staff, {
    hosting,
    clientId: `acme-${crypto.randomUUID().slice(0, 8)}`,
    name: "Acme",
    ring: 1,
    signIn: {
      domains: ["acme.test"],
      admins: ["ada@acme.test"],
      entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
    },
  });

/** Ends run `runId` by hand unless it ended already, as one the engine lost or staff stopped. */
const terminated = async (runId: string): Promise<void> => {
  const run = await adminWorkflow(
    env,
    adminWorkflows.provisionPlacedClient
  ).get(runId);
  // One that ended already can't be terminated, and needn't be.
  await run.terminate().catch(() => {});
  await ended(adminWorkflows.provisionPlacedClient, runId);
};

/** Client `clientId`'s operation, set as having stopped with `error` once its last attempt ended. */
const stopped = async (
  clientId: string,
  runId: string,
  error: string,
  status: "failed" | "running" = "failed"
): Promise<void> => {
  await terminated(runId);
  await db
    .update(clientProvisions)
    .set({ status, error: status === "failed" ? error : null })
    .where(eq(clientProvisions.clientId, clientId));
};

/** The audited actions of client `clientId` named `action`, oldest first, with who did them. */
const audited = async (clientId: string, action: string) =>
  await db
    .select({ actor: auditEvents.actor, detail: auditEvents.detail })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(asc(auditEvents.at));

/** An audit event's detail. */
const detailOf = (detail: string | null) =>
  z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .parse(JSON.parse(detail ?? "{}"));

/** The details of the audited actions of client `clientId` named `action`, oldest first. */
const detailsOf = async (clientId: string, action: string) => {
  const rows = await audited(clientId, action);
  return rows.map(({ detail }) => detailOf(detail));
};

/** Where client `clientId` stands for staff: its Setup's need, the Platform grid's, and its Setup page. */
const standingOf = async (clientId: string) => {
  const view = await getProvisioning(env, clientId);
  const grid = await clientGrid(env);
  const { html } = await page(`/organizations/${clientId}/setup`, staff.email);
  return {
    setup: view?.needsAttention?.reason ?? null,
    grid: grid.find(({ id }) => id === clientId)?.setup ?? null,
    shown: html.includes("Needs attention") && html.includes("Retry now"),
  };
};

/** Starts client `clientId`'s provisioning as staff would, returning the attempt. */
const startedByStaff = async (clientId: string): Promise<string> => {
  const result = await callServerFn(
    retryProvisioningFn,
    { clientId },
    { email: staff.email }
  );
  if (result.runId === null) {
    throw new Error(`Starting ${clientId} was refused: ${result.refused}`);
  }
  return result.runId;
};

describe("provisioning that heals itself", () => {
  useStoreSecrets({ deployer: token });
  beforeAll(async () => {
    await destination();
    await importedRelease();
  });
  beforeEach(() => {
    // Attempts log why they stopped; alerts with no channel are logged.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("starts a client nothing keeps from starting, and leaves one not added yet alone", async () => {
    const clientId = await added();
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const first = await reconcileClient(env, clientId);
    const unknown = await reconcileClient(env, "nobody-here");
    const resumes = await detailsOf(clientId, autoResumeAction);

    expect({
      first,
      unknown,
      starts: runs.started.length,
      resumes: resumes.length,
    }).toStrictEqual({
      first: "resumed",
      unknown: "progressing",
      starts: 1,
      resumes: 1,
    });
    await terminated(runs.started[0] ?? "");
  });

  it("resumes an operation whose attempt is gone, and one stopped for something passing, backing off between", async () => {
    const gone = await added();
    const passing = await added();
    await stopped(gone, await startedByStaff(gone), "", "running");
    await stopped(passing, await startedByStaff(passing), "probe_unanswered");
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const now = new Date();
    const resumed = await reconcileProvisioning(env, now);
    await stopped(passing, runs.started.at(-1) ?? "", "cloudflare_503");
    const tooSoon = await reconcileClient(
      env,
      passing,
      new Date(Date.now() + 60_000)
    );
    const due = await reconcileClient(
      env,
      passing,
      new Date(Date.now() + 6 * 60_000)
    );

    const goneResumes = await detailsOf(gone, autoResumeAction);
    const passingResumes = await detailsOf(passing, autoResumeAction);
    expect({
      gone: resumed[gone],
      passing: resumed[passing],
      tooSoon,
      due,
      starts: runs.started.length,
      after: passingResumes,
      // Its attempt ended before it was done: errored or terminated.
      goneAfter: goneResumes.map(({ after }) =>
        String(after).startsWith("run_")
      ),
    }).toStrictEqual({
      gone: "resumed",
      passing: "resumed",
      // 5 minutes after its first automatic resume.
      tooSoon: "backing_off",
      due: "resumed",
      starts: 3,
      after: [
        { attempt: 1, after: "probe_unanswered" },
        { attempt: 2, after: "cloudflare_503" },
      ],
      goneAfter: [true],
    });
    for (const runId of runs.started) {
      // oxlint-disable-next-line no-await-in-loop -- a few runs
      await terminated(runId);
    }
  });

  it("asks a person to look once its automatic resumes haven't got it through, keeps resuming, and a staff retry clears it", async () => {
    const clientId = await added();
    let runId = await startedByStaff(clientId);
    using runs = startsOf(adminWorkflows.provisionPlacedClient);
    const outcomes: string[] = [];
    for (let tick = 0; tick < 5; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await stopped(clientId, runId, "probe_clock_unarmed");
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      outcomes.push(await reconcileClient(env, clientId, later()));
      runId = runs.started.at(-1) ?? runId;
    }
    await stopped(clientId, runId, "probe_clock_unarmed");
    const needing = await standingOf(clientId);
    const recorded = await detailsOf(clientId, needsAttentionAction);
    runId = await startedByStaff(clientId);
    await stopped(clientId, runId, "probe_clock_unarmed");
    const afterRetry = await standingOf(clientId);
    const resumedAfterRetry = await reconcileClient(env, clientId, later());
    const resumes = await detailsOf(clientId, autoResumeAction);

    expect({
      outcomes,
      recorded,
      needing,
      afterRetry,
      resumedAfterRetry,
      resumesSinceRetry: resumes.at(-1)?.attempt,
    }).toStrictEqual({
      outcomes: ["resumed", "resumed", "resumed", "resumed", "resumed"],
      // Once, as its third automatic resume didn't get through.
      recorded: [{ attempts: 3, code: "probe_clock_unarmed" }],
      needing: {
        setup: "stuck",
        grid: { state: "needs_attention", reason: "stuck" },
        shown: true,
      },
      // Staff's retry starts a new episode: stopped again, Grasp retries.
      afterRetry: { setup: null, grid: { state: "stopped" }, shown: false },
      resumedAfterRetry: "resumed",
      resumesSinceRetry: 1,
    });
    await terminated(runs.started.at(-1) ?? "");
  });

  it("never starts an organization on its own premises, or asks anyone to look at it", async () => {
    const clientId = await added("on_prem");
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const outcomes = [
      await reconcileClient(env, clientId, later()),
      await reconcileClient(env, clientId, later()),
    ];
    const recorded = await detailsOf(clientId, needsAttentionAction);

    expect({ outcomes, starts: runs.started.length, recorded }).toStrictEqual({
      outcomes: ["waiting", "waiting"],
      starts: 0,
      recorded: [],
    });
  });

  it("resumes nothing a person must look at first, and asks once, however often it looks or how many look at once", async () => {
    const clientId = await added();
    await stopped(
      clientId,
      await startedByStaff(clientId),
      "resource_outside_jurisdiction"
    );
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const outcomes = await Promise.all([
      reconcileClient(env, clientId, later()),
      reconcileClient(env, clientId, later()),
    ]);
    const again = await reconcileClient(env, clientId, later());
    const recorded = await detailsOf(clientId, needsAttentionAction);

    expect({
      outcomes,
      again,
      starts: runs.started.length,
      recorded,
      standing: await standingOf(clientId),
    }).toStrictEqual({
      outcomes: ["needs_staff", "needs_staff"],
      again: "needs_staff",
      starts: 0,
      recorded: [{ attempts: 0, code: "resource_outside_jurisdiction" }],
      standing: {
        setup: "needs_person",
        grid: { state: "needs_attention", reason: "needs_person" },
        shown: true,
      },
    });
  });

  it("waits on a release that can't go there until a newer one is imported, then resumes onto it", async () => {
    const clientId = await added();
    const runId = await startedByStaff(clientId);
    const [operation] = await db
      .select({ releaseId: clientProvisions.releaseId })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId));
    await stopped(clientId, runId, "unknown_worker");
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const waiting = await reconcileClient(env, clientId, later());
    const newer = await importedRelease();
    const resumed = await reconcileClient(env, clientId, later());
    const [after] = await db
      .select({ releaseId: clientProvisions.releaseId })
      .from(clientProvisions)
      .where(eq(clientProvisions.clientId, clientId));

    expect({
      waiting,
      resumed,
      from: operation?.releaseId === newer,
      to: after?.releaseId,
      starts: runs.started.length,
    }).toStrictEqual({
      waiting: "needs_staff",
      resumed: "resumed",
      from: false,
      to: newer,
      starts: 1,
    });
    await terminated(runs.started.at(-1) ?? "");
  });

  it("asks a person to look when resuming is refused for something lasting, and only waits on another run", async () => {
    const clientId = await added();
    await stopped(clientId, await startedByStaff(clientId), "probe_unanswered");
    // Its scripts ran a Durable Object migration no newer release has, so
    // the newer release resuming would take it to is refused, and stays so.
    await db
      .update(clientProvisions)
      .set({ progress: JSON.stringify({ migrated: { core: "v99" } }) })
      .where(eq(clientProvisions.clientId, clientId));
    await importedRelease();
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const lasting = await reconcileClient(env, clientId, later());
    const recorded = await detailsOf(clientId, needsAttentionAction);

    expect({ lasting, starts: runs.started.length, recorded }).toStrictEqual({
      lasting: "needs_staff",
      starts: 0,
      recorded: [{ attempts: 0, code: "release_behind_migration" }],
    });
  });

  it("records no attention in an episode staff have since started afresh", async () => {
    const clientId = await added();
    await stopped(clientId, await startedByStaff(clientId), "probe_unanswered");
    const stale = await episodeOf(db, clientId);
    // Staff act on it before the reconciler records anything.
    await scheduler.wait(2);
    await stopped(clientId, await startedByStaff(clientId), "probe_unanswered");

    const recorded = await markNeedsAttention(db, clientId, stale, {
      reason: "stuck",
      code: "probe_unanswered",
    });

    expect({
      recorded,
      events: await detailsOf(clientId, needsAttentionAction),
    }).toStrictEqual({ recorded: false, events: [] });
  });

  it("reconciles on the cron even when importing releases fails", async () => {
    const clientId = await added();
    using runs = startsOf(adminWorkflows.provisionPlacedClient);
    const failing = new Proxy(env.RELEASES, {
      get: (target, name): unknown => {
        if (name === "list" || name === "get" || name === "head") {
          return async () => await Promise.reject(new Error("R2 is down"));
        }
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await worker.scheduled?.(
      {
        cron: "*/5 * * * *",
        scheduledTime: Date.now(),
        noRetry: () => {},
      },
      { ...env, RELEASES: failing }
    );
    const resumes = await detailsOf(clientId, autoResumeAction);

    // Every client still being provisioned is looked at: this one resumed.
    expect(resumes).toHaveLength(1);
    for (const runId of runs.started) {
      // oxlint-disable-next-line no-await-in-loop -- a few runs
      await terminated(runId);
    }
  });

  it("starts one attempt when two runs look at once", async () => {
    const clientId = await added();
    await stopped(
      clientId,
      await startedByStaff(clientId),
      "upload_unobserved"
    );
    using runs = startsOf(adminWorkflows.provisionPlacedClient);

    const outcomes = await Promise.all([
      reconcileClient(env, clientId, later()),
      reconcileClient(env, clientId, later()),
    ]);

    const resumes = await detailsOf(clientId, autoResumeAction);
    expect({
      outcomes: outcomes.toSorted(),
      starts: runs.started.length,
      resumes: resumes.length,
    }).toStrictEqual({
      outcomes: ["refused", "resumed"],
      starts: 1,
      resumes: 1,
    });
    await terminated(runs.started.at(-1) ?? "");
  });
});

describe("what a stopped provisioning needs", () => {
  it("is a retry for what passes, the release's for what a release fixes, and a person's for the rest", () => {
    expect(
      [
        "probe_unanswered",
        "run_gone",
        "unexpected",
        "cloudflare_503_10013",
        "cloudflare_429",
        "unknown_worker",
        "resource_outside_jurisdiction",
        "foreign_resource",
        "sign_in_incomplete",
        "cloudflare_403_10000",
        "store_secret_missing: DEPLOYER_API_TOKEN",
        "client_domain_unset",
      ].map(failureCause)
    ).toStrictEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "retry",
      "release",
      "staff",
      "staff",
      "staff",
      "staff",
      "staff",
      "staff",
    ]);
  });
});
