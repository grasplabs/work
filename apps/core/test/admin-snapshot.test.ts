import {
  adminSnapshotPath,
  adminSnapshotPurpose,
  adminSnapshotSchema,
} from "@grasp-os/shared/admin-snapshot";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { onboardingSummaryPurpose } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/index.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  coreOrigin,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
  withSignIn,
} from "./sign-in.ts";

// Grasp's admin's read of a client (src/admin-snapshot.ts): only Grasp's
// staff, through the console, read it, and what they read has no word
// anyone said in it. The ways it can fail, tried first:
//
// - Anyone but the console reading it: unsigned, signed with a made-up
//   signature, with the console's key for another client or for another
//   purpose, sent long ago, too large, malformed, or not through the
//   router.
// - Someone who holds a credential of this client but not the console's
//   key: a member's session, the company's admin's, a Grasp staff
//   session, or an interview link.
// - A read the company can't see in its audit log, or one served when the
//   log can't take it.
// - What someone said in their interview reaching the console.
// - Grasp reading on after the company's admin ended its staff access.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Periwinkle abacus under the harbour bridge";

/** The Grasp staff member the console says is asking. */
const staffEmail = "ada.lovelace@grasp.test";

/** `body`'s signature as the console makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = adminSnapshotPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

const bodyAt = (sentAt = new Date().toISOString(), email = staffEmail) =>
  JSON.stringify({ sentAt, staff: { email } });

/** Asks core for the snapshot through the router, with `headers` as given. */
const ask = async (
  body: string,
  {
    signature = null,
    cookie = null,
    method = "POST",
    coreEnv = env,
  }: {
    signature?: string | null;
    cookie?: string | null;
    method?: string;
    coreEnv?: Env;
  } = {}
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  return await routed(
    adminSnapshotPath,
    { method, headers, ...(method === "POST" ? { body } : {}) },
    coreEnv
  );
};

/** Asks as the console does: signed, now, for `staffEmail`. */
const askAsConsole = async (coreEnv: Env = env): Promise<Response> => {
  const body = bodyAt();
  return await ask(body, { signature: await signatureOf(body), coreEnv });
};

/** What the lead said: their words, and facts Stephen wrote from them. */
const progress = (): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What does your team do all week?" },
    { from: "person", text: sentinel, typed: true },
  ],
  facts: [
    { id: "f1", tag: "step", text: sentinel, record: sentinel },
    { id: "f2", tag: "wait", text: `${sentinel}, twice`, record: "x" },
    {
      id: "f3",
      tag: "system",
      text: "Their own sheet",
      record: "y",
      out: true,
    },
  ],
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 1,
  adding: false,
  addedAt: 0,
  rating: 4,
});

/**
 * An onboarding running since yesterday: Sales, led by Lea, whose link is
 * out and who is talking now; Sam, whose link waits for her. Some AI used.
 */
const running = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = { lea: `lea-${id}`, sam: `sam-${id}` };
  const roster: Roster = {
    teams: [
      { id: "sales", name: "Sales", lead: ids.lea, does: "", off: false },
    ],
    people: [
      {
        id: ids.lea,
        name: "Lea Lund",
        email: "lea@acme.test",
        team: "sales",
        title: "Head of Sales",
        away: false,
      },
      {
        id: ids.sam,
        name: "Sam Berg",
        email: "",
        team: "sales",
        title: "",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await store.savePlan(
    { start: yesterday.toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = (await store.linkOf(ids.lea)) ?? "";
  const secret = link.split("#")[1] ?? "";
  const mark = await sha256Hex(secret);
  const key = await sha256Hex("lea's device");
  await store.openLink(mark, null, key);
  await store.saveInterview(mark, key, 0, progress());
  await store.meter({
    purpose: "interviews",
    model: `claude-opus-${id}`,
    tokensIn: 1200,
    tokensCached: 300,
    tokensOut: 400,
  });
  // A model of its own, as the store's usage adds up over this file's tests.
  return { ids, secret, model: `claude-opus-${id}` };
};

/** An audit log that takes nothing: every call to it fails. */
const failingAuditLog = (): Env["AUDIT_LOG"] =>
  new Proxy(env.AUDIT_LOG, {
    get: (namespace, name): unknown => {
      if (name !== "getByName" && name !== "get") {
        return Reflect.get(namespace, name, namespace);
      }
      return () =>
        new Proxy(
          {},
          {
            get: () => async () =>
              await Promise.reject(new Error("Unavailable")),
          }
        );
    },
  });

/** The snapshot reads `events` recorded. */
const snapshotReads = <T extends { action: string }>(events: T[]): T[] =>
  events.filter(({ action }) => action === "admin.snapshot.read");

describe("who reads the admin snapshot", () => {
  it("refuses anyone but the console: unsigned, signed otherwise, sent long ago, too large, malformed, or no request at all", async () => {
    await running();
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const large = JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
      pad: "x".repeat(2048),
    });
    const noStaff = JSON.stringify({ sentAt: new Date().toISOString() });
    const notEmail = bodyAt(undefined, "not an email");
    const statuses: number[] = [];
    const events = await auditedDuring(async () => {
      const responses = await Promise.all([
        ask(fresh),
        ask(fresh, { signature: "0".repeat(64) }),
        ask(fresh, { signature: "not hex" }),
        // The console's key for another client: another auth secret.
        ask(fresh, {
          signature: await signatureOf(fresh, "another-client-auth-secret"),
        }),
        // The console's key for the onboarding summary signs nothing here.
        ask(fresh, {
          signature: await signatureOf(
            fresh,
            env.BETTER_AUTH_SECRET,
            onboardingSummaryPurpose
          ),
        }),
        ask(old, { signature: await signatureOf(old) }),
        ask(large, { signature: await signatureOf(large) }),
        ask(noStaff, { signature: await signatureOf(noStaff) }),
        ask(notEmail, { signature: await signatureOf(notEmail) }),
        ask(fresh, { signature: await signatureOf(fresh), method: "GET" }),
      ]);
      statuses.push(...responses.map(({ status }) => status));
      await Promise.all(responses.map(async (each) => await each.text()));
    });
    expect({ statuses, reads: snapshotReads(events) }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 403, 403, 403, 403, 404],
      reads: [],
    });
  });

  it("refuses the console's own signed request when it didn't come through the router", async () => {
    const body = bodyAt();
    const response = await worker.fetch(
      new Request(`${coreOrigin}${adminSnapshotPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [platformUpdateSignatureHeader]: await signatureOf(body),
        },
        body,
      }),
      env,
      createExecutionContext()
    );
    const text = await response.text();
    expect({
      status: response.status,
      named: text.includes("Lea"),
    }).toStrictEqual({
      status: 403,
      named: false,
    });
  });

  it("gives a member, the company's admin, a Grasp staff session and an interview link nothing", async () => {
    const { secret } = await running();
    const member = await signedInWithRole(idp, "user");
    const admin = await signedInWithRole(idp, "admin");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const fresh = bodyAt();
    const withLink = JSON.stringify({
      sentAt: new Date().toISOString(),
      staff: { email: staffEmail },
      secret,
    });
    const responses: Response[] = [];
    const events = await auditedDuring(async () => {
      responses.push(
        ...(await Promise.all([
          ask(fresh, { cookie: member.session }),
          ask(fresh, { cookie: admin.session }),
          ask(fresh, { cookie: staff }),
          // The link's secret, as the body and as a signature would carry it.
          ask(withLink),
          ask(withLink, { signature: await sha256Hex(secret) }),
          ask(JSON.stringify({ action: "session", secret })),
        ]))
      );
    });
    const texts = await Promise.all(
      responses.map(async (each) => await each.text())
    );
    expect({
      statuses: responses.map(({ status }) => status),
      named: texts.some((text) => text.includes("Lea Lund")),
      reads: snapshotReads(events),
    }).toStrictEqual({
      statuses: [401, 401, 401, 401, 401, 401],
      named: false,
      reads: [],
    });
  });
});

describe("the admin snapshot once the company ended Grasp's staff access", () => {
  afterEach(async () => {
    await env.DB.prepare(
      "UPDATE onboarding_gate SET staff_ended_at = NULL"
    ).run();
  });

  it("is refused, and read again only through a staff window the console opens afterwards", async () => {
    await running();
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboardingGate.endStaffAccess();

    const responses: Response[] = [];
    const events = await auditedDuring(async () => {
      responses.push(await askAsConsole());
    });
    const [refused] = responses;
    const text = (await refused?.text()) ?? "";
    // A window the console opens a moment after the company said stop:
    // after the end, and not in the future.
    await scheduler.wait(5);
    const later = withSignIn({
      staff: { ...signInConfig.staff, opened: new Date().toISOString() },
    });
    const reopened = await askAsConsole(later);
    await reopened.text();

    expect({
      status: refused?.status,
      named: text.includes("Lea"),
      reads: snapshotReads(events),
      reopened: reopened.status,
    }).toStrictEqual({ status: 403, named: false, reads: [], reopened: 200 });
  });

  it("stays refused with no staff window at all, or one opened the moment it ended", async () => {
    await running();
    const { api: admin } = await signedInApi(idp, "admin");
    await admin.onboardingGate.endStaffAccess();
    const ended = await env.DB.prepare(
      "SELECT staff_ended_at AS ended FROM onboarding_gate"
    ).first<{ ended: number }>();
    const noWindow = withSignIn({ staff: undefined });
    const atTheEnd = withSignIn({
      staff: {
        ...signInConfig.staff,
        opened: new Date(ended?.ended ?? 0).toISOString(),
      },
    });

    const responses = await Promise.all([
      askAsConsole(noWindow),
      askAsConsole(atTheEnd),
    ]);
    await Promise.all(responses.map(async (each) => await each.text()));

    expect({
      ended: typeof ended?.ended,
      statuses: responses.map(({ status }) => status),
    }).toStrictEqual({ ended: "number", statuses: [403, 403] });
  });
});

describe("the admin snapshot", () => {
  it("gives the console the company, its people, where each link stands and every interview in numbers, with nothing anyone said", async () => {
    const { ids, model } = await running();
    const { userId } = await signedInWithRole(idp, "admin");

    const response = await askAsConsole();
    const text = await response.text();
    const snapshot = adminSnapshotSchema.parse(JSON.parse(text));

    const today = new Date().toISOString().slice(0, 10);
    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      people: snapshot.roster?.people.map(({ id, name }) => [id, name]),
      links: snapshot.links.map(({ person, state }) => [person, state]),
      interviews: snapshot.interviews
        .filter(({ person }) => person === ids.lea)
        .map(({ startedAt, updatedAt, ...rest }) => ({
          ...rest,
          started: startedAt !== null,
          updated: updatedAt.slice(0, 10),
        })),
      agreed: snapshot.agreed,
      member: snapshot.members.some((one) => one.userId === userId),
      usage: snapshot.usage.find(({ day }) => day === today)?.use.interviews?.[
        model
      ],
      unknown: [
        snapshot.contacts,
        snapshot.works,
        snapshot.contract,
        snapshot.integrations,
      ],
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      people: [
        [ids.lea, "Lea Lund"],
        [ids.sam, "Sam Berg"],
      ],
      // Sam's link waits for Lea, who is talking now.
      links: [
        [ids.lea, "progress"],
        [ids.sam, "waiting"],
      ],
      interviews: [
        {
          person: ids.lea,
          kind: "lead",
          completedAt: null,
          agreed: false,
          phase: "steps",
          stoppedAt: "steps",
          minutes: 0,
          facts: 2,
          out: 1,
          confirmed: 1,
          rating: 4,
          typed: true,
          interviewer: null,
          started: true,
          updated: today,
        },
      ],
      agreed: true,
      member: true,
      usage: {
        calls: 1,
        tokensIn: 1200,
        kept: 300,
        tokensOut: 400,
        seconds: 0,
      },
      unknown: [null, null, null, null],
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("Their own sheet");
    expect(text).not.toContain("What does your team do all week?");
  });

  it("counts every interview of a large roster, page after page", async () => {
    const store = onboardingStore(env);
    const id = unique();
    // More leads than one page of interviews holds, each talking now.
    const leads = Array.from({ length: 110 }, (_, at) => `lead-${at}-${id}`);
    const roster: Roster = {
      teams: leads.map((lead, at) => ({
        id: `team-${at}`,
        name: `Team ${at}`,
        lead,
        does: "",
        off: false,
      })),
      people: leads.map((lead, at) => ({
        id: lead,
        name: `Lead ${at}`,
        email: "",
        team: `team-${at}`,
        title: "",
        away: false,
      })),
    };
    const by = { type: "system" } as const;
    await store.setPaused(false, by);
    await store.saveRoster(roster, by);
    await store.savePlan(
      { start: new Date().toISOString().slice(0, 10), days: 14 },
      by
    );
    await store.releaseDue();
    await Promise.all(
      leads.map(async (lead) => {
        const secret = ((await store.linkOf(lead)) ?? "").split("#")[1] ?? "";
        const mark = await sha256Hex(secret);
        const key = await sha256Hex(`${lead}'s device`);
        await store.openLink(mark, null, key);
        await store.saveInterview(mark, key, 0, progress());
      })
    );

    const response = await askAsConsole();
    const snapshot = adminSnapshotSchema.parse(await response.json());

    const counted = snapshot.interviews.filter(({ person }) =>
      leads.includes(person)
    );
    expect({
      interviews: counted.length,
      facts: [...new Set(counted.map(({ facts }) => facts))],
    }).toStrictEqual({ interviews: 110, facts: [2] });
  });

  it("puts every read in the company's audit log, by the staff member the console names", async () => {
    await running();

    const events = await auditedDuring(async () => {
      const response = await askAsConsole();
      await response.text();
    });

    expect(
      snapshotReads(events).map(({ actor, target }) => ({ actor, target }))
    ).toStrictEqual([
      {
        actor: { type: "staff", userId: staffEmail, via: "console" },
        target: { type: "organization", id: "organization" },
      },
    ]);
  });

  it("answers nothing when the audit log can't take the read", async () => {
    await running();

    // The failed request is logged as an error: that's what it is.
    const logged = vi.spyOn(console, "error").mockReturnValue();
    const response = await askAsConsole({
      ...env,
      AUDIT_LOG: failingAuditLog(),
    });
    const text = await response.text();
    const errors = JSON.stringify(logged.mock.calls, (_key, value: unknown) =>
      value instanceof Error ? value.message : value
    );
    logged.mockRestore();

    expect({
      status: response.status,
      named: text.includes("Lea"),
      // It failed for the audit log, and nothing else.
      audit: errors.includes("Unavailable"),
    }).toStrictEqual({
      status: 500,
      named: false,
      audit: true,
    });
  });

  it("says when the kickoff came in and how much of it is known, and nothing it said", async () => {
    await running();
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    const saved = await store.saveKickoff(
      {
        transcript: `${sentinel}. We sell boats.`,
        fileName: `${sentinel}.vtt`,
        reading: {
          fields: {
            business: { text: sentinel, quote: sentinel },
            goals: { text: "Fewer handovers", quote: sentinel },
          },
          ask: { pain: `${sentinel}?` },
          teams: [{ name: sentinel, does: sentinel }],
        },
      },
      by
    );
    await store.answerKickoff("pain", sentinel, by);

    const response = await askAsConsole();
    const text = await response.text();
    const snapshot = adminSnapshotSchema.parse(JSON.parse(text));

    expect({
      status: response.status,
      kickoff: snapshot.kickoff,
    }).toStrictEqual({
      status: 200,
      // Business and goals from the reading, pain from the answer: 3 of 10.
      kickoff: { at: saved.transcript?.at, known: 0.3 },
    });
    expect(text).not.toContain(sentinel);
  });
});
