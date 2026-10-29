import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { act, adminDatabase } from "../src/db/act.ts";
import {
  auditEvents,
  clients,
  rollouts,
  rolloutTargets,
} from "../src/db/schema.ts";
import { placeClient } from "../src/hosting/inventory.ts";
import { importReleases } from "../src/releases/import.ts";
import { startRolloutFn } from "../src/rollout/functions.ts";
import { startRequestOf } from "../src/rollout/start-request.ts";
import type { StartChoices } from "../src/rollout/start-request.ts";
import { adminWorkflow, adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { destination } from "./hosting.ts";
import { callServerFn, page } from "./pages.ts";
import { publishRelease } from "./releases.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-rollout-pages-3c9e17";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A release, published and imported. */
const importedRelease = async (): Promise<string> => {
  const release = await publishRelease({ notes: "feat(core): roll out" });
  await importReleases(env.RELEASES, db);
  return release.id;
};

/**
 * An active client in `ring`, placed in a destination of its own on a new
 * account in the fake, pinned to `pinnedReleaseId` if given.
 */
const recordClient = async (ring: number, pinnedReleaseId?: string) => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount();
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: `Acme ${id}`,
        ring,
        status: "active",
        pinnedReleaseId: pinnedReleaseId ?? null,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  // Rollouts reach only placed clients.
  await placeClient(db, staff, {
    clientId: id,
    destinationId: await destination({
      kind: "dedicated",
      accountId: account.id,
      namespace: null,
    }),
    policyId: "eu-storage",
  });
  return id;
};

/**
 * A rollout of `releaseId` (a secrets rollout for null) waiting for
 * approval after ring 0, which it reached `reached` in, with `pending`
 * (and `morePending`) in ring 1: as its run leaves it.
 */
const waitingRollout = async (
  releaseId: string | null,
  reached: string,
  pending: string,
  morePending: readonly string[] = []
): Promise<string> => {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.batch([
    db.insert(rollouts).values({
      id,
      kind: releaseId === null ? "secrets" : "release",
      releaseId,
      status: "waiting",
      ring: 0,
      startedBy: staff.email,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(rolloutTargets).values([
      {
        rolloutId: id,
        clientId: reached,
        ring: 0,
        status: "done",
        updatedAt: now,
      },
      ...[pending, ...morePending].map((clientId) => ({
        rolloutId: id,
        clientId,
        ring: 1,
        status: "pending" as const,
        updatedAt: now,
      })),
    ]),
  ]);
  return id;
};

/** How many times `text` appears in `html`. */
const count = (html: string, text: string): number =>
  html.split(text).length - 1;

describe("the rollout pages", () => {
  useStoreSecrets({ deployer: token });

  it("list rollouts, with the form to start one on the newest release", async () => {
    const release = await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(release, reached, pending);

    const { status, html } = await page("/platform/rollouts");

    expect({
      status,
      listed: html.includes(`href="/platform/rollouts/${rolloutId}"`),
      release: html.includes(release),
      form: html.includes("Start rollout"),
      newest: html.includes(`value="${release}"`),
    }).toStrictEqual({
      status: 200,
      listed: true,
      release: true,
      form: true,
      newest: true,
    });
  });

  it("offer only rings past ring 0 in Selects, with how many clients each has, and say when ring 0 is all there is", async () => {
    await importedRelease();
    // Only this test's clients are active.
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    await recordClient(0);
    await recordClient(0);
    const ringZeroOnly = await page("/platform/rollouts");
    await recordClient(2);
    const withRingTwo = await page("/platform/rollouts");

    expect({
      ringZeroOnly: {
        says: ringZeroOnly.html.includes("reaches only our own deployments"),
        choice: ringZeroOnly.html.includes("One ring"),
        selects: count(ringZeroOnly.html, 'data-slot="select-trigger"'),
      },
      withRingTwo: {
        says: withRingTwo.html.includes("reaches only our own deployments"),
        choice: withRingTwo.html.includes("One ring"),
        // The scope and the ring, each server-rendered with its choice.
        selects: count(withRingTwo.html, 'data-slot="select-trigger"'),
        ringTwo: withRingTwo.html.includes("Production (1 client)"),
        // Alpha comes first whatever's chosen, so it isn't offered.
        ringZero: withRingTwo.html.includes("Alpha ("),
      },
    }).toStrictEqual({
      ringZeroOnly: { says: true, choice: false, selects: 0 },
      withRingTwo: {
        says: false,
        choice: true,
        selects: 2,
        ringTwo: true,
        ringZero: false,
      },
    });
  });

  it("start the rollout the form's choices send, through the admin's entry, recorded as sent", async () => {
    const release = await importedRelease();
    // No earlier test's rollout stands in the way.
    await db
      .update(rollouts)
      .set({ status: "cancelled" })
      .where(inArray(rollouts.status, ["running", "waiting"]));
    const target = await recordClient(2);
    const choices: StartChoices = {
      what: "release",
      releaseId: release,
      scope: "client",
      ring: 3,
      clientId: target,
      pastFirstRing: true,
    };

    const result = await callServerFn(startRolloutFn, startRequestOf(choices));

    const rolloutId = result.done ?? "";
    const [started] = await db
      .select({ releaseId: rollouts.releaseId, kind: rollouts.kind })
      .from(rollouts)
      .where(eq(rollouts.id, rolloutId));
    const [event] = await db
      .select({ actor: auditEvents.actor, detail: auditEvents.detail })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "rollout.start"),
          eq(auditEvents.target, rolloutId)
        )
      );
    // Its run, started with it: then ended, as the test reads no more of it.
    const run = await adminWorkflow(env, adminWorkflows.rollout).get(rolloutId);
    const { status: runStatus } = await run.status();
    const runs = runStatus === undefined ? 0 : 1;
    await run.terminate();
    const targets = await db
      .select({ clientId: rolloutTargets.clientId, ring: rolloutTargets.ring })
      .from(rolloutTargets)
      .where(eq(rolloutTargets.rolloutId, rolloutId));
    expect({
      refused: result.refused,
      started,
      event: {
        actor: event?.actor,
        detail: z.unknown().parse(JSON.parse(event?.detail ?? "null")),
      },
      // Past ring 0, only the client named.
      pastRingZero: targets.filter(({ ring }) => ring !== 0),
      runs,
    }).toMatchObject({
      refused: null,
      started: { releaseId: release, kind: "release" },
      event: {
        actor: staff.email,
        detail: {
          kind: "release",
          release,
          scope: "client",
          client: target,
        },
      },
      pastRingZero: [{ clientId: target, ring: 2 }],
      runs: 1,
    });
  });

  it("show a rollout waiting for approval, its clients ring by ring, and what staff can do", async () => {
    const release = await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(release, reached, pending);

    const { status, html } = await page(`/platform/rollouts/${rolloutId}`);

    expect({
      status,
      waiting: html.includes("Alpha passed: waiting for approval"),
      approve: html.includes("Approve every other client"),
      cancel: html.includes("Cancel"),
      rings: html.includes("Alpha") && html.includes("Beta"),
      // Each named, opening its Setup in the admin.
      clients:
        html.includes(`href="/organizations/${reached}/setup"`) &&
        html.includes(`href="/organizations/${pending}/setup"`) &&
        html.includes(`Acme ${reached}`),
      // Only the client the rollout reached, and its ring, can be rolled back.
      rollBackClient: count(html, ">Roll back<"),
      rollBackRing: [
        html.includes("Roll back Alpha"),
        html.includes("Roll back Beta"),
      ],
      // Each client's cost, and their total, read once the page shows.
    }).toStrictEqual({
      status: 200,
      waiting: true,
      approve: true,
      cancel: true,
      rings: true,
      clients: true,
      rollBackClient: 1,
      rollBackRing: [true, false],
    });
  });

  it("offer a secrets rollout, and show one as secrets only in the list and on its page", async () => {
    await importedRelease();
    const reached = await recordClient(0);
    const pending = await recordClient(1);
    const rolloutId = await waitingRollout(null, reached, pending);

    const [list, own] = await Promise.all([
      page("/platform/rollouts"),
      page(`/platform/rollouts/${rolloutId}`),
    ]);

    expect({
      // The form's choice, and the listed rollout: the only secrets
      // rollout this file starts.
      shown: count(list.html, ">Secrets only<"),
      listed: list.html.includes(`href="/platform/rollouts/${rolloutId}"`),
      own: {
        says: own.html.includes(
          "Secrets only, on each client&#x27;s own release"
        ),
        approve: own.html.includes("Approve every other client"),
      },
    }).toStrictEqual({
      shown: 2,
      listed: true,
      own: { says: true, approve: true },
    });
  });

  it("answer 404 for a rollout that doesn't exist, or can't be one", async () => {
    const pages = await Promise.all([
      page(`/platform/rollouts/${crypto.randomUUID()}`),
      page("/platform/rollouts/not-a-rollout"),
    ]);

    expect(
      pages.map(({ status, html }) => ({
        status,
        says: html.includes("No such rollout"),
      }))
    ).toStrictEqual([
      { status: 404, says: true },
      { status: 404, says: true },
    ]);
  });
});
