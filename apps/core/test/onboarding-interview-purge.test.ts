import { purgedMarker } from "@grasp-os/brain/knowledge";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  factRevision,
  participationNotice,
} from "@grasp-os/shared/interview-links";
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Roster } from "@grasp-os/shared/onboarding";
import { defaultPlatformAi } from "@grasp-os/shared/platform-ai";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  drawingErasure,
  interviewErasure,
} from "../src/onboarding/interview-erasure.ts";
import { staffTextErasure } from "../src/onboarding/staff-text-erasure.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { keepLine, keptLine } from "../src/speech-cache.ts";
import type { SpokenKey } from "../src/speech-cache.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// A Knowledge content purge reaches the interviews (GRA-528): a purge is
// the admin's hard delete, and what people said, or Stephen said to them,
// may quote what it takes out (the kickoff's words, say). The ways it can
// fail, tried here: the words left in a line, a mark, a fact read back or
// the record it keeps; the device's older copy saving them back; the
// audit log naming them.

/** The speech model lines are said in: the platform's default. */
const speechModel = "elevenlabs/eleven_v4";
const idp = mockIdp();

/** An interview in which `term` was said, marked and read back. */
const progressSaying = (term: string): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: `The kickoff said ${term} matters. Does it?` },
    {
      from: "person",
      text: `Yes, ${term} decides the week.`,
      typed: true,
      marks: [{ quote: `${term} decides the week`, tag: "step" }],
    },
  ],
  facts: [
    {
      id: "f1",
      tag: "step",
      text: `${term} decides the week`,
      record: `${term} decides the week`,
    },
  ],
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
});

/**
 * An onboarding whose one lead is talking, having said `term`, their team
 * described as `does`; their link's marks, and who they are.
 */
const talking = async (term: string, does = "") => {
  const store = onboardingStore(env);
  const lead = `lea-${unique()}`;
  const roster: Roster = {
    teams: [{ id: "sales", name: "Sales", lead, does, off: false }],
    people: [
      {
        id: lead,
        name: "Lea Lund",
        email: "lea@acme.test",
        team: "sales",
        title: "Head of Sales",
        away: false,
      },
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan(
    { start: new Date().toISOString().slice(0, 10), days: 14 },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const link = (await store.linkOf(lead)) ?? "";
  const mark = await sha256Hex(link.split("#")[1] ?? "");
  const key = await sha256Hex("lea's device");
  await store.openLink(mark, null, key);
  await store.saveInterview(mark, key, 0, progressSaying(term));
  return { mark, key, lead };
};

/** A line as Stephen says it in English, as the speech cache keeps it. */
const spokenKey = (text: string): SpokenKey => ({
  text,
  spoken: `[warm] ${text}`,
  voice: defaultPlatformAi.speech.voices.stephen,
  model: speechModel,
  language: "en",
});

/** Purges `term` from the Knowledge, as an admin does, through the API. */
const purgeTerm = async (term: string): Promise<void> => {
  const admin = await signedInApi(idp, "admin");
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Purged ${unique()}`,
    access: "everyone",
  });
  const document = await admin.api.knowledge.saveDocument({
    collectionId,
    path: "note.md",
    text: `# Note\n${term} was named.`,
    ifVersion: 0,
  });
  const input: PurgeInput = {
    type: "content",
    documentIds: [document.id],
    terms: [term],
    reason: "erasure_request",
  };
  const plan = await admin.api.knowledge.preparePurge(input);
  await admin.api.knowledge.purge(input, plan.token);
};

describe("a content purge of the interviews", () => {
  it("takes the term out of every line, mark and fact, refuses the device's older copy, and audits no word", async () => {
    const term = `Zq${unique()}`;
    const { mark, key } = await talking(term);
    await purgeTerm(term);
    const store = onboardingStore(env);
    const said = await store.interviewsSaid();
    // The device still holds the copy it saved, at the version it had.
    const stale = await store.saveInterview(mark, key, 1, progressSaying(term));
    const events = await allEvents();
    const purged = events.filter(
      ({ action }) => action === "onboarding.interview.purged"
    );

    expect({
      holds: JSON.stringify(said).includes(term),
      stale: stale.ok ? stale.value.saved : "refused",
      staleHolds: JSON.stringify(stale).includes(term),
      purged: purged.length > 0,
      auditHolds: JSON.stringify(purged).includes(term),
    }).toMatchObject({
      holds: false,
      stale: false,
      staleHolds: false,
      purged: true,
      auditHolds: false,
    });
  });

  it("rewrites an interview saved again between the purge's read and its rewrite", async () => {
    const term = `Zq${unique()}`;
    const { mark, key } = await talking(term);
    const store = onboardingStore(env);
    let tries = 0;
    /** The store, but its first rewrite comes after the device saved again. */
    const racing = (stub: typeof store): typeof store =>
      new Proxy(stub, {
        get: (target, name, receiver): unknown => {
          if (name !== "rewriteInterview") {
            return Reflect.get(target, name, receiver);
          }
          return async (
            ...args: Parameters<typeof store.rewriteInterview>
          ): Promise<boolean> => {
            tries += 1;
            if (tries === 1) {
              const saved = progressSaying(term);
              await store.saveInterview(mark, key, 1, {
                ...saved,
                lines: [
                  ...saved.lines,
                  { from: "person", text: `And ${term} again.`, typed: true },
                ],
              });
            }
            return await target.rewriteInterview(...args);
          };
        },
      });
    const namespace = (real: typeof env.ONBOARDING): typeof env.ONBOARDING =>
      new Proxy(real, {
        get: (target, name, receiver): unknown => {
          if (name === "getByName") {
            return (id: string) => racing(target.getByName(id));
          }
          if (name === "jurisdiction") {
            return (where: DurableObjectJurisdiction) =>
              namespace(target.jurisdiction(where));
          }
          return Reflect.get(target, name, receiver);
        },
      });
    const erasure = interviewErasure({
      DURABLE_OBJECT_JURISDICTION: env.DURABLE_OBJECT_JURISDICTION,
      ONBOARDING: namespace(env.ONBOARDING),
    });
    await erasure.rewrite(
      { actor: { type: "system" }, userId: "system" },
      (text) => text.replaceAll(term, "(removed)")
    );
    const said = await store.interviewsSaid();

    expect({
      tries,
      holds: JSON.stringify(said).includes(term),
      again: JSON.stringify(said).includes("And (removed) again."),
    }).toStrictEqual({ tries: 2, holds: false, again: true });
  });

  it("keeps what they approved approved, redacted, through their next save", async () => {
    const term = `Zq${unique()}`;
    const { mark, key, lead } = await talking(term);
    const store = onboardingStore(env);
    await store.participate(mark, key, participationNotice.version);
    const [fact] = progressSaying(term).facts;
    if (fact === undefined) {
      throw new Error("The interview has no fact");
    }
    await store.approve(mark, key, [
      { id: fact.id, revision: await factRevision(fact) },
    ]);
    const approvedBefore = await store.interviewOf(lead);

    await purgeTerm(term);
    // The device saves again what it is given: its copy, refused, then
    // the one kept, as the purge left it.
    const refused = await store.saveInterview(
      mark,
      key,
      1,
      progressSaying(term)
    );
    if (!refused.ok || refused.value.saved || refused.value.progress === null) {
      throw new Error("The device's older copy was kept");
    }
    const { version, progress } = refused.value;
    const saved = await store.saveInterview(mark, key, version, progress);
    const approvedAfter = await store.interviewOf(lead);

    expect({
      before: approvedBefore?.counts.approved,
      saved: saved.ok && saved.value.saved,
      holds: JSON.stringify(progress).includes(term),
      after: approvedAfter?.counts.approved,
    }).toStrictEqual({ before: 1, saved: true, holds: false, after: 1 });
  });

  it("takes the term out of what a team does, as its lead's map drew it", async () => {
    const term = `Zq${unique()}`;
    await talking(term, `Sells ${term} to the north.`);

    await purgeTerm(term);
    const store = onboardingStore(env);
    const view = await store.view();

    const [does] = view.roster?.teams.map((team) => team.does) ?? [];
    expect({
      holds: does?.includes(term),
      kept: does?.startsWith("Sells"),
    }).toStrictEqual({ holds: false, kept: true });
  });

  it("takes the lines Stephen said with the term out of the speech cache, and keeps the rest", async () => {
    const term = `Zq${unique()}`;
    await talking(term);
    const answer = JSON.stringify({
      audio: "AAAA",
      mime: "audio/mpeg",
      words: [],
    });
    const [line] = progressSaying(term).lines;
    const elsewhere = `Hello, I'm Stephen. ${unique()}`;
    await keepLine(env, spokenKey(line?.text ?? ""), answer);
    await keepLine(env, spokenKey(elsewhere), answer);

    await purgeTerm(term);

    expect({
      purged: await keptLine(env, spokenKey(line?.text ?? "")),
      elsewhere: await keptLine(env, spokenKey(elsewhere)),
    }).toStrictEqual({ purged: undefined, elsewhere: answer });
  });

  it("leaves what a team does as drawn again from clean words between the purge's read and its write", async () => {
    const term = `Zq${unique()}`;
    await talking(term, `Sells ${term} to the north.`);
    const store = onboardingStore(env);
    const fresh = "Sells to the south.";
    let redrawn = false;
    /** The store, but what the team does is drawn again before the purge writes. */
    const racing = (stub: typeof store): typeof store =>
      new Proxy(stub, {
        get: (target, name, receiver): unknown => {
          if (name !== "forgetDrawings") {
            return Reflect.get(target, name, receiver);
          }
          return async (
            ...args: Parameters<typeof store.forgetDrawings>
          ): Promise<void> => {
            if (!redrawn) {
              redrawn = true;
              const { roster } = await store.view();
              if (roster !== null) {
                await store.saveRoster(
                  {
                    ...roster,
                    teams: roster.teams.map((team) => ({
                      ...team,
                      does: fresh,
                    })),
                  },
                  { type: "system" }
                );
              }
            }
            await target.forgetDrawings(...args);
          };
        },
      });
    const namespace = (real: typeof env.ONBOARDING): typeof env.ONBOARDING =>
      new Proxy(real, {
        get: (target, name, receiver): unknown => {
          if (name === "getByName") {
            return (id: string) => racing(target.getByName(id));
          }
          if (name === "jurisdiction") {
            return (where: DurableObjectJurisdiction) =>
              namespace(target.jurisdiction(where));
          }
          return Reflect.get(target, name, receiver);
        },
      });

    await drawingErasure({
      DURABLE_OBJECT_JURISDICTION: env.DURABLE_OBJECT_JURISDICTION,
      ONBOARDING: namespace(env.ONBOARDING),
    }).rewrite({ actor: { type: "system" }, userId: "system" }, (text) =>
      text.replaceAll(term, "(removed)")
    );
    const { roster } = await store.view();

    expect({
      redrawn,
      does: roster?.teams.map((team) => team.does),
    }).toStrictEqual({ redrawn: true, does: [fresh] });
  });

  it("takes the term out of an interview that no longer reads as one, as stored", async () => {
    const term = `Zq${unique()}`;
    const { lead } = await talking(term);
    // Kept in a shape a later release no longer reads, its words in it.
    const stored = JSON.stringify({ said: [`Yes, ${term} decides the week.`] });
    await runInDurableObject(onboardingStore(env), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE interviews SET progress = ? WHERE person = ?",
        stored,
        lead
      );
    });

    await purgeTerm(term);
    const after = await runInDurableObject(
      onboardingStore(env),
      (_instance, state) =>
        state.storage.sql
          .exec<{ progress: string }>(
            "SELECT progress FROM interviews WHERE person = ?",
            lead
          )
          .one().progress
    );

    expect(after).toBe(
      JSON.stringify({ said: [`Yes, ${purgedMarker} decides the week.`] })
    );
  });

  it("goes on past a teammate's interview that no longer reads as one, while their team's facts are in the brain", async () => {
    const term = `Zq${unique()}`;
    const { lead } = await talking(`Zq${unique()}`);
    const store = onboardingStore(env);
    const member = `max-${unique()}`;
    await store.saveRoster(
      {
        teams: [{ id: "sales", name: "Sales", lead, does: "", off: false }],
        people: [
          {
            id: lead,
            name: "Lea Lund",
            email: "lea@acme.test",
            team: "sales",
            title: "Head of Sales",
            away: false,
          },
          {
            id: member,
            name: "Max Berg",
            email: "max@acme.test",
            team: "sales",
            title: "Seller",
            away: false,
          },
        ],
      },
      { type: "system" }
    );
    // Their interview kept in a shape a later release no longer reads, and
    // their team's facts in the brain: what the purge's drawing reads.
    const stored = JSON.stringify({ said: [`${term} closes the deals.`] });
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO interviews (person, progress, updated_at) VALUES (?, ?, ?)",
        member,
        stored,
        new Date().toISOString()
      );
      state.storage.sql.exec(
        "INSERT INTO brain_sent (record, type, team, person) VALUES (?, 'statement', 'sales', ?)",
        `record-${unique()}`,
        member
      );
    });

    await purgeTerm(term);
    const after = await runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ progress: string }>(
          "SELECT progress FROM interviews WHERE person = ?",
          member
        )
        .one()
    );

    expect(after.progress).toBe(
      JSON.stringify({ said: [`${purgedMarker} closes the deals.`] })
    );
  });

  it("forgets the kickoff when only its file's name holds the term", async () => {
    const term = `Zq${unique()}`;
    const store = onboardingStore(env);
    await store.saveKickoff(
      {
        transcript: "We sell boats.",
        fileName: `${term}.vtt`,
        reading: {
          fields: { business: { text: "Boats", quote: "We sell boats" } },
          ask: {},
          teams: [],
        },
      },
      { type: "system" },
      await store.purgeMark()
    );

    await purgeTerm(term);
    const kept = await store.kickoff();

    expect({
      holds: JSON.stringify(kept).includes(term),
      transcript: kept.transcript,
    }).toStrictEqual({ holds: false, transcript: null });
  });

  it("forgets a checked difference holding the term, and keeps its drawing", async () => {
    const term = `Zq${unique()}`;
    await talking(`Zq${unique()}`);
    const work = `work-${unique()}`;
    const at = new Date().toISOString();
    const drawn = JSON.stringify({ steps: ["The lead signs it off."] });
    await runInDurableObject(onboardingStore(env), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO drawn_works (work, drawn, agreed, at) VALUES (?, ?, '{}', ?)",
        work,
        drawn,
        at
      );
      state.storage.sql.exec(
        "INSERT INTO checked_differences (work, drawn_at, way, other, at) VALUES (?, ?, ?, ?, ?)",
        work,
        at,
        `They ask ${term} first.`,
        "They ask the lead first.",
        at
      );
    });

    await purgeTerm(term);
    const left = await runInDurableObject(
      onboardingStore(env),
      (_instance, state) => ({
        differences: state.storage.sql
          .exec("SELECT work FROM checked_differences WHERE work = ?", work)
          .toArray().length,
        drawings: state.storage.sql
          .exec<{ drawn: string }>(
            "SELECT drawn FROM drawn_works WHERE work = ?",
            work
          )
          .toArray()
          .map((row) => row.drawn),
      })
    );

    expect(left).toStrictEqual({ differences: 0, drawings: [drawn] });
  });
});

describe("a purge of terms in staff's own text", () => {
  it("takes the term out of staff's notes and Stephen's setup, keeps the setup a setup, and audits no word", async () => {
    const term = `Zq${unique()}`;
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    await store.addNote(`Ask Lea about ${term}.`, by);
    const other = `Lea is away on Friday ${unique()}.`;
    await store.addNote(other, by);
    await store.saveStephen(
      {
        languages: ["en"],
        limits: [`Leave ${term} alone.`],
        // Rewritten, the first becomes the second: kept once.
        terms: [term, purgedMarker, "Salesforce"],
      },
      by
    );

    await purgeTerm(term);
    const notes = await store.notes();
    const { setup } = await store.stephen();
    const events = await allEvents();
    const purged = events.filter(
      ({ action }) => action === "onboarding.staff_text.purged"
    );

    expect({
      notesHold: JSON.stringify(notes).includes(term),
      rewritten: notes.some(
        ({ text }) => text === `Ask Lea about ${purgedMarker}.`
      ),
      other: notes.some(({ text }) => text === other),
      setup,
      purged: purged.length > 0,
      auditHolds: JSON.stringify(purged).includes(term),
    }).toStrictEqual({
      notesHold: false,
      rewritten: true,
      other: true,
      setup: {
        languages: ["en"],
        limits: [`Leave ${purgedMarker} alone.`],
        terms: [purgedMarker, "Salesforce"],
      },
      purged: true,
      auditHolds: false,
    });
  });

  it("counts in Stephen's setup only the lines a purge rewrites, never his language codes", async () => {
    const store = onboardingStore(env);
    await store.saveStephen(
      {
        languages: ["nl"],
        limits: ["De plannen van de directie"],
        terms: ["Salesforce"],
      },
      { type: "system" }
    );
    const erasure = staffTextErasure(env);

    expect({
      // A term spelled as a language code: the setup holds it nowhere a
      // purge rewrites, so nothing is left of it there.
      code: await erasure.count((text) => text === "nl"),
      line: await erasure.count((text) => text === "Salesforce"),
    }).toStrictEqual({ code: 0, line: 1 });
  });

  it("leaves staff's text alone when a purge names a document but none of its terms are in it", async () => {
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    // It speaks of the purged document, not of what the purge takes out.
    const note = `See note.md for the sales plan ${unique()}.`;
    await store.addNote(note, by);

    await purgeTerm(`Zq${unique()}`);
    const notes = await store.notes();

    expect(notes.some(({ text }) => text === note)).toBeTruthy();
  });
});
