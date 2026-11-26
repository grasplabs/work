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
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { auditLog } from "../src/audit-log.ts";
import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { logHead } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { coreOrigin, signedInWithRole } from "./sign-in.ts";

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
      runDays: summary.activity.runs.length,
      ran: summary.activity.runs.some(({ done, failed }) => done + failed > 0),
      live: [
        summary.activity.workflowsLive,
        summary.activity.appsLive,
        summary.activity.agentsOn,
      ],
      weeks: summary.activity.activePeople.length,
      lastWeek: summary.activity.activePeople.at(-1)?.week,
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

describe("weekly active people", () => {
  it("counts each person once a week, from what they did themselves, and a week without anyone as 0", async () => {
    // Wednesday noon, weeks back from this one.
    const today = Math.floor(Date.now() / dayMs);
    const monday = today - ((today + 3) % 7);
    const weeksBack = (weeks: number, day = 2) =>
      new Date((monday - 7 * weeks + day) * dayMs + 12 * 60 * 60 * 1000);
    const ada = { type: "person", userId: "user-ada" } as const;
    const ben = { type: "person", userId: "user-ben" } as const;
    await auditLog(env).append([
      // Three weeks back: Ada twice, on two days, and Ben once.
      eventAt(ada, weeksBack(3, 0)),
      eventAt(ada, weeksBack(3, 6)),
      eventAt(ben, weeksBack(3)),
      // Two weeks back: nobody, but staff, an agent of Ada's on its own,
      // and the platform.
      eventAt({ type: "staff", userId: "staff@grasp.test" }, weeksBack(2)),
      eventAt(
        { type: "agent", agentId: "stephen", onBehalfOf: "user-ada" },
        weeksBack(2)
      ),
      eventAt({ type: "system" }, weeksBack(2)),
      // Last week: Ben alone.
      eventAt(ben, weeksBack(1)),
      // Before the eight weeks: not counted.
      eventAt(ada, weeksBack(8)),
    ]);

    const response = await askAsAdmin();
    const summary = adminSummarySchema.parse(await response.json());

    // This week is left out: whoever this file signed in did something in it.
    expect(
      summary.activity.activePeople.slice(0, -1).map(({ people }) => people)
    ).toStrictEqual([0, 0, 0, 0, 2, 0, 1]);
    expect(summary.activity.activePeople[4]?.week).toBe(
      weeksBack(3, 0).toISOString().slice(0, 10)
    );
  });
});
