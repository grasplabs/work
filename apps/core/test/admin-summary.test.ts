import {
  adminSummaryMaxBytes,
  adminSummaryPath,
  adminSummaryPurpose,
  adminSummarySchema,
} from "@grasp-os/shared/admin-summary";
import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import { onboardingSummaryPurpose } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { auditLog } from "../src/audit-log.ts";
import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { published } from "./apps.ts";
import { logHead } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { seedResourceRun } from "./runs.ts";
import { coreOrigin, signedInApi, signedInWithRole } from "./sign-in.ts";

// Grasp's admin's summary of a client (src/admin-summary.ts): only the
// admin reads it, and what it reads is counts and dates. The ways it can
// fail, tried first:
//
// - Anyone but the admin reading it: unsigned; signed with another
//   client's key, or with this client's key for another purpose (the
//   onboarding summary's); sent long ago or far ahead; a body over the
//   bound; not a POST; not through the router.
// - A person reaching the admin: a member's name or email, or a name on
//   the roster.
// - A read in the company's audit log, when nobody's data is read.
// - Weekly active people counting a person twice in a week, or counting
//   staff, agents or the platform as people.

const idp = mockIdp();

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Ottoline Brackenbury";

const dayMs = 24 * 60 * 60 * 1000;

/** `body`'s signature as the admin makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminSummaryPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Sends `body` to `path` as the router would, with what's given. */
const send = async ({
  body,
  signature = null,
  method = "POST",
  routerSecret = env.ROUTER_SECRET,
  path = adminSummaryPath,
}: {
  body: string;
  signature?: string | null;
  method?: string;
  routerSecret?: string | null;
  path?: string;
}): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (routerSecret !== null) {
    headers.set(routerSecretHeader, routerSecret);
  }
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${coreOrigin}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body } : {}),
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

/** Asks as the admin does: signed, now. */
const askAsAdmin = async (): Promise<Response> => {
  const body = bodyAt();
  return await send({ body, signature: await signatureOf(body) });
};

describe("the admin summary", () => {
  it("answers the admin's signed request with counts and dates, naming nobody, and leaves no audit entry", async () => {
    await onboardingStore(env).saveRoster(
      {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: sentinel,
            email: "ottoline@acme.test",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
      { type: "system" }
    );
    const members = await Promise.all([
      signedInWithRole(idp, "admin"),
      signedInWithRole(idp, "user"),
    ]);
    const before = await logHead();

    const response = await askAsAdmin();
    const text = await response.text();
    const summary = adminSummarySchema.parse(JSON.parse(text));

    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      onboarding: summary.onboarding,
      needs: summary.needs,
      connectors: summary.connectors,
      asked: summary.asked,
      runDays: summary.activity?.runs.length,
      ran: summary.activity?.runs.some(({ done, failed }) => done + failed > 0),
      live: [
        summary.activity?.workflowsLive,
        summary.activity?.appsLive,
        summary.activity?.agentsOn,
      ],
      weeks: summary.activity?.activePeople.length,
      lastWeek: summary.activity?.activePeople.at(-1)?.week,
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      // On the roster, the gate never closed: the company is in.
      onboarding: {
        stage: "open",
        day: null,
        days: null,
        known: 25,
        threshold: 80,
        told: false,
        paused: false,
        ready: false,
        open: true,
        openedAt: null,
      },
      // As the admin's own view of the snapshot says, by kind, the most
      // pressing first: the first conversation isn't in, nor are the two
      // agreements.
      needs: [
        { kind: "transcript", count: 1 },
        { kind: "agreement", count: 2 },
      ],
      connectors: { works: 0, again: 0, stopped: 0 },
      asked: 0,
      runDays: 30,
      ran: false,
      live: [0, 0, 0],
      weeks: 8,
      // This week's Monday.
      lastWeek: new Date(
        Date.now() - ((new Date().getUTCDay() + 6) % 7) * dayMs
      )
        .toISOString()
        .slice(0, 10),
    });
    for (const said of [
      sentinel,
      "ottoline@acme.test",
      "Sales",
      ...members.flatMap(({ person }) => [
        String(person.name),
        String(person.email),
      ]),
      ...members.map(({ userId }) => userId),
    ]) {
      expect(text).not.toContain(said);
    }
    await expect(logHead()).resolves.toBe(before);
  });

  it("refuses anyone but the admin: unsigned, signed otherwise, sent long ago or ahead, too large, not a POST, or not through the router", async () => {
    const fresh = bodyAt();
    const signature = await signatureOf(fresh);
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const ahead = bodyAt(new Date(Date.now() + 10 * 60 * 1000).toISOString());
    // Signed as it should be, but over the bound.
    const large = JSON.stringify({
      sentAt: new Date().toISOString(),
      pad: "x".repeat(adminSummaryMaxBytes),
    });
    const refused = await Promise.all([
      send({ body: fresh }),
      send({
        body: fresh,
        signature: await signatureOf(fresh, "another-clients-secret"),
      }),
      // The onboarding summary's key signs nothing here.
      send({
        body: fresh,
        signature: await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          onboardingSummaryPurpose
        ),
      }),
      send({ body: old, signature: await signatureOf(old) }),
      send({ body: ahead, signature: await signatureOf(ahead) }),
      send({ body: large, signature: await signatureOf(large) }),
      send({ body: "{}", signature: await signatureOf("{}") }),
      send({ body: fresh, signature, method: "GET" }),
    ]);
    // Without the router secret it is refused as any path is.
    const unrouted = await Promise.all([
      send({ body: fresh, signature, routerSecret: null }),
      send({ body: fresh, signature, routerSecret: null, path: "/nothing" }),
    ]);

    expect({
      refused: refused.map(({ status }) => status),
      unrouted: unrouted.map(({ status }) => status),
    }).toStrictEqual({
      refused: [403, 403, 403, 403, 403, 403, 403, 404],
      unrouted: [403, 403],
    });
  });
});

/** An event of `actor`'s at `at`, as the log holds one. */
const eventAt = (actor: AuditActor, at: Date) =>
  auditEventSchema.parse({
    id: crypto.randomUUID(),
    at: at.toISOString(),
    source: "core",
    actor,
    action: "chat.created",
  });

/** Wednesday noon `weeks` weeks before this one, or another day of that week. */
const weeksBack = (weeks: number, day = 2): Date => {
  const today = Math.floor(Date.now() / dayMs);
  const monday = today - ((today + 3) % 7);
  return new Date((monday - 7 * weeks + day) * dayMs + 12 * 60 * 60 * 1000);
};

/** A person actor. */
const person = (userId: string) => ({ type: "person", userId }) as const;

/** The summary's weekly counts, oldest first, this week left out. */
const pastWeeks = async () => {
  const response = await askAsAdmin();
  const { activity } = adminSummarySchema.parse(await response.json());
  return (activity?.activePeople ?? [])
    .slice(0, -1)
    .map(({ people }) => people);
};

/** The weeks `active_weeks` holds, as the log keeps them. */
const weeksKept = async (): Promise<string[]> =>
  await runInDurableObject(auditLog(env), (_instance, state) =>
    state.storage.sql
      .exec<{ week: string }>(
        "SELECT DISTINCT week FROM active_weeks ORDER BY week"
      )
      .toArray()
      .map(({ week }) => week)
  );

describe("weekly active people", () => {
  it("counts each person once a week, from what they did themselves: 0 exactly, 1 to 4 as a band, 5 and more exactly", async () => {
    const five = ["a", "b", "c", "d", "e"].map((name) =>
      person(`user-${name}`)
    );
    const [a, b] = five;
    if (a === undefined || b === undefined) {
      throw new Error("Five people");
    }
    await auditLog(env).append([
      // Six weeks back: five people, one of them twice: 5.
      ...five.map((actor) => eventAt(actor, weeksBack(6))),
      eventAt(a, weeksBack(6, 5)),
      // Five weeks back: four people, one twice, on two days: still 4.
      ...five.slice(0, 4).map((actor) => eventAt(actor, weeksBack(5))),
      eventAt(b, weeksBack(5, 6)),
      // Four weeks back: one person.
      eventAt(a, weeksBack(4)),
      // Three weeks back: nobody, but staff, an agent of A's on its own,
      // and the platform.
      eventAt({ type: "staff", userId: "staff@grasp.test" }, weeksBack(3)),
      eventAt(
        { type: "agent", agentId: "stephen", onBehalfOf: "user-a" },
        weeksBack(3)
      ),
      eventAt({ type: "system" }, weeksBack(3)),
      // Before the eight weeks: not counted.
      eventAt(a, weeksBack(8)),
    ]);

    // This week is left out: whoever this file signed in did something in it.
    await expect(pastWeeks()).resolves.toStrictEqual([
      0,
      5,
      "1–4",
      "1–4",
      0,
      0,
      0,
    ]);
  });

  it("forgets the weeks of a person who is erased, so the weeks count without them", async () => {
    const admin = await signedInApi(idp, "admin");
    const gone = await signedInApi(idp, "builder");
    // Two weeks back: the person, and four others.
    await auditLog(env).append([
      eventAt(person(gone.userId), weeksBack(2)),
      ...["f", "g", "h", "i"].map((name) =>
        eventAt(person(`user-${name}`), weeksBack(2))
      ),
    ]);
    const before = await pastWeeks();
    await admin.api.members.remove(gone.userId);
    await admin.api.members.erase(gone.userId, String(gone.person.name));

    const after = await pastWeeks();

    expect({ before: before[5], after: after[5] }).toStrictEqual({
      before: 5,
      after: "1–4",
    });
  });

  it("keeps who was active no longer than the summary's weeks and one more, whatever else the log's retention does", async () => {
    await auditLog(env).append([
      eventAt(person("user-j"), weeksBack(9)),
      eventAt(person("user-j"), weeksBack(10)),
    ]);
    const before = await weeksKept();
    await runDurableObjectAlarm(auditLog(env));
    const after = await weeksKept();
    const monday = (weeks: number) =>
      weeksBack(weeks, 0).toISOString().slice(0, 10);

    expect({
      before: [9, 10, 8].map((weeks) => before.includes(monday(weeks))),
      after: [9, 10, 8].map((weeks) => after.includes(monday(weeks))),
    }).toStrictEqual({
      before: [true, true, true],
      // Eight weeks back is the ninth kept, this one counted.
      after: [false, false, true],
    });
  });
});

describe("the admin summary once the company ended Grasp's staff access", () => {
  it("sends only what running the service needs: how the company uses Grasp is left out", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const read = async () => {
      const response = await askAsAdmin();
      return adminSummarySchema.parse(await response.json());
    };
    const shared = await read();
    await admin.onboardingGate.endStaffAccess();
    const ended = await read();
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();

    expect({
      shared: [shared.activity === null, shared.asked],
      ended: {
        activity: ended.activity,
        asked: ended.asked,
        kept: [ended.onboarding.stage, ended.connectors !== null, ended.needs],
      },
    }).toStrictEqual({
      shared: [false, 0],
      ended: {
        activity: null,
        asked: null,
        kept: [shared.onboarding.stage, true, shared.needs],
      },
    });
  });
});

/** The start of the UTC day `ago` days before today, in milliseconds. */
const dayStart = (ago: number): number =>
  (Math.floor(Date.now() / dayMs) - ago) * dayMs;

/** An agent of the company's, `state` as given. */
const seedAgent = async (state: "on" | "paused" | "deleted"): Promise<void> => {
  const id = `agent-${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO agents (id, name, name_key, face, job, state, made_by, made_at, changed_by, changed_at) VALUES (?, ?, ?, 'f', 'j', ?, 'user-ada', ?, 'user-ada', ?)"
  )
    .bind(id, id, id, state, Date.now(), Date.now())
    .run();
};

describe("what runs in the company", () => {
  it("counts every person's workflow runs by the day they started, and only what is live: workflows published and not paused, Apps live, agents on", async () => {
    const [ada, ben] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
    ]);
    // Apps: one live, one never published, one archived, one removed.
    const app = async (name: string) => {
      const { id } = await ada.api.apps.create({ name });
      return id;
    };
    const [live, archived, removed] = [
      await app("Live"),
      await app("Archived"),
      await app("Removed"),
    ];
    await app("Draft");
    await published(live);
    await published(archived);
    await published(removed);
    await ada.api.apps.archive(archived);
    await ada.api.apps.archive(removed);
    await ada.api.apps.remove(removed);
    // Each person's own workflow: neither sees the other's runs, the summary counts both.
    // One more of Ada's never published: it has no current version.
    const [adas, bens, paused, deleted] = await Promise.all([
      ada.api.workflowResources.create(`intake-${crypto.randomUUID()}`),
      ben.api.workflowResources.create(`billing-${crypto.randomUUID()}`),
      ada.api.workflowResources.create(`paused-${crypto.randomUUID()}`),
      ada.api.workflowResources.create(`gone-${crypto.randomUUID()}`),
      ada.api.workflowResources.create(`draft-${crypto.randomUUID()}`),
    ]);
    // Published: Ada's and Ben's; the paused one, paused; the deleted one, deleted.
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE workflow_resources SET current_version = 1 WHERE id IN (?, ?, ?, ?)`
      ).bind(adas.id, bens.id, paused.id, deleted.id),
      env.DB.prepare(
        "UPDATE workflow_resources SET deleted_at = ? WHERE id = ?"
      ).bind(Date.now(), deleted.id),
      env.DB.prepare(
        "INSERT INTO workflow_resource_lifecycles (workflow_resource_id, revision, paused_by, paused_at, updated_at) VALUES (?, 1, ?, ?, ?)"
      ).bind(paused.id, ada.userId, Date.now(), Date.now()),
    ]);
    await Promise.all([
      // Today: Ada's done twice, Ben's failed once, and one of Ada's still running.
      seedResourceRun({
        workflow: adas.id,
        principal: ada.userId,
        status: "completed",
        createdAt: dayStart(0),
      }),
      seedResourceRun({
        workflow: adas.id,
        principal: ada.userId,
        status: "completed",
        createdAt: dayStart(0),
      }),
      seedResourceRun({
        workflow: bens.id,
        principal: ben.userId,
        status: "failed",
        createdAt: dayStart(0),
      }),
      seedResourceRun({
        workflow: adas.id,
        principal: ada.userId,
        status: "running",
        createdAt: dayStart(0),
      }),
      // Three days ago: Ben's done once, Ada's failed once.
      seedResourceRun({
        workflow: bens.id,
        principal: ben.userId,
        status: "completed",
        createdAt: dayStart(3),
      }),
      seedResourceRun({
        workflow: paused.id,
        principal: ada.userId,
        status: "failed",
        createdAt: dayStart(3),
      }),
      // Before the 30 days.
      seedResourceRun({
        workflow: bens.id,
        principal: ben.userId,
        status: "completed",
        createdAt: dayStart(30),
      }),
      seedAgent("on"),
      seedAgent("paused"),
      seedAgent("deleted"),
    ]);

    const response = await askAsAdmin();
    const { activity } = adminSummarySchema.parse(await response.json());
    if (activity === null) {
      throw new Error("Its activity is shared");
    }
    const ran = activity.runs.filter(({ done, failed }) => done + failed > 0);

    expect({
      days: activity.runs.length,
      ran,
      live: [activity.workflowsLive, activity.appsLive, activity.agentsOn],
    }).toStrictEqual({
      days: 30,
      ran: [
        {
          day: new Date(dayStart(3)).toISOString().slice(0, 10),
          done: 1,
          failed: 1,
        },
        {
          day: new Date(dayStart(0)).toISOString().slice(0, 10),
          done: 2,
          failed: 1,
        },
      ],
      // Ada's and Ben's workflows; one App; one agent.
      live: [2, 1, 1],
    });
  });
});
