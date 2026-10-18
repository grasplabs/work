import { describe, expect, it } from "vite-plus/test";

import { MIN_GROUP, PHASES } from "../../src/admin/interviews.ts";
import {
  companySees,
  keptOf,
  logOf,
  partsOf,
  personLog,
  recordOf,
  stephenOf,
} from "../../src/admin/onboarding-admin-record.ts";
import {
  dateOn,
  evidenceAt,
  interviewsAt,
  knownWorks,
  PARKED_PARTS,
  PLATFORM_PARTS,
  viewOf,
} from "../../src/admin/onboarding-admin.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import { LISTEN_DAYS } from "../../src/admin/onboarding.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const [noordkade, veldkamp, , hartog] = SAMPLE_ORGS;
const at = (org: Org, more: Partial<OrgState> = {}) =>
  viewOf(org, { ...org.seed, ...more });
const days = Array.from({ length: LISTEN_DAYS + 1 }, (_, day) => day);

describe("the record of a piece of work", () => {
  it("is there for every piece of work its lead has named, and for no other", () => {
    for (const org of [noordkade, hartog]) {
      const view = at(org);
      for (const work of view.works) {
        expect(recordOf(view, work.id)?.evidence.id).toBe(work.id);
      }
      expect(recordOf(view, "nothing")).toBeNull();
    }
    expect(recordOf(at(noordkade, { day: 0 }), "papers")).toBeNull();
  });

  it("rests on the agreed interviews about that work, in the order they came in", () => {
    const view = at(hartog);
    for (const work of view.works) {
      const record = recordOf(view, work.id);
      expect(record?.interviews).toHaveLength(work.approved);
      expect(record?.toAsk).toBe(work.doers - work.approved);
      const order = record?.interviews.map((interview) => interview.day) ?? [];
      expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
      for (const interview of record?.interviews ?? []) {
        expect(interview).toMatchObject({
          approved: true,
          work: { id: work.id },
        });
      }
    }
  });

  it("says for every step how each person told it, and counts the same steps as the list does", () => {
    for (const org of [noordkade, hartog]) {
      const view = at(org);
      for (const work of view.works) {
        const record = recordOf(view, work.id);
        if (!record) {
          continue;
        }
        for (const step of record.steps) {
          expect(step.ways).toHaveLength(record.interviews.length);
          expect(step.people).toBe(
            step.ways.filter((way) => way !== "none").length
          );
          expect(step.people).toBeLessThanOrEqual(record.interviews.length);
        }
        expect(record.steps.filter((step) => step.enough)).toHaveLength(
          work.evidenced
        );
      }
    }
  });

  it("shows a step two ways only where someone told it the other way", () => {
    const view = at(hartog);
    const orders = recordOf(view, "orders");
    const step = orders?.steps[3];
    expect(step?.other).toMatchObject({ why: "condition", explained: true });
    expect(step?.other?.people).toBe(
      step?.ways.filter((way) => way === "other").length
    );
    expect(orders?.steps.filter((each) => each.other !== null)).toHaveLength(1);
    // A difference nobody can explain waits, until its owner explains it.
    expect(recordOf(view, "returns")?.steps[3]?.other).toMatchObject({
      why: "conflict",
      explained: true,
    });
    expect(
      recordOf(at(hartog, { settled: [] }), "returns")?.steps[3]?.other
    ).toMatchObject({ explained: false });
  });

  it("gives every number as the range people said, never one made up", () => {
    const records = [noordkade, hartog].flatMap((org) => {
      const view = at(org);
      return view.works.flatMap((work) => recordOf(view, work.id) ?? []);
    });
    const volumes = records.flatMap((record) =>
      record.volume
        ? [{ ...record.volume, talked: record.interviews.length }]
        : []
    );
    const times = records.flatMap((record) =>
      record.takes
        ? [{ ...record.takes, talked: record.interviews.length }]
        : []
    );
    const wrongs = records.flatMap((record) => record.wrong ?? []);
    expect(volumes.length).toBeGreaterThan(10);
    expect(times.length).toBeGreaterThan(10);
    expect(wrongs.length).toBeGreaterThan(10);
    for (const { quiet, busy, people, talked } of volumes) {
      for (const value of [...quiet, ...busy]) {
        expect(Number.isInteger(value)).toBeTruthy();
      }
      expect(quiet[0]).toBeLessThanOrEqual(quiet[1]);
      expect(busy[0]).toBeLessThanOrEqual(busy[1]);
      expect(people).toBeGreaterThan(0);
      expect(people).toBeLessThanOrEqual(talked);
    }
    for (const { least, most, normal, people, talked } of times) {
      expect(least).toBeLessThanOrEqual(normal[0]);
      expect(normal[1]).toBeLessThanOrEqual(most);
      expect(people).toBeLessThanOrEqual(talked);
    }
    for (const { outOfTen } of wrongs) {
      expect(outOfTen[0]).toBeGreaterThanOrEqual(0);
      expect(outOfTen[1]).toBeLessThanOrEqual(10);
    }
    // Nobody talked: nothing is known, and nothing is put in its place.
    const unheard = records.filter((record) => record.interviews.length === 0);
    expect(unheard.length).toBeGreaterThan(0);
    for (const record of unheard) {
      expect([record.volume, record.takes, record.wrong]).toStrictEqual([
        null,
        null,
        null,
      ]);
    }
    for (const record of records) {
      for (const said of [
        record.starts,
        record.right,
        record.next,
        ...record.waits,
        ...record.differently,
      ]) {
        expect(said.people).toBeLessThanOrEqual(record.interviews.length);
      }
    }
  });
});

describe("counting a workflow as known by hand", () => {
  it("makes it known before the rules do, and says so", () => {
    const before = evidenceAt(noordkade, 8).find(
      (work) => work.id === "claims"
    );
    const after = evidenceAt(noordkade, 8, { counted: ["claims"] }).find(
      (work) => work.id === "claims"
    );
    expect(before).toMatchObject({ state: "mapping", byHand: false });
    expect(after?.byHand).toBeTruthy();
    expect(["complete", "variants"]).toContain(after?.state);
    expect(knownWorks(evidenceAt(noordkade, 8, { counted: ["claims"] }))).toBe(
      knownWorks(evidenceAt(noordkade, 8)) + 1
    );
  });

  it("changes nothing for work the rules already call known", () => {
    const known = evidenceAt(noordkade, 8).find(
      (work) => work.state === "complete"
    );
    const counted = evidenceAt(noordkade, 8, {
      counted: known ? [known.id] : [],
    }).find((work) => work.id === known?.id);
    expect(counted).toMatchObject({ state: "complete", byHand: false });
  });

  it("does not hide a difference nobody can explain", () => {
    const blocked = evidenceAt(noordkade, LISTEN_DAYS).find(
      (work) => work.state === "blocked"
    );
    expect(blocked).toBeDefined();
    const counted = evidenceAt(noordkade, LISTEN_DAYS, {
      counted: blocked ? [blocked.id] : [],
    }).find((work) => work.id === blocked?.id);
    expect(counted).toMatchObject({ state: "blocked", byHand: false });
  });

  it("raises what Grasp knows about the organization", () => {
    expect(
      at(noordkade, { counted: ["claims", "renewal", "change"] }).knowledge
        .percent
    ).toBeGreaterThan(at(noordkade).knowledge.percent);
  });
});

describe("someone who is away", () => {
  const view = at(noordkade);
  const waiting = view.people.find(
    (each) => !each.person.lead && each.state === "invited"
  );

  it("has no state of their own, gets no reminder, and is not waited for", () => {
    expect(waiting).toBeDefined();
    const id = waiting?.person.id ?? "";
    const away = at(noordkade, { away: [id] });
    const person = away.people.find((each) => each.person.id === id);
    expect(person).toMatchObject({
      state: "away",
      mayRemind: false,
      completed: null,
    });
    expect(away.counts.away).toBe(1);
    expect(away.counts.invited).toBe(view.counts.invited - 1);
  });

  it("does not count among the people who do their work", () => {
    const id = waiting?.person.id ?? "";
    const work = waiting?.person.work ?? "";
    const before = evidenceAt(noordkade, 8).find((each) => each.id === work);
    const after = evidenceAt(noordkade, 8, { away: [id] }).find(
      (each) => each.id === work
    );
    expect(after?.doers).toBe((before?.doers ?? 0) - 1);
    expect(
      interviewsAt(noordkade, LISTEN_DAYS, { away: [id] }).some(
        (interview) => interview.id === id
      )
    ).toBeFalsy();
  });
});

describe("Stephen at an organization", () => {
  it("has nothing to show before the first interview", () => {
    expect(stephenOf(at(veldkamp))).toMatchObject({
      held: 0,
      minutes: 0,
      interviews: 0,
      filled: 0,
      approved: 0,
      mistakes: 0,
      stopped: 0,
      look: [],
    });
  });

  it("is scored over the interviews people agreed to", () => {
    for (const org of [noordkade, hartog]) {
      const view = at(org);
      const stats = stephenOf(view);
      const agreed = view.interviews.filter((interview) => interview.approved);
      expect(stats.held).toBe(agreed.length);
      expect(stats.interviews).toBe(
        agreed.filter((interview) => interview.kind === "employee").length
      );
      expect(stats.minutes).toBe(
        view.interviews.reduce(
          (sum, interview) => sum + (interview.minutes ?? 0),
          0
        )
      );
      for (const share of [stats.filled, stats.approved, stats.byVoice]) {
        expect(share).toBeGreaterThan(0);
        expect(share).toBeLessThanOrEqual(1);
      }
      // People take out a line now and then, never most of them.
      expect(stats.approved).toBeGreaterThan(0.9);
    }
  });

  it("counts every stop in the part it happened in, and every mistake under its kind", () => {
    const view = at(noordkade);
    const stats = stephenOf(view);
    // Someone talking now has stopped nowhere: the sample has some.
    const talking = new Set(
      view.people
        .filter((each) => each.state === "progress")
        .map((each) => each.person.id)
    );
    const unfinished = view.interviews.filter(
      (interview) => !interview.approved
    );
    const halfway = unfinished.filter(
      (interview) => !talking.has(interview.id)
    );
    expect(halfway.length).toBeLessThan(unfinished.length);
    expect(stats.stopped).toBe(halfway.length);
    expect(PHASES.reduce((sum, phase) => sum + stats.stops[phase], 0)).toBe(
      halfway.length
    );
    // Nobody stops before the first question, or while it is read back.
    expect(stats.stops.open + stats.stops.readback).toBe(0);
    const mistakes = view.interviews
      .filter((interview) => interview.approved)
      .reduce((sum, interview) => sum + interview.mistakes, 0);
    expect(
      Object.values(stats.kinds).reduce((sum, count) => sum + count, 0)
    ).toBe(mistakes);
    for (const interview of view.interviews) {
      expect(interview.kinds).toHaveLength(interview.mistakes);
    }
    for (const interview of stats.look) {
      expect(interview.mistakes).toBeGreaterThan(1);
    }
  });

  it("says what people thought of him, only from those who said so and only once they agreed", () => {
    const view = at(noordkade);
    const stats = stephenOf(view);
    const agreed = view.interviews.filter((interview) => interview.approved);
    const said = agreed.filter((interview) => interview.rating !== null);
    expect({
      count: stats.rating.count,
      // Most say so, never all: it is theirs to give or not.
      most: said.length > agreed.length / 2,
      notAll: said.length < agreed.length,
      byRating: [1, 2, 3, 4, 5].reduce(
        (sum, rating) => sum + (stats.rating.by[rating] ?? 0),
        0
      ),
      fromOneToFive: stats.rating.average >= 1 && stats.rating.average <= 5,
    }).toStrictEqual({
      count: said.length,
      most: true,
      notAll: true,
      byRating: said.length,
      fromOneToFive: true,
    });
    expect(stats.rating.average).toBeCloseTo(
      said.reduce((sum, interview) => sum + (interview.rating ?? 0), 0) /
        said.length,
      6
    );
    // An interview that stopped halfway has no rating: it is asked at the end.
    for (const interview of view.interviews.filter((each) => !each.approved)) {
      expect(interview.rating).toBeNull();
    }
    expect(stephenOf(at(veldkamp)).rating).toStrictEqual({
      count: 0,
      average: 0,
      by: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
  });

  it("says who people chose to talk with, everyone once, and what each one’s people thought of it", () => {
    const view = at(noordkade);
    const stats = stephenOf(view);
    // Both interviewers, in the order they are offered, and every interview with one of them.
    expect(stats.chose.map((each) => each.interviewer)).toStrictEqual([
      "stephen",
      "claire",
    ]);
    expect(stats.chose.reduce((sum, each) => sum + each.count, 0)).toBe(
      view.interviews.length
    );
    for (const each of stats.chose) {
      expect(each.count).toBe(
        view.interviews.filter(
          (interview) => interview.interviewer === each.interviewer
        ).length
      );
    }
    // The sample's people choose both.
    for (const each of stats.chose) {
      expect(each.count).toBeGreaterThan(0);
    }
    // What they thought is counted with whoever they talked to, and adds up to what everyone thought.
    expect(stats.chose.reduce((sum, each) => sum + each.rated, 0)).toBe(
      stats.rating.count
    );
    const all =
      stats.chose.reduce((sum, each) => sum + each.average * each.rated, 0) /
      stats.rating.count;
    expect(all).toBeCloseTo(stats.rating.average, 6);
    // Nobody talked yet: nobody chose.
    expect(
      stephenOf(at(veldkamp)).chose.every(
        (each) => each.count === 0 && each.rated === 0
      )
    ).toBeTruthy();
  });

  it("says how many who started finished, and how long the interviews took", () => {
    const view = at(noordkade);
    const stats = stephenOf(view);
    // Every agreed interview is in one step of the lengths, and a lead's takes longer than anyone else's.
    expect({
      started: stats.started,
      heldOfStarted: stats.held <= stats.started,
      inLengths: stats.lengths.reduce((sum, each) => sum + each.count, 0),
      lastUpTo: stats.lengths.at(-1)?.upTo,
      reviewed: stats.reviewed,
    }).toStrictEqual({
      started: view.interviews.length,
      heldOfStarted: true,
      inLengths: stats.held,
      lastUpTo: null,
      reviewed: true,
    });
    expect(stats.length.lead).toBeGreaterThan(stats.length.employee);
  });

  it("leaves questions over only where someone could not say a number or who is next", () => {
    const view = at(noordkade);
    for (const interview of view.interviews) {
      expect(interview.followUps).toBeGreaterThanOrEqual(0);
      expect(interview.followUps).toBeLessThanOrEqual(4);
    }
    // A question is left over only once the interview is finished.
    for (const interview of view.interviews.filter((each) => !each.approved)) {
      expect(interview.followUps).toBe(0);
    }
  });
});

describe("one person’s two weeks", () => {
  it("are in the order things happened, and never ahead of the day", () => {
    for (const day of [3, 8, LISTEN_DAYS]) {
      const view = at(noordkade, { day });
      for (const each of view.people) {
        const log = personLog(view, each.person.id);
        const order = log.map((event) => event.day);
        expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
        for (const event of log) {
          expect(event.day).toBeLessThanOrEqual(day);
        }
      }
    }
  });

  it("say the same as the list of people does", () => {
    const view = at(noordkade);
    for (const each of view.people) {
      const log = personLog(view, each.person.id);
      expect(log.some((event) => event.what === "sent")).toBe(
        each.sent !== null
      );
      expect(log.some((event) => event.what === "completed")).toBe(
        each.state === "completed"
      );
      expect(log.find((event) => event.what === "reminded")?.day ?? null).toBe(
        each.reminded
      );
      // The last thing in their log is the last thing the list says happened.
      expect(log.at(-1)?.day ?? null).toBe(each.last?.day ?? null);
    }
  });

  it("end with a link that closed for whoever never talked", () => {
    const view = at(noordkade, { day: LISTEN_DAYS });
    const never = view.people.filter(
      (each) => each.state === "expired" || each.state === "incomplete"
    );
    expect(never.length).toBeGreaterThan(0);
    for (const each of never) {
      expect(personLog(view, each.person.id).at(-1)).toStrictEqual({
        what: "expired",
        day: LISTEN_DAYS,
      });
    }
  });

  it("are empty before the team is told", () => {
    const view = at(veldkamp);
    for (const each of view.people) {
      expect(personLog(view, each.person.id)).toStrictEqual([]);
    }
  });
});

describe("what the company itself sees", () => {
  it("is numbers per team, and none for a team under five", () => {
    const sees = companySees(at(hartog));
    expect(sees.teams).toHaveLength(hartog.teams.length);
    for (const team of sees.teams) {
      expect(team.shown).toBe(team.people >= MIN_GROUP);
    }
    expect(sees.people).toBe(
      hartog.teams.reduce((sum, team) => sum + team.people, 0)
    );
    expect(sees.completed).toBe(
      sees.teams.reduce((sum, team) => sum + team.completed, 0)
    );
    // Van Rijn's partners are four: too few to show.
    const small = companySees(
      viewOf(SAMPLE_ORGS[2], { ...SAMPLE_ORGS[2].seed, client: "leads" })
    ).teams.filter((team) => !team.shown);
    expect(small.map((team) => team.people)).toStrictEqual([4]);
  });
});

describe("what is kept of the interviews", () => {
  it("counts the agreed ones, the ones that stopped, and what can still be deleted", () => {
    const view = at(noordkade);
    const kept = keptOf(view);
    expect(kept.agreed + kept.halfway).toBe(view.interviews.length);
    expect(kept.deleted).toBe(0);
    expect(kept.deletable).toBeLessThanOrEqual(kept.agreed);
    // Months later nobody can ask any more.
    expect(keptOf(at(hartog)).deletable).toBeLessThan(
      keptOf(at(hartog)).agreed
    );
  });

  it("loses an interview that was deleted on request", () => {
    const view = at(noordkade);
    const one = view.interviews.find((interview) => interview.approved);
    const after = keptOf(at(noordkade, { deleted: one ? [one.id] : [] }));
    expect(after.agreed).toBe(keptOf(view).agreed - 1);
    expect(after.deleted).toBe(1);
  });
});

describe("the log of an organization", () => {
  it("is the newest first, and never ahead of the day", () => {
    for (const day of days) {
      const view = at(noordkade, { day });
      const log = logOf(view);
      const order = log.map((event) => event.on);
      expect(order).toStrictEqual(order.toSorted((a, b) => b.localeCompare(a)));
      for (const event of log.filter((each) => each.kind !== "conversation")) {
        expect(
          event.on.localeCompare(dateOn(noordkade, day))
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it("accounts for every interview and every lead", () => {
    const view = at(noordkade);
    const log = logOf(view);
    const talked = log.reduce(
      (sum, event) => sum + (event.kind === "talked" ? event.count : 0),
      0
    );
    expect(talked).toBe(
      view.interviews.filter(
        (interview) => interview.approved && interview.kind === "employee"
      ).length
    );
    expect(log.filter((event) => event.kind === "lead")).toHaveLength(
      view.teams.filter((team) => team.sent !== null).length
    );
    expect(log.filter((event) => event.kind === "told")).toStrictEqual([
      { kind: "told", on: noordkade.start, leads: noordkade.teams.length },
    ]);
    expect(log.at(-1)).toStrictEqual({
      kind: "conversation",
      on: "2026-09-16",
    });
  });

  it("has the go and the day the link closed, once they happened", () => {
    const log = logOf(at(hartog));
    expect(log.find((event) => event.kind === "go")?.on).toBe(
      dateOn(hartog, hartog.seed.opened ?? 0)
    );
    expect(log.find((event) => event.kind === "closed")).toMatchObject({
      on: dateOn(hartog, LISTEN_DAYS),
    });
    expect(
      logOf(at(noordkade)).some(
        (event) => event.kind === "go" || event.kind === "closed"
      )
    ).toBeFalsy();
  });

  it("tells a reminder sent by hand from one that went by itself", () => {
    const view = at(noordkade);
    const person = view.people.find((each) => each.mayRemind);
    const after = logOf(
      at(noordkade, { reminded: person ? { [person.person.id]: 8 } : {} })
    );
    expect(
      after.find((event) => event.kind === "reminded" && event.byHand)
    ).toMatchObject({ on: dateOn(noordkade, 8), count: 1 });
  });

  it("is empty before anything happened", () => {
    expect(
      logOf(
        viewOf(SAMPLE_ORGS[2], { ...SAMPLE_ORGS[2].seed, conversation: "none" })
      )
    ).toStrictEqual([]);
  });
});

describe("the parts of the platform", () => {
  it("start with everything on but what is parked, and take what Grasp switched", () => {
    const parts = partsOf(noordkade.seed);
    for (const part of PLATFORM_PARTS) {
      expect(parts[part]).toBe(!PARKED_PARTS.includes(part));
    }
    const switched = partsOf({
      ...noordkade.seed,
      parts: { policies: true, engines: false },
    });
    expect(switched).toMatchObject({
      policies: true,
      engines: false,
      chat: true,
      inbox: false,
    });
  });
});
