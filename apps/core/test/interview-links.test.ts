import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type {
  InterviewProgress,
  InterviewSaved,
  InterviewSession,
} from "@grasp-os/shared/interview-links";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Everyone's own interview link (src/onboarding/links.ts): it opens one
// person's interview, on the first device that opens it, while the
// interviews run, and nothing else. The link cases of the threat model
// (GRA-307), each tried here:
//
// - L1: a made-up or malformed link opens nothing; no secret or key is
//   kept as it is.
// - L2: the secret is in no answer or log, and no answer gives a referrer.
// - L3: anyone else with the link, the admin among them, gets nothing that
//   was said, and can neither save nor delete.
// - L4: two tabs on the device never lose a save.
// - L5, L8: nothing opens before the link went out, before the agreements,
//   or while the interviews are paused.
// - L6: after the last day nothing more is taken; deleting still works.
// - L7, L10: someone taken off the list has a link like one that never
//   was, and what they said is gone.
// - L9: staff give someone who lost their device a new start.
// - L11: the store counts calls per link.
// - P3: a save with anything but an interview in it is refused.
// - D3: a copy left open can't save a deleted interview back.
// - W7, and the company not learning who talked: the audit log gets
//   nothing of what anyone did on their link.

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
    ].map((person) => ({ ...person, email: "", title: "", away: false })),
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
    secrets: {
      lead: await secretOf(ids.lead),
      member: await secretOf(ids.member),
      oli: await secretOf(ids.oli),
    },
  };
};

const post = async (body: unknown): Promise<Response> =>
  await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

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

const session = async (secret: string, key?: string) =>
  await post({
    action: "session",
    secret,
    ...(key === undefined ? {} : { key }),
  });

/** Opens a link on a new device: the session, and the key it was given. */
const opened = async (
  secret: string
): Promise<{ session: InterviewSession; key: string }> => {
  const response = await session(secret);
  const body = await sessionOf(response);
  return { session: body, key: body.key ?? "" };
};

const save = async (
  secret: string,
  key: string,
  version: number,
  sent: unknown = progress()
) => await post({ action: "save", secret, key, version, progress: sent });

const remove = async (secret: string, key: string) =>
  await post({ action: "delete", secret, key });

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

/** What the onboarding's own log, which only staff read, says of someone. */
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
  it("opens nothing, and the store keeps no secret or key as it is (L1, L2)", async () => {
    const { secrets } = await running();
    const warned = vi.spyOn(console, "warn");
    const made = randomSecret();
    const unknown = await session(made);
    const malformed = await post({ action: "session", secret: "short" });
    const { key } = await opened(secrets.oli);
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
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const kept = await storeText();
    expect([kept.includes(secrets.oli), kept.includes(key)]).toStrictEqual([
      false,
      false,
    ]);
  });
});

describe("someone's own link", () => {
  it("opens on the first device, keeps what they say, and gives it back there", async () => {
    const { secrets } = await running();
    const { session: first, key } = await opened(secrets.oli);
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
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const saved = await save(secrets.oli, key, 0);
    await expect(saved.json()).resolves.toStrictEqual({
      saved: true,
      version: 1,
    });
    const again = await session(secrets.oli, key);
    const back = await sessionOf(again);
    expect({ key: back.key, version: back.version }).toStrictEqual({
      key: undefined,
      version: 1,
    });
    expect(back.progress?.lines[1]?.text).toBe(sentinel);
  });

  it("gives anyone else with the link, the admin too, nothing that was said (L3)", async () => {
    const { secrets } = await running();
    const { key } = await opened(secrets.oli);
    await save(secrets.oli, key, 0);
    const other = randomSecret();
    const noKey = await session(secrets.oli);
    const otherKey = await session(secrets.oli, other);
    const texts = [await noKey.text(), await otherKey.text()];
    expect(texts.map((text): unknown => JSON.parse(text))).toStrictEqual([
      { state: "elsewhere" },
      { state: "elsewhere" },
    ]);
    expect(texts.join("")).not.toContain(sentinel);
    expect([
      await codeOf(await save(secrets.oli, other, 1, progress("Overwritten"))),
      await codeOf(await remove(secrets.oli, other)),
    ]).toStrictEqual(["interview.elsewhere", "interview.elsewhere"]);
    const mine = await session(secrets.oli, key);
    await expect(mine.text()).resolves.toContain(sentinel);
  });

  it("never loses a save to a second tab: the older copy is refused with the one kept (L4)", async () => {
    const { secrets } = await running();
    const { key } = await opened(secrets.oli);
    await save(secrets.oli, key, 0);
    const first = await save(secrets.oli, key, 1, progress("First tab"));
    const second = await save(secrets.oli, key, 1, progress("Second tab"));
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
    const { secrets } = await running();
    const { key } = await opened(secrets.oli);
    const good = progress();
    const wrong = [
      { ...good, approvedBy: "the boss" },
      { ...good, facts: [{ id: "f1", tag: "salary", text: "x", record: "x" }] },
      { ...good, lines: [{ from: "person", text: "a".repeat(4001) }] },
      { ...good, lines: [{ from: "boss", text: "Do as I say" }] },
    ];
    const codes = await Promise.all(
      wrong.map(
        async (sent) => await codeOf(await save(secrets.oli, key, 0, sent))
      )
    );
    expect(codes).toStrictEqual(Array.from(wrong, () => "interview.invalid"));
  });
});

describe("when a link opens", () => {
  it("opens nothing before it went out, or before the agreements are in (L5)", async () => {
    const { store, secrets } = await running();
    // The lead hasn't talked: their team's other links wait.
    const waiting = await session(secrets.member);
    await store.setAgreements(
      { processing: true, assessment: true, council: "waiting" },
      { type: "system" }
    );
    const noAgreements = await session(secrets.lead);
    expect([
      waiting.status,
      await codeOf(waiting),
      await codeOf(noAgreements),
    ]).toStrictEqual([403, "interview.not_yet", "interview.not_yet"]);
  });

  it("takes nothing while the interviews are paused, and opens again after (L8)", async () => {
    const { store, secrets } = await running();
    const { key } = await opened(secrets.oli);
    await store.setPaused(true, { type: "system" });
    const paused = [
      await codeOf(await session(secrets.oli, key)),
      await codeOf(await save(secrets.oli, key, 0)),
    ];
    await store.setPaused(false, { type: "system" });
    const resumed = await save(secrets.oli, key, 0);
    expect({ paused, resumed: resumed.status }).toStrictEqual({
      paused: ["interview.paused", "interview.paused"],
      resumed: 200,
    });
  });

  it("takes nothing more after the last day, and can still be deleted (L6)", async () => {
    const { store, secrets } = await running();
    const { key } = await opened(secrets.oli);
    await save(secrets.oli, key, 0);
    await store.savePlan(
      { start: isoDay(Date.now() - 20 * dayMs), days: 14 },
      { type: "system" }
    );
    const read = await session(secrets.oli, key);
    const closed = await sessionOf(read);
    const late = await save(secrets.oli, key, 1);
    const deleted = await remove(secrets.oli, key);
    expect({
      closed: closed.closed,
      late: await codeOf(late),
      deleted: deleted.status,
    }).toStrictEqual({ closed: true, late: "interview.closed", deleted: 200 });
  });

  it("answers for someone taken off the list as for a link that never was, and forgets what they said (L7, L10)", async () => {
    const { store, ids, secrets } = await running();
    const { key } = await opened(secrets.oli);
    await save(secrets.oli, key, 0);
    const view = await store.view();
    const roster = view.roster ?? { teams: [], people: [] };
    await store.saveRoster(
      {
        ...roster,
        people: roster.people.filter(({ id }) => id !== ids.oli),
      },
      { type: "system" }
    );
    const gone = await session(secrets.oli, key);
    const never = await session(randomSecret(), key);
    await expect(shape(gone)).resolves.toStrictEqual(await shape(never));
    await expect(storeText()).resolves.not.toContain(sentinel);
    // Put back, they get a new link: the old one stays shut.
    await store.saveRoster(roster, { type: "system" });
    await expect(store.linkOf(ids.oli)).resolves.not.toContain(secrets.oli);
  });

  it("counts calls per link: past sixty a minute a link waits, the others don't (L11)", async () => {
    const { store, secrets } = await running();
    const { sha256Hex } = await import("@grasp-os/shared/encoding");
    const oli = await sha256Hex(secrets.oli);
    const lead = await sha256Hex(secrets.lead);
    const now = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const answers = [];
    for (let call = 0; call < 61; call += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one call after another
      answers.push(await store.openLink(oli, null, "issue", now));
    }
    const other = await store.openLink(lead, null, "issue", now);
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
});

describe("deleting and starting again", () => {
  it("deletes at once, and a copy left open can't save it back (D3)", async () => {
    const { secrets } = await running();
    const { key } = await opened(secrets.oli);
    await save(secrets.oli, key, 0);
    const deleted = await remove(secrets.oli, key);
    const after = await session(secrets.oli, key);
    const empty = await sessionOf(after);
    const back = await save(secrets.oli, key, 1);
    const fresh = await save(secrets.oli, key, 0, progress("A new start"));
    expect({
      deleted: await deleted.json(),
      progress: empty.progress,
      back: await codeOf(back),
      fresh: fresh.status,
    }).toStrictEqual({
      deleted: { deleted: true },
      progress: null,
      back: "interview.deleted",
      fresh: 200,
    });
    await expect(storeText()).resolves.not.toContain(sentinel);
  });

  it("gives someone who lost their device a new start, by staff only (L9)", async () => {
    const { ids, secrets } = await running();
    const { key: lost } = await opened(secrets.oli);
    await save(secrets.oli, lost, 0);
    const { api: admin } = await signedInApi(idp, "admin");
    const notStaff = await outcome(admin.onboardingStaff.newStart(ids.oli));
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    const api = await core.authenticate();
    await api.onboardingStaff.newStart(ids.oli);
    const { session: fresh, key } = await opened(secrets.oli);
    const old = await session(secrets.oli, lost);
    expect({
      notStaff,
      fresh: fresh.progress,
      newKey: key !== "" && key !== lost,
      old: await old.json(),
    }).toStrictEqual({
      notStaff: "onboarding.staff_only",
      fresh: null,
      newKey: true,
      old: { state: "elsewhere" },
    });
  });
});

describe("what the company learns", () => {
  it("finds nothing of what anyone did on their link in the audit log; only staff's log has it (W7)", async () => {
    const { ids, secrets } = await running();
    const events = await auditedDuring(async () => {
      const { key } = await opened(secrets.oli);
      await save(secrets.oli, key, 0, { ...progress(), person: "completed" });
      await remove(secrets.oli, key);
    });
    const text = JSON.stringify(events);
    expect([
      text.includes(ids.oli),
      text.includes(sentinel),
      text.includes(secrets.oli),
    ]).toStrictEqual([false, false, false]);
    await expect(staffLog(ids.oli)).resolves.toStrictEqual([
      "interview.opened",
      "interview.started",
      "interview.completed",
      "interview.deleted",
    ]);
  });
});
