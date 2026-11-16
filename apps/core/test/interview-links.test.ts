import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type {
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import {
  factRevision,
  interviewApiPath,
  participationNotice,
} from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { adminCommands } from "./admin-command.ts";
import { mockIdp } from "./idp.ts";
import { signedInAs } from "./interview-link.ts";
import {
  auditedDuring,
  routed,
  signedIn,
  staffPerson,
  unique,
  whoami,
} from "./sign-in.ts";

// Everyone's own interview link (src/onboarding/links.ts): it opens one
// person's interview, for the account signed in with the company's
// sign-in whose address it was sent to, while the interviews run, and
// nothing else. The link cases of the threat model (GRA-307, GRA-1790),
// each tried here:
//
// - L1: a made-up or malformed link opens nothing; no secret or session is
//   kept as it is.
// - L2: the secret is in no answer or log, and no answer gives a referrer.
// - L3: anyone else with the link, signed in or not, the admin among them,
//   gets nothing that was said, can neither save nor delete, and learns
//   nothing a link that never was wouldn't tell them; the interview
//   belongs to its account from the first opening, so a list edited
//   afterwards, a resend to another address or a forwarded link opened
//   first changes nothing; a link with no address, or one shared by two on
//   the list, opens for nobody; staff and another site drive nothing.
// - L4: two tabs on the device never lose a save.
// - L5, L8: nothing opens before the link went out, before the agreements,
//   or while the interviews are paused.
// - L6: after the last day nothing more is taken; deleting still works.
// - L7, L10: someone taken off the list has a link like one that never
//   was, and what they said is gone.
// - L9: a lost device costs nothing: they sign in on another one; staff
//   give a new start, after which the link's address opens it again.
// - L11: the store counts calls per link.
// - P3: a save with anything but an interview in it is refused.
// - D3: a copy left open can't save a deleted interview back.
// - W7, and the company not learning who talked: the audit log gets
//   nothing of what anyone did on their link.
//
// And the link's side of read-back approval (GRA-329):
//
// - T1: taking part is kept with the notice it was for, its purpose and
//   audience; an older notice is refused.
// - T4: anyone else signed in with the link, the admin too, can't take
//   part, approve or withdraw for them.
// - T5: withdrawing works whenever deleting does, and nobody takes part
//   again after it: not after a delete, nor a new start from staff.
// - T6: after the last day nothing is approved any more.
// - T7: taking part and withdrawing asked again answer as the first time.

const idp = mockIdp();

/** Words nobody else uses, to look for where they must not be. */
const sentinel = "Quillfeather ledger seventeen";

const dayMs = 24 * 60 * 60 * 1000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Where someone's interview is, with what they said. */
const progress = (text = sentinel): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What did you do this morning?" },
    { from: "person", text, typed: true },
  ],
  facts: [{ id: "f1", tag: "step", text, record: text }],
  phase: "story",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
});

/** Everyone's address on the list: their id, at the company's domain. */
const emailOf = (person: string): string => `${person}@acme.test`;

/**
 * A fresh onboarding in the deployment's one store, running since
 * yesterday: Sales led by its lead, with one more; Ops, without a lead,
 * with two. Every link due is out: the lead's and Ops's, not the other
 * Sales person's. Returns everyone's ids and secrets.
 */
const running = async () => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    lead: `lead-${id}`,
    member: `member-${id}`,
    oli: `oli-${id}`,
    ona: `ona-${id}`,
  };
  const roster: Roster = {
    teams: [
      { id: "sales", name: "Sales", lead: ids.lead, does: "", off: false },
      { id: "ops", name: "Ops", lead: null, does: "", off: false },
    ],
    people: [
      { id: ids.lead, name: "Lea Lund", team: "sales" },
      { id: ids.member, name: "Sam Berg", team: "sales" },
      { id: ids.oli, name: "Oli Olsen", team: "ops" },
      { id: ids.ona, name: "Ona Ek", team: "ops" },
    ].map((person) => ({
      ...person,
      email: emailOf(person.id),
      title: "",
      away: false,
    })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const secretOf = async (person: string): Promise<string> => {
    const link = await store.linkOf(person);
    return link?.split("#")[1] ?? "";
  };
  return {
    store,
    ids,
    roster,
    secrets: {
      lead: await secretOf(ids.lead),
      member: await secretOf(ids.member),
      oli: await secretOf(ids.oli),
    },
    // Oli, signed in with the company's sign-in as the address their link
    // went to: what most of these tests open it as.
    me: await signedInAs(emailOf(ids.oli)),
  };
};

/** One of the link's calls, as the page makes it, with `cookie` as its session. */
const post = async (
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {},
  coreEnv: Env = env
): Promise<Response> =>
  await routed(
    interviewApiPath,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        cookie,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    coreEnv
  );

/**
 * Core's bindings, with every call to the onboarding's object and to the
 * Brain's stores noted, by binding and method, in `calls`.
 */
const watchedEnv = (): { env: Env; calls: string[] } => {
  const calls: string[] = [];
  const stubOf = (binding: string, stub: object): object =>
    new Proxy(stub, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        return (...given: unknown[]): unknown => {
          calls.push(`${binding}.${String(name)}`);
          return Reflect.apply(member, target, given);
        };
      },
    });
  const namespaceOf = <T extends object>(binding: string, namespace: T): T =>
    new Proxy(namespace, {
      get: (target, name): unknown => {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== "function") {
          return member;
        }
        return (...given: unknown[]): unknown => {
          const made: unknown = Reflect.apply(member, target, given);
          if (typeof made !== "object" || made === null) {
            return made;
          }
          if (name === "jurisdiction") {
            return namespaceOf(binding, made);
          }
          return name === "get" || name === "getByName"
            ? stubOf(binding, made)
            : made;
        };
      },
    });
  return {
    env: {
      ...env,
      ONBOARDING: namespaceOf("onboarding", env.ONBOARDING),
      BRAIN_STORE: namespaceOf("brain", env.BRAIN_STORE),
    },
    calls,
  };
};

/** A refusal's code, or the answer when it wasn't one. */
const codeOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  const parsed = errorPayloadSchema.safeParse(body);
  return parsed.success ? parsed.data.code : JSON.stringify(body);
};

/** A session, as the endpoint answers it. */
const sessionOf = async (response: Response): Promise<InterviewSession> =>
  await response.json<InterviewSession>();

/** A save's answer, as the endpoint gives it. */
const savedOf = async (response: Response): Promise<InterviewSaved> =>
  await response.json<InterviewSaved>();

const session = async (secret: string, cookie: string) =>
  await post({ action: "session", secret }, cookie);

/** Opens a link as whoever `cookie` signs in: what it opened. */
const opened = async (
  secret: string,
  cookie: string
): Promise<InterviewSession> => await sessionOf(await session(secret, cookie));

const save = async (
  secret: string,
  cookie: string,
  version: number,
  sent: unknown = progress()
) => await post({ action: "save", secret, version, progress: sent }, cookie);

const remove = async (secret: string, cookie: string) =>
  await post({ action: "delete", secret }, cookie);

const takePart = async (
  secret: string,
  cookie: string,
  notice: number = participationNotice.version
) => await post({ action: "participate", secret, notice }, cookie);

const withdraw = async (secret: string, cookie: string) =>
  await post({ action: "withdraw", secret }, cookie);

/** An approval of the fact `progress()` writes down, as it stands. */
const approveFact = async (secret: string, cookie: string) =>
  await post(
    {
      action: "approve",
      secret,
      facts: [
        {
          id: "f1",
          revision: await factRevision({
            id: "f1",
            tag: "step",
            text: sentinel,
            record: sentinel,
          }),
        },
      ],
    },
    cookie
  );

/** Every value in the store's tables, as text. */
const storeText = async (): Promise<string> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
      )
      .toArray()
      .map(({ name }) => name);
    return JSON.stringify(
      tables.map((table) =>
        state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray()
      )
    );
  });

/** What the onboarding's own log says of someone. */
const staffLog = async (person: string): Promise<string[]> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec<{ what: string }>(
        "SELECT what FROM events WHERE about = ? ORDER BY seq",
        person
      )
      .toArray()
      .map(({ what }) => what)
  );

/** A refusal, read from its status and its body's text. */
const shapeOf = (status: number, text: string) => {
  const { code, message } = errorPayloadSchema.parse(JSON.parse(text));
  return { status, code, message };
};

/** A refusal as someone without the link's secret would compare it. */
const shape = async (response: Response) => {
  const { code, message } = errorPayloadSchema.parse(await response.json());
  return { status: response.status, code, message };
};

const randomSecret = () =>
  btoa(String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

describe("a made-up link", () => {
  it("opens nothing, and the store keeps no secret or session as it is (L1, L2)", async () => {
    const { secrets, me } = await running();
    const warned = vi.spyOn(console, "warn");
    const made = randomSecret();
    const unknown = await session(made, me);
    const malformed = await post({ action: "session", secret: "short" }, me);
    await opened(secrets.oli, me);
    expect({
      unknown: unknown.status,
      unknownCode: await codeOf(unknown),
      malformed: await codeOf(malformed),
      referrer: unknown.headers.get("referrer-policy"),
      cache: unknown.headers.get("cache-control"),
    }).toStrictEqual({
      unknown: 404,
      unknownCode: "interview.link_invalid",
      malformed: "interview.invalid",
      referrer: "no-referrer",
      cache: "no-store",
    });
    expect(JSON.stringify(warned.mock.calls)).not.toContain(made);
    const page = await routed("/interview");
    expect([
      page.headers.get("referrer-policy"),
      page.headers.get("cache-control"),
    ]).toStrictEqual(["no-referrer", "no-store"]);
    const kept = await storeText();
    const token = me.split("=")[1]?.split(".")[0] ?? me;
    expect([kept.includes(secrets.oli), kept.includes(token)]).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe("someone's own link", () => {
  it("opens for the account its address signs in, keeps what they say, and gives it back on another device they sign in on", async () => {
    const { ids, secrets, me } = await running();
    const first = await opened(secrets.oli, me);
    expect(first).toMatchObject({
      state: "open",
      name: "Oli",
      team: "Ops",
      lead: null,
      kind: "own",
      closed: false,
      progress: null,
      version: 0,
    });
    const saved = await save(secrets.oli, me, 0);
    await expect(saved.json()).resolves.toStrictEqual({
      saved: true,
      version: 1,
    });
    // Signed in again, as on their phone: the same person, a new session.
    const phone = await signedInAs(emailOf(ids.oli));
    const back = await opened(secrets.oli, phone);
    expect({
      newSession: phone !== me,
      version: back.version,
      said: back.progress?.lines[1]?.text,
    }).toStrictEqual({ newSession: true, version: 1, said: sentinel });
  });

  it("keeps the clock that leaves time away out of the minutes, and gives it back (GRA-1468)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    const withClock = {
      ...progress(),
      seenAt: Date.now(),
      awayMs: 20 * 60 * 60_000,
    };
    const saved = await save(secrets.oli, me, 0, withClock);
    await expect(saved.json()).resolves.toStrictEqual({
      saved: true,
      version: 1,
    });
    const back = await opened(secrets.oli, me);
    expect({
      seenAt: back.progress?.seenAt,
      awayMs: back.progress?.awayMs,
    }).toStrictEqual({ seenAt: withClock.seenAt, awayMs: withClock.awayMs });
    // A clock that is no clock is refused whole, as anything else would be.
    const bad = await save(secrets.oli, me, 1, { ...progress(), awayMs: -5 });
    expect(bad.ok).toBeFalsy();
  });

  it("gives anyone else with the link, signed in or not, the admin too, nothing that was said, and nothing a link that never was wouldn't (L3)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    // The configured admin, and a team-mate, each signed in as themselves.
    const admin = await signedInAs("ada@acme.test");
    const mate = await signedInAs(`mate-${unique()}@acme.test`);
    const never = randomSecret();
    const asked = {
      admin: await session(secrets.oli, admin),
      mate: await session(secrets.oli, mate),
      signedOut: await session(secrets.oli, ""),
    };
    const texts = {
      admin: await asked.admin.text(),
      mate: await asked.mate.text(),
      signedOut: await asked.signedOut.text(),
    };
    expect({
      admin: shapeOf(asked.admin.status, texts.admin),
      mate: shapeOf(asked.mate.status, texts.mate),
      signedOut: shapeOf(asked.signedOut.status, texts.signedOut),
    }).toStrictEqual({
      admin: await shape(await session(never, admin)),
      mate: await shape(await session(never, mate)),
      signedOut: {
        status: 401,
        code: "interview.sign_in",
        message: "Sign in with your work account to open your interview.",
      },
    });
    expect(Object.values(texts).join("")).not.toContain(sentinel);
    expect([
      await codeOf(await save(secrets.oli, admin, 1, progress("Overwritten"))),
      await codeOf(await remove(secrets.oli, mate)),
    ]).toStrictEqual(["interview.link_invalid", "interview.link_invalid"]);
    const mine = await session(secrets.oli, me);
    await expect(mine.text()).resolves.toContain(sentinel);
  });

  it("is never someone else's for having opened a forwarded link first: their address isn't the one it went to (L3)", async () => {
    const { secrets, me } = await running();
    const forwarded = await signedInAs(`forwarded-${unique()}@acme.test`);
    const first = await session(secrets.oli, forwarded);
    const mine = await opened(secrets.oli, me);
    expect({
      first: [first.status, await codeOf(first)],
      mine: mine.state,
    }).toStrictEqual({ first: [404, "interview.link_invalid"], mine: "open" });
  });

  it("stays the account's it first opened for, whatever the list says or a link goes to afterwards (L3)", async () => {
    const { ids, roster, store, secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    // The admin puts their own address on Oli's entry, and the link goes out
    // to it again.
    const theirs = `taker-${unique()}@acme.test`;
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.map((person) =>
          person.id === ids.oli ? { ...person, email: theirs } : person
        ),
      },
      { type: "system" }
    );
    await store.remindDue(new Date(Date.now() + 10 * dayMs).toISOString());
    const taker = await signedInAs(theirs);
    const taken = await session(secrets.oli, taker);
    const mine = await opened(secrets.oli, me);
    expect({
      taken: [taken.status, await codeOf(taken)],
      mine: mine.progress?.lines[1]?.text,
    }).toStrictEqual({
      taken: [404, "interview.link_invalid"],
      mine: sentinel,
    });
  });

  it("opens for the address it went to though the list changed since, and never for the new one (L3)", async () => {
    const { ids, roster, store, secrets, me } = await running();
    const theirs = `taker-${unique()}@acme.test`;
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.map((person) =>
          person.id === ids.oli ? { ...person, email: theirs } : person
        ),
      },
      { type: "system" }
    );
    const taker = await signedInAs(theirs);
    const taken = await session(secrets.oli, taker);
    const mine = await opened(secrets.oli, me);
    expect({
      taken: [taken.status, await codeOf(taken)],
      mine: mine.state,
    }).toStrictEqual({ taken: [404, "interview.link_invalid"], mine: "open" });
  });

  it("opens for nobody while it was sent to no address, and for the address once the list has one (L3)", async () => {
    const { ids, roster, store, me } = await running();
    // Ona has no address on the list when her link goes out, so no mail
    // carries it: an admin hands it over by hand.
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.map((person) =>
          person.id === ids.ona ? { ...person, email: "" } : person
        ),
      },
      { type: "system" }
    );
    const link = await store.linkOf(ids.ona);
    const secret = link?.split("#")[1] ?? "";
    const before = await session(secret, me);
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.map((person) =>
          person.id === ids.ona
            ? { ...person, email: emailOf(ids.ona) }
            : person
        ),
      },
      { type: "system" }
    );
    const ona = await signedInAs(emailOf(ids.ona));
    const after = await opened(secret, ona);
    expect({
      before: [before.status, await codeOf(before)],
      after: { state: after.state, name: after.name },
    }).toStrictEqual({
      before: [404, "interview.link_invalid"],
      after: { state: "open", name: "Ona" },
    });
  });

  it("opens for neither of two on the list with the same address (L3)", async () => {
    const { ids, roster, store, secrets } = await running();
    const shared = `shared-${unique()}@acme.test`;
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.map((person) =>
          person.id === ids.oli || person.id === ids.lead
            ? { ...person, email: shared }
            : person
        ),
      },
      { type: "system" }
    );
    const them = await signedInAs(shared);
    const oli = await session(secrets.oli, them);
    const lead = await session(secrets.lead, them);
    expect([
      [oli.status, await codeOf(oli)],
      [lead.status, await codeOf(lead)],
    ]).toStrictEqual([
      [404, "interview.link_invalid"],
      [404, "interview.link_invalid"],
    ]);
  });

  it("drives nothing for a request another site sent, nor for Grasp's staff", async () => {
    const { secrets, me } = await running();
    const fromElsewhere = await post(
      { action: "session", secret: secrets.oli },
      me,
      {
        "sec-fetch-site": "cross-site",
      }
    );
    const staff = await post(
      { action: "session", secret: secrets.oli },
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    expect([
      [fromElsewhere.status, await codeOf(fromElsewhere)],
      [staff.status, await codeOf(staff)],
    ]).toStrictEqual([
      [403, "request.forbidden"],
      [401, "interview.sign_in"],
    ]);
  });

  it("never loses a save to a second tab: the older copy is refused with the one kept (L4)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    const first = await save(secrets.oli, me, 1, progress("First tab"));
    const second = await save(secrets.oli, me, 1, progress("Second tab"));
    const refused = await savedOf(second);
    await expect(first.json()).resolves.toStrictEqual({
      saved: true,
      version: 2,
    });
    expect(second.status).toBe(409);
    expect(refused.saved ? null : refused.progress?.lines[1]?.text).toBe(
      "First tab"
    );
  });

  it("refuses a save with anything but an interview in it (P3)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    const good = progress();
    const wrong = [
      { ...good, approvedBy: "the boss" },
      { ...good, facts: [{ id: "f1", tag: "salary", text: "x", record: "x" }] },
      { ...good, lines: [{ from: "person", text: "a".repeat(4001) }] },
      { ...good, lines: [{ from: "boss", text: "Do as I say" }] },
    ];
    const codes = await Promise.all(
      wrong.map(
        async (sent) => await codeOf(await save(secrets.oli, me, 0, sent))
      )
    );
    expect(codes).toStrictEqual(Array.from(wrong, () => "interview.invalid"));
  });
});

describe("when a link opens", () => {
  // No link goes out before the agreements are in, and once one did they
  // stay as agreed (onboarding.test.ts): a link out without them can't be.
  it("opens nothing before it went out (L5)", async () => {
    const { ids, secrets } = await running();
    // The lead hasn't talked: their team's other links wait. Not yet sent,
    // the link was sent to nobody, so it opens for nobody.
    const member = await signedInAs(emailOf(ids.member));
    const waiting = await session(secrets.member, member);
    expect([waiting.status, await codeOf(waiting)]).toStrictEqual([
      404,
      "interview.link_invalid",
    ]);
  });

  it("takes nothing while the interviews are paused, and opens again after (L8)", async () => {
    const { store, secrets, me } = await running();
    await opened(secrets.oli, me);
    await store.setPaused(true, { type: "system" });
    const paused = [
      await codeOf(await session(secrets.oli, me)),
      await codeOf(await save(secrets.oli, me, 0)),
    ];
    await store.setPaused(false, { type: "system" });
    const resumed = await save(secrets.oli, me, 0);
    expect({ paused, resumed: resumed.status }).toStrictEqual({
      paused: ["interview.paused", "interview.paused"],
      resumed: 200,
    });
  });

  it("takes nothing more after the last day, and can still be deleted (L6)", async () => {
    const { store, secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await store.savePlan(
      { start: isoDay(Date.now() - 20 * dayMs), days: 14 },
      { type: "system" }
    );
    const closed = await opened(secrets.oli, me);
    const late = await save(secrets.oli, me, 1);
    const deleted = await remove(secrets.oli, me);
    expect({
      closed: closed.closed,
      late: await codeOf(late),
      deleted: deleted.status,
    }).toStrictEqual({ closed: true, late: "interview.closed", deleted: 200 });
  });

  it("answers for someone taken off the list as for a link that never was, and forgets what they said (L7, L10)", async () => {
    const { store, ids, secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    const view = await store.view();
    const roster = view.roster ?? { teams: [], people: [] };
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.filter(({ id }) => id !== ids.oli),
      },
      { type: "system" }
    );
    const gone = await session(secrets.oli, me);
    const never = await session(randomSecret(), me);
    await expect(shape(gone)).resolves.toStrictEqual(await shape(never));
    await expect(storeText()).resolves.not.toContain(sentinel);
    // Put back, they get a new link: the old one stays shut.
    await store.saveRoster(roster, { type: "system" });
    await expect(store.linkOf(ids.oli)).resolves.not.toContain(secrets.oli);
  });

  it("counts calls per link: past sixty a minute a link waits, the others don't (L11)", async () => {
    const { store, ids, secrets } = await running();
    const { sha256Hex } = await import("@grasp-os/shared/encoding");
    const oli = await sha256Hex(secrets.oli);
    const lead = await sha256Hex(secrets.lead);
    const now = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const caller = (person: string) => ({
      account: `account-${person}`,
      address: emailOf(person),
    });
    const answers = [];
    for (let call = 0; call < 61; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      answers.push(await store.openLink(oli, caller(ids.oli), now));
    }
    const other = await store.openLink(lead, caller(ids.lead), now);
    expect({
      sixtieth: answers[59]?.ok,
      sixtyFirst: answers[60]?.ok === false ? answers[60].code : "ok",
      other: other.ok,
    }).toStrictEqual({
      sixtieth: true,
      sixtyFirst: "interview.limited",
      other: true,
    });
  });

  it("never counts someone else's calls against a link: theirs answer as a made-up link's, call after call, and its person is never held up (L3, L11)", async () => {
    const { secrets, me } = await running();
    const admin = await signedInAs("ada@acme.test");
    const made = randomSecret();
    const theirs = [];
    const madeUp = [];
    for (let call = 0; call < 61; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      theirs.push(await session(secrets.oli, admin));
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      madeUp.push(await session(made, admin));
    }
    const last = theirs.at(-1);
    const lastMadeUp = madeUp.at(-1);
    const mine = await session(secrets.oli, me);
    expect({
      last: last === undefined ? null : await shape(last),
      mine: mine.status,
    }).toStrictEqual({
      last: lastMadeUp === undefined ? null : await shape(lastMadeUp),
      mine: 200,
    });
  });

  it("does no more for someone else on a real link than on a made-up one: the same calls to the onboarding, none to the Brain, whatever they ask (L3)", async () => {
    const { secrets, me } = await running();
    // Oli's interview is under way, approved, and so in the Brain.
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await approveFact(secrets.oli, me);
    const admin = await signedInAs("ada@acme.test");
    const made = randomSecret();
    const asks = [
      { action: "save", version: 1, progress: progress() },
      { action: "delete" },
      {
        action: "approve",
        facts: [
          {
            id: "f1",
            revision: await factRevision({
              id: "f1",
              tag: "step",
              text: sentinel,
              record: sentinel,
            }),
          },
        ],
      },
      { action: "withdraw" },
    ];
    const callsOn = async (secret: string) => {
      const answers: string[][] = [];
      for (const ask of asks) {
        const watched = watchedEnv();
        // oxlint-disable-next-line no-await-in-loop -- one ask after another
        await post({ ...ask, secret }, admin, {}, watched.env);
        answers.push(watched.calls);
      }
      return answers;
    };
    const real = await callsOn(secrets.oli);
    expect({
      real,
      brain: real.flat().filter((call) => call.startsWith("brain.")),
    }).toStrictEqual({ real: await callsOn(made), brain: [] });
  });
});

describe("deleting and starting again", () => {
  it("deletes at once, and no copy from before, saved or not, can save it back after a new start (D3)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    const deleted = await remove(secrets.oli, me);
    const empty = await opened(secrets.oli, me);
    // A tab that saved before the delete, and one that never saved.
    const back = await save(secrets.oli, me, 1);
    const unsaved = await save(secrets.oli, me, 0);
    const fresh = await save(
      secrets.oli,
      me,
      empty.version,
      progress("A new start")
    );
    // Once the new start is saved, the old copies still can't overwrite it.
    const stale = await savedOf(await save(secrets.oli, me, 1));
    const kept = await opened(secrets.oli, me);
    expect({
      deleted: await deleted.json(),
      progress: empty.progress,
      back: await codeOf(back),
      unsaved: await codeOf(unsaved),
      fresh: fresh.status,
      stale: stale.saved,
      kept: kept.progress?.lines[1]?.text,
    }).toStrictEqual({
      deleted: { deleted: true },
      progress: null,
      back: "interview.deleted",
      unsaved: "interview.deleted",
      fresh: 200,
      stale: false,
      kept: "A new start",
    });
    await expect(storeText()).resolves.not.toContain(sentinel);
  });

  it("gives a link to someone on the roster from before links were made", async () => {
    const { store, ids } = await running();
    await runInDurableObject(onboardingStore(env), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM link_codes WHERE person = ?",
        ids.ona
      );
    });
    const link = await store.linkOf(ids.ona);
    const secret = link?.split("#")[1] ?? "";
    const first = await opened(secret, await signedInAs(emailOf(ids.ona)));
    expect({ state: first.state, name: first.name }).toStrictEqual({
      state: "open",
      name: "Ona",
    });
    await expect(store.linkOf("nobody")).resolves.toBeNull();
  });

  it("gives a new start from Grasp's admin, after which the link opens for its address again, and for no one else (L9)", async () => {
    const { ids, secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await adminCommands().newStart(ids.oli);
    const stranger = await signedInAs(`stranger-${unique()}@acme.test`);
    const refused = await session(secrets.oli, stranger);
    const fresh = await opened(secrets.oli, me);
    expect({
      refused: await codeOf(refused),
      fresh: fresh.progress,
    }).toStrictEqual({ refused: "interview.link_invalid", fresh: null });
  });
});

describe("taking part, approving and withdrawing", () => {
  it("keeps who took part, to which notice, for what and whom, and answers the same when asked again (T1, T7)", async () => {
    const { ids, secrets, me } = await running();
    await opened(secrets.oli, me);
    const old = await takePart(
      secrets.oli,
      me,
      participationNotice.version + 1
    );
    const before = await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    const first = await takePart(secrets.oli, me);
    const again = await takePart(secrets.oli, me);
    const after = await opened(secrets.oli, me);
    const kept = await runInDurableObject(
      onboardingStore(env),
      (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT notice, purpose, audience, withdrawn_at FROM participations WHERE person = ?",
            ids.oli
          )
          .toArray()
    );
    expect({
      old: await codeOf(old),
      before: before.progress,
      first: first.status,
      same: (await first.text()) === (await again.text()),
      told: after.progress?.told,
      kept,
    }).toStrictEqual({
      old: "interview.notice_changed",
      before: null,
      first: 200,
      same: true,
      told: true,
      kept: [
        {
          notice: participationNotice.version,
          purpose: participationNotice.purpose,
          audience: participationNotice.audience,
          withdrawn_at: null,
        },
      ],
    });
  });

  it("lets nobody else signed in with the link, the admin too, take part, approve or withdraw for them (T4)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await save(secrets.oli, me, 0);
    const admin = await signedInAs("ada@acme.test");
    expect([
      await codeOf(await takePart(secrets.oli, admin)),
      await codeOf(await approveFact(secrets.oli, admin)),
      await codeOf(await withdraw(secrets.oli, admin)),
    ]).toStrictEqual([
      "interview.link_invalid",
      "interview.link_invalid",
      "interview.link_invalid",
    ]);
    const mine = await opened(secrets.oli, me);
    expect({
      told: mine.progress?.told,
      withdrawn: mine.withdrawn,
    }).toStrictEqual({ told: false, withdrawn: false });
  });

  it("withdraws once, whenever deleting works, keeps what was said theirs to read, and takes no one back after (T5, T7)", async () => {
    const { store, secrets, me } = await running();
    await opened(secrets.oli, me);
    const unagreed = await withdraw(secrets.oli, me);
    await takePart(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await store.setPaused(true, { type: "system" });
    const first = await withdraw(secrets.oli, me);
    const again = await withdraw(secrets.oli, me);
    await store.setPaused(false, { type: "system" });
    const read = await opened(secrets.oli, me);
    const back = await takePart(secrets.oli, me);
    const deleted = await remove(secrets.oli, me);
    expect({
      unagreed: await codeOf(unagreed),
      first: first.status,
      same: (await first.text()) === (await again.text()),
      withdrawn: read.withdrawn,
      said: read.progress?.lines[1]?.text,
      told: read.progress?.told,
      back: await codeOf(back),
      deleted: deleted.status,
    }).toStrictEqual({
      unagreed: "interview.not_participating",
      first: 200,
      same: true,
      withdrawn: true,
      said: sentinel,
      told: false,
      back: "interview.withdrawn",
      deleted: 200,
    });
  });

  it("keeps nothing more said once they withdrew, whichever tab saves it, and still lets them delete it (T5)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    const { version } = await savedOf(await save(secrets.oli, me, 0));
    await withdraw(secrets.oli, me);
    // Another tab, opened before the withdrawal, saves on from where it was.
    const after = await save(
      secrets.oli,
      me,
      version,
      progress("Said in another tab after withdrawing.")
    );
    const read = await opened(secrets.oli, me);
    const deleted = await remove(secrets.oli, me);
    expect({
      after: [after.status, await codeOf(after)],
      said: read.progress?.lines.map(({ text }) => text),
      version: read.version,
      deleted: deleted.status,
    }).toStrictEqual({
      after: [410, "interview.withdrawn"],
      said: ["What did you do this morning?", sentinel],
      version,
      deleted: 200,
    });
  });

  it("keeps nothing a save brings when they withdraw while it is being kept (T5)", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    const { version } = await savedOf(await save(secrets.oli, me, 0));
    // The save's facts are being hashed (their revisions) as they withdraw.
    const said = "Said while it was being kept.";
    // Plain flags, each side waiting on its own timers: the store can't
    // await anything made in the test's own context.
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const hold = { armed: true, hashing: false, released: false };
    const held = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        if (hold.armed && new TextDecoder().decode(data).includes(said)) {
          hold.armed = false;
          hold.hashing = true;
          while (!hold.released) {
            // oxlint-disable-next-line no-await-in-loop -- waiting for the test to let it go on
            await scheduler.wait(5);
          }
        }
        return await digest(algorithm, data);
      });
    const saving = save(secrets.oli, me, version, progress(said));
    await vi.waitFor(
      () => {
        if (!hold.hashing) {
          throw new Error("Still waiting for the save's facts to be hashed");
        }
      },
      { timeout: 5000, interval: 5 }
    );
    const withdrew = await withdraw(secrets.oli, me);
    hold.released = true;
    const saved = await saving;
    held.mockRestore();
    const read = await opened(secrets.oli, me);
    expect({
      withdrew: withdrew.status,
      saved: [saved.status, await codeOf(saved)],
      said: read.progress?.lines.map(({ text }) => text),
      version: read.version,
    }).toStrictEqual({
      withdrew: 200,
      saved: [410, "interview.withdrawn"],
      said: ["What did you do this morning?", sentinel],
      version,
    });
  });

  it.each([
    ["deleting it from the link", "delete"],
    ["a new start from Grasp's admin", "newStart"],
  ] as const)(
    "keeps a withdrawal final through %s: nobody takes part again (T5)",
    async (_, how) => {
      const { ids, store, secrets, me } = await running();
      await opened(secrets.oli, me);
      await takePart(secrets.oli, me);
      await save(secrets.oli, me, 0);
      await withdraw(secrets.oli, me);
      await (how === "delete"
        ? remove(secrets.oli, me)
        : store.newStart(ids.oli, { type: "system" }));
      const read = await opened(secrets.oli, me);
      expect({
        withdrawn: read.withdrawn,
        back: await codeOf(await takePart(secrets.oli, me)),
      }).toStrictEqual({ withdrawn: true, back: "interview.withdrawn" });
    }
  );

  it("keeps no mark of someone who withdrew once they leave the roster", async () => {
    const { ids, store, secrets, me } = await running();
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await withdraw(secrets.oli, me);
    const marks = async () =>
      await runInDurableObject(onboardingStore(env), (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT withdrawn_at FROM participations WHERE person = ?",
            ids.oli
          )
          .toArray()
      );
    const before = await marks();
    const { roster } = await store.view();
    await store.saveRoster(
      {
        teams: roster?.teams ?? [],
        people: (roster?.people ?? []).filter(({ id }) => id !== ids.oli),
      },
      { type: "system" }
    );
    expect({ before: before.length, after: await marks() }).toStrictEqual({
      before: 1,
      after: [],
    });
  });

  it("approves nothing after the last day: what wasn't approved stays theirs alone (T6)", async () => {
    const { ids, store, secrets, me } = await running();
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await store.savePlan(
      { start: isoDay(Date.now() - 20 * dayMs), days: 14 },
      { type: "system" }
    );
    expect({
      late: await codeOf(await approveFact(secrets.oli, me)),
      drawn: await store.drawInput(ids.oli),
    }).toStrictEqual({ late: "interview.closed", drawn: null });
  });

  it("asks again before anything new once the interview is deleted: taking part goes with it", async () => {
    const { secrets, me } = await running();
    await opened(secrets.oli, me);
    await takePart(secrets.oli, me);
    await save(secrets.oli, me, 0);
    await remove(secrets.oli, me);
    const read = await opened(secrets.oli, me);
    expect({
      told: read.progress?.told ?? false,
      approve: await codeOf(await approveFact(secrets.oli, me)),
    }).toStrictEqual({
      told: false,
      approve: "interview.not_participating",
    });
  });
});

describe("what the company learns", () => {
  it("finds nothing of what anyone did on their link in the audit log; only staff's log has it (W7)", async () => {
    const { ids, secrets, me } = await running();
    const { userId } = await whoami(me);
    const events = await auditedDuring(async () => {
      await opened(secrets.oli, me);
      await takePart(secrets.oli, me);
      await save(secrets.oli, me, 0, { ...progress(), person: "completed" });
      await approveFact(secrets.oli, me);
      await withdraw(secrets.oli, me);
      await remove(secrets.oli, me);
    });
    const text = JSON.stringify(events);
    expect([
      text.includes(ids.oli),
      text.includes(userId),
      text.includes(sentinel),
      text.includes(secrets.oli),
    ]).toStrictEqual([false, false, false, false]);
    await expect(staffLog(ids.oli)).resolves.toStrictEqual([
      "mail.link.sent",
      "interview.opened",
      "interview.participated",
      "interview.started",
      "interview.completed",
      "interview.approved",
      // In their own Brain from now on: noted here alone, which only staff
      // read (GRA-1790).
      "interview.in_brain",
      "interview.withdrawn",
      "interview.deleted",
    ]);
  });
});
