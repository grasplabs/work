import { describe, expect, it } from "vite-plus/test";

import {
  questionWords,
  QUESTION_WORDS,
  teamStates,
  VISION_FIELDS,
  VISION_OPEN,
} from "../../src/admin/interviews.ts";
import {
  dateOn,
  DELETE_DAYS,
  evidenceAt,
  interviewsAt,
  knownWorks,
  leadDay,
  mayInvite,
  membersTalked,
  peopleOf,
  READ_ONE_IN,
  REMIND_AFTER,
  STARTING_ORG_RULES,
  timelinesOf,
  transcriptOf,
  turnsOf,
  viewOf,
  visionOf,
  workingDaysAfter,
} from "../../src/admin/onboarding-admin.ts";
import type { Org, OrgState } from "../../src/admin/onboarding-admin.ts";
import {
  DEFAULT_THRESHOLD,
  LISTEN_DAYS,
  listeningAt,
  VISION_PEOPLE,
  WEIGHTS,
} from "../../src/admin/onboarding.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";
import { talkOf } from "./fixtures/onboarding-admin-talk.ts";

const [noordkade, veldkamp, vanrijn] = SAMPLE_ORGS;
const days = Array.from({ length: LISTEN_DAYS + 1 }, (_, day) => day);
/** Noordkade's work on day 8, under rules of its own. */
const withRules = (rules: Partial<typeof STARTING_ORG_RULES>) =>
  evidenceAt(noordkade, 8, { rules: { ...STARTING_ORG_RULES, ...rules } });
/** How many pieces of work are still being mapped. */
const mapping = (works: ReturnType<typeof withRules>) =>
  works.filter((work) => work.state === "mapping").length;
/** How many steps are described by enough people, over all the work. */
const steps = (works: ReturnType<typeof withRules>) =>
  works.reduce((sum, work) => sum + work.evidenced, 0);
/** Noordkade's invoice matching once the link has closed: the one people describe two ways without knowing why. */
const matching = (settled: string[]) =>
  evidenceAt(noordkade, LISTEN_DAYS, { settled }).find(
    (work) => work.id === "matching"
  );
/** An organization with everything in place and its team told, on `day`. */
const told = (
  org: Org,
  day: number,
  more: Partial<OrgState> = {}
): OrgState => ({
  ...org.seed,
  conversation: "read",
  research: "done",
  agreed: { processing: true, assessment: true, council: "yes" },
  client: "told",
  day,
  ...more,
});

describe("the people of an organization", () => {
  it("are as many as the sign-in says, each with a name of their own", () => {
    for (const org of SAMPLE_ORGS) {
      const people = peopleOf(org);
      expect(people).toHaveLength(
        org.teams.reduce((sum, team) => sum + team.people, 0)
      );
      expect(new Set(people.map((person) => person.name)).size).toBe(
        people.length
      );
      expect(new Set(people.map((person) => person.id)).size).toBe(
        people.length
      );
    }
  });

  it("have one lead a team, and everyone else one piece of their own team’s work", () => {
    for (const org of SAMPLE_ORGS) {
      for (const team of org.teams) {
        const mine = peopleOf(org).filter((person) => person.team === team.id);
        expect(
          mine.filter((person) => person.lead).map((person) => person.name)
        ).toStrictEqual([team.leader]);
        for (const person of mine.filter((each) => !each.lead)) {
          expect(org.works.find((work) => work.id === person.work)?.team).toBe(
            team.id
          );
        }
      }
    }
  });

  it("are the same every time", () => {
    expect(peopleOf(noordkade)).toBe(peopleOf(noordkade));
    expect(
      peopleOf({ ...noordkade }).map((person) => person.name)
    ).toStrictEqual(peopleOf(noordkade).map((person) => person.name));
  });
});

describe("who has talked by which day", () => {
  it("follows the same curve as the listening weeks the client sees", () => {
    for (const org of SAMPLE_ORGS) {
      for (const day of days) {
        const listening = listeningAt(day / LISTEN_DAYS, org.teams);
        for (const [index, team] of org.teams.entries()) {
          const talked =
            (leadDay(team, index) <= day && day > 0 ? 1 : 0) +
            membersTalked(team, index, day);
          // The first conversation was with the board: until more of them have talked, those count there.
          const before = team.id === "board" ? VISION_PEOPLE : 0;
          expect(Math.max(talked, before)).toBe(listening.heard[index]);
        }
      }
    }
  });

  it("counts everyone exactly once, and ends as the company’s own numbers do", () => {
    for (const org of SAMPLE_ORGS) {
      for (const day of days) {
        const view = viewOf(org, told(org, day));
        expect(
          Object.values(view.counts).reduce((sum, count) => sum + count, 0)
        ).toBe(view.people.length);
      }
      const end = viewOf(org, told(org, LISTEN_DAYS));
      const states = teamStates(1, org.teams);
      for (const [index, team] of end.teams.entries()) {
        expect(team.counts.completed).toBe(states[index]?.completed);
        expect(team.counts.incomplete).toBe(states[index]?.incomplete);
        expect(team.counts.expired).toBe(states[index]?.expired);
        expect(
          team.counts.waiting +
            team.counts.invited +
            team.counts.opened +
            team.counts.progress
        ).toBe(0);
      }
    }
  });

  it("never takes a finished interview back", () => {
    for (const org of SAMPLE_ORGS) {
      let before = 0;
      for (const day of days) {
        const view = viewOf(org, told(org, day));
        expect(view.counts.completed).toBeGreaterThanOrEqual(before);
        before = view.counts.completed;
      }
    }
  });

  it("sends a team its links the day its lead has talked, and nobody talks before they have one", () => {
    for (const org of SAMPLE_ORGS) {
      const lines = timelinesOf(org);
      for (const [index, team] of org.teams.entries()) {
        for (const person of peopleOf(org).filter(
          (each) => each.team === team.id
        )) {
          const timeline = lines.get(person.id);
          const sent = person.lead ? 0 : leadDay(team, index);
          expect(timeline?.sent).toBe(sent);
          // Whoever never opened or never finished is left out of the order by standing in for it.
          expect(timeline?.opened ?? sent).toBeGreaterThanOrEqual(sent);
          expect(timeline?.completed ?? LISTEN_DAYS).toBeGreaterThanOrEqual(
            timeline?.opened ?? sent
          );
          expect(timeline?.completed ?? LISTEN_DAYS).toBeLessThanOrEqual(
            LISTEN_DAYS
          );
        }
      }
    }
  });

  it("lets the sample’s own example, Lisa at customer service, finish hers", () => {
    const lisa = viewOf(noordkade, told(noordkade, LISTEN_DAYS)).people.find(
      (each) => each.person.name === "Lisa Hoekstra"
    );
    expect(lisa?.state).toBe("completed");
    expect(lisa?.person.work).toBe("tickets");
  });
});

describe("the reminder", () => {
  it("comes three working days after the link, never in a weekend", () => {
    expect(REMIND_AFTER).toBe(3);
    // Noordkade's leads get their link on a Thursday: Friday, Monday, Tuesday.
    expect(new Date(`${noordkade.start}T12:00:00Z`).getUTCDay()).toBe(4);
    expect(workingDaysAfter(noordkade, 0, REMIND_AFTER)).toBe(5);
    expect(dateOn(noordkade, 5)).toBe("2026-09-29");
  });

  it("goes only to whoever has not finished by then", () => {
    for (const org of SAMPLE_ORGS) {
      for (const [, timeline] of timelinesOf(org)) {
        if (timeline.reminded === null) {
          continue;
        }
        expect(timeline.reminded).toBe(
          workingDaysAfter(org, timeline.sent, REMIND_AFTER)
        );
        expect(
          timeline.completed === null || timeline.completed > timeline.reminded
        ).toBeTruthy();
      }
    }
  });
});

describe("before the team is told", () => {
  it("has no people until the sign-in is connected, and no leads until they are named", () => {
    const nothing = viewOf(noordkade, { ...noordkade.seed, client: "none" });
    expect(nothing.people).toHaveLength(0);
    expect(nothing.teams).toHaveLength(0);
    const directory = viewOf(noordkade, {
      ...noordkade.seed,
      client: "directory",
    });
    expect(directory.people).toHaveLength(170);
    expect(
      directory.teams.every(
        (team) => team.lead === null && team.next.kind === "lead-unknown"
      )
    ).toBeTruthy();
    const leads = viewOf(noordkade, { ...noordkade.seed, client: "leads" });
    expect(
      leads.teams.every(
        (team) =>
          team.lead?.person.lead === true && team.next.kind === "not-told"
      )
    ).toBeTruthy();
  });

  it("has nobody with a link, no interviews and no work to show", () => {
    const view = viewOf(veldkamp, veldkamp.seed);
    expect(view.told).toBeFalsy();
    expect(view.counts.waiting).toBe(view.people.length);
    expect(view.interviews).toHaveLength(0);
    expect(view.works).toHaveLength(0);
  });
});

describe("where each organization starts", () => {
  it("Noordkade is in the middle of its interviews", () => {
    const view = viewOf(noordkade, noordkade.seed);
    expect(view.stage).toBe("interviews");
    // Enough is known by now, so opening is in Grasp's hands as well.
    expect(view.stages).toMatchObject({
      conversation: "done",
      research: "done",
      agreed: "done",
      connected: "done",
      leads: "done",
      interviews: "now",
      open: "now",
    });
    expect(view.needs.map((need) => need.kind)).toStrictEqual([
      "go",
      "ask",
      "conflict",
      "read",
    ]);
  });

  it("Veldkamp waits for its works council", () => {
    const view = viewOf(veldkamp, veldkamp.seed);
    expect(mayInvite(veldkamp.seed.agreed)).toBeFalsy();
    expect(view.stage).toBe("agreed");
    expect(view.stages.agreed).toBe("waits");
    expect(view.needs).toContainEqual({ kind: "agreement", what: "council" });
  });

  it("Van Rijn has a first conversation nobody has read", () => {
    const view = viewOf(vanrijn, vanrijn.seed);
    expect(view.stage).toBe("conversation");
    expect(view.needs).toStrictEqual([{ kind: "transcript" }]);
    const read = viewOf(vanrijn, { ...vanrijn.seed, conversation: "read" });
    expect(read.needs[0]).toStrictEqual({
      kind: "ask",
      fields: ["success", "sensitivities"],
    });
    expect(read.stage).toBe("research");
  });
});

describe("what needs Grasp", () => {
  it("a lead who has not talked after the reminder, until they do", () => {
    const service = noordkade.teams.findIndex((team) => team.id === "service");
    const serviceTeam = noordkade.teams[service];
    if (serviceTeam === undefined) {
      throw new Error("Noordkade's sample has no customer service.");
    }
    const talks = leadDay(serviceTeam, service);
    const named = (day: number) =>
      viewOf(noordkade, told(noordkade, day)).needs.flatMap((need) =>
        need.kind === "lead" ? [need.team.id] : []
      );
    expect(named(4)).toStrictEqual([]);
    expect(named(5)).toStrictEqual(["service"]);
    expect(named(talks - 1)).toStrictEqual(["service"]);
    expect(named(talks)).toStrictEqual([]);
  });

  it("a quiet team in the last days, and a difference nobody can explain", () => {
    const late = viewOf(noordkade, told(noordkade, 12)).needs;
    expect(late).toContainEqual(
      expect.objectContaining({ kind: "quiet", left: 2 })
    );
    expect(
      late.some(
        (need) => need.kind === "blocked" && need.work.id === "matching"
      )
    ).toBeTruthy();
  });

  it("after the link has closed, the work heard from too few people", () => {
    const few = viewOf(noordkade, told(noordkade, LISTEN_DAYS)).needs.find(
      (need) => need.kind === "few"
    );
    expect(
      few?.kind === "few" && few.works.every((work) => work.state === "mapping")
    ).toBeTruthy();
  });

  it("every fifth interview, until someone has read it", () => {
    const view = viewOf(noordkade, told(noordkade, 8));
    const toRead = view.interviews.filter((interview) => interview.toRead);
    const finished = view.interviews.filter((interview) => interview.approved);
    expect(toRead).toHaveLength(Math.ceil(finished.length / READ_ONE_IN));
    expect(view.needs).toContainEqual({ kind: "read", count: toRead.length });
    const read = viewOf(
      noordkade,
      told(noordkade, 8, { read: toRead.map((interview) => interview.id) })
    );
    expect(read.needs.some((need) => need.kind === "read")).toBeFalsy();
  });
});

describe("how far a piece of work is known", () => {
  it("shows only once its team’s lead has named it, and never loses an interview", () => {
    for (const org of SAMPLE_ORGS) {
      const before = new Map<string, number>();
      for (const day of days) {
        for (const work of evidenceAt(org, day)) {
          const index = org.teams.findIndex((team) => team.id === work.team);
          const team = org.teams[index];
          if (team === undefined) {
            throw new Error(`${work.id} has no team at ${org.id}.`);
          }
          expect(leadDay(team, index)).toBeLessThanOrEqual(day);
          expect(work.approved).toBeGreaterThanOrEqual(
            before.get(work.id) ?? 0
          );
          expect(work.evidenced).toBeLessThanOrEqual(work.steps);
          expect(work.lastNew).toBeGreaterThanOrEqual(0);
          expect(work.lastNew).toBeLessThanOrEqual(1);
          before.set(work.id, work.approved);
        }
      }
    }
  });

  it("counts only interviews that were agreed to", () => {
    const view = viewOf(noordkade, told(noordkade, 9));
    for (const work of view.works) {
      expect(work.approved).toBe(
        view.interviews.filter(
          (interview) => interview.approved && interview.work?.id === work.id
        ).length
      );
    }
  });

  it("follows the organization’s own rules", () => {
    const at = withRules;
    // Asking for fewer interviews before a workflow is checked leaves fewer of them still being mapped.
    expect(mapping(at({ minInterviews: 3 }))).toBeLessThan(mapping(at({})));
    // Asking for more people per step leaves fewer steps described by enough of them.
    expect(steps(at({ people: 5 }))).toBeLessThan(steps(at({ people: 2 })));
    // A stricter stop keeps more of them open.
    expect(knownWorks(at({ stopShare: 0.01 }))).toBeLessThanOrEqual(
      knownWorks(at({ stopShare: 0.15 }))
    );
  });

  it("is blocked by a difference nobody can explain, until the owner settles it", () => {
    expect(matching([])).toMatchObject({
      state: "blocked",
      unexplained: 1,
      variants: 0,
      differs: true,
    });
    expect(matching(["matching"])).toMatchObject({
      state: "variants",
      unexplained: 0,
      variants: 1,
    });
  });

  it("counts what one person described once everyone who does the work has talked", () => {
    const small = evidenceAt(noordkade, LISTEN_DAYS).filter(
      (work) => work.everyone
    );
    expect(small.length).toBeGreaterThan(0);
    for (const work of small) {
      expect(["complete", "variants", "blocked", "saturating"]).toContain(
        work.state
      );
    }
    for (const work of small) {
      expect(work.split).toBeFalsy();
    }
  });

  it("a difference that depends on the case or the office is a second way, not a block", () => {
    const claims = evidenceAt(noordkade, LISTEN_DAYS).find(
      (work) => work.id === "claims"
    );
    expect(claims).toMatchObject({
      variants: 1,
      unexplained: 0,
      state: "variants",
    });
  });
});

describe("the interviews", () => {
  it("are the leads’ and everyone else’s, the newest first", () => {
    const interviews = interviewsAt(noordkade, 8);
    expect(
      interviews.filter((interview) => interview.kind === "lead")
    ).toHaveLength(9);
    expect(
      interviews.every(
        (interview, index) =>
          index === 0 || (interviews[index - 1]?.day ?? 0) >= interview.day
      )
    ).toBeTruthy();
    for (const interview of interviews.filter(
      (each) => each.kind === "employee"
    )) {
      expect(interview.work?.team).toBe(interview.person.team);
    }
  });

  it("write down exactly what the transcript shows, and mark only what was said", () => {
    for (const org of SAMPLE_ORGS) {
      for (const interview of interviewsAt(org, LISTEN_DAYS)) {
        const talk = talkOf(org, interview, "8 October");
        expect(talk.facts).toHaveLength(interview.facts);
        expect(talk.facts.filter((fact) => fact.out === true)).toHaveLength(
          interview.out
        );
        for (const line of talk.lines) {
          for (const mark of line.marks ?? []) {
            expect(line.text).toContain(mark.quote);
          }
        }
        expect(new Set(talk.facts.map((fact) => fact.id)).size).toBe(
          talk.facts.length
        );
      }
    }
  });

  it("keep to Stephen’s rules: an AI in his first sentence, one short question at a time", () => {
    for (const org of SAMPLE_ORGS) {
      for (const interview of interviewsAt(org, LISTEN_DAYS)) {
        const lines = talkOf(org, interview, "8 October").lines.filter(
          (line) => line.from === "stephen"
        );
        expect(lines[0]?.text.split(".")[0]).toContain("an AI");
        for (const line of lines) {
          expect(line.text.split("?").length - 1).toBeLessThanOrEqual(1);
        }
        for (const question of lines.filter((line) =>
          line.text.endsWith("?")
        )) {
          expect(questionWords(question.text)).toBeLessThanOrEqual(
            QUESTION_WORDS
          );
        }
      }
    }
  });

  it("that stopped end on the question that was not answered, and count for nothing yet", () => {
    const stopped = interviewsAt(noordkade, 8).filter(
      (interview) => !interview.approved
    );
    expect(stopped.length).toBeGreaterThan(0);
    for (const interview of stopped) {
      const talk = talkOf(noordkade, interview, "8 October");
      expect(talk.lines.at(-1)?.from).toBe("stephen");
      expect(talk.facts.every((fact) => fact.agreed !== true)).toBeTruthy();
      expect(interview.stoppedAt).not.toBeNull();
    }
  });

  it("fill in a good part of what one interview should bring", () => {
    const finished = interviewsAt(noordkade, LISTEN_DAYS).filter(
      (interview) => interview.approved && interview.kind === "employee"
    );
    const filled =
      finished.reduce((sum, interview) => sum + interview.filled.length, 0) /
      finished.length;
    expect(filled).toBeGreaterThan(9);
    expect(filled).toBeLessThanOrEqual(15);
  });
});

describe("the first conversation", () => {
  it("is a transcript of turns, each with a time and a role, never a name", () => {
    for (const org of SAMPLE_ORGS) {
      const turns = turnsOf(org.transcript);
      expect(turns.length).toBeGreaterThan(20);
      for (const turn of turns) {
        expect(turn.at).toMatch(/^\d{1,2}:\d{2}$/u);
        expect(turn.speaker).not.toBe("");
        expect(turn.text).not.toBe("");
      }
      const roster = new Set(peopleOf(org).map((person) => person.first));
      expect(turns.filter((turn) => roster.has(turn.speaker))).toStrictEqual(
        []
      );
    }
  });

  it("reads a transcript that was written out any other way without losing a word", () => {
    expect(
      turnsOf(
        "Director: We sell wood.\nAnd stone.\n\n(00:12) Consultant: To whom?\n00:15 - Director: Contractors: mostly."
      )
    ).toStrictEqual([
      { at: "", speaker: "Director", text: "We sell wood. And stone." },
      { at: "00:12", speaker: "Consultant", text: "To whom?" },
      { at: "00:15", speaker: "Director", text: "Contractors: mostly." },
    ]);
    expect(turnsOf("Just a note without anyone speaking.")).toStrictEqual([
      { at: "", speaker: "", text: "Just a note without anyone speaking." },
    ]);
  });

  it("was read by Stephen for what was really said: every quote stands in its transcript", () => {
    for (const org of SAMPLE_ORGS) {
      const said = org.transcript.toLowerCase();
      const reading = org.vision;
      expect(reading).not.toBeNull();
      for (const field of VISION_FIELDS) {
        const entry = reading?.fields[field];
        // A thing is in with the words it rests on, or it is on the list to ask: never both, never neither.
        expect(entry === undefined).toBe(reading?.ask[field] !== undefined);
        expect(said).toContain((entry?.quote ?? "").toLowerCase());
      }
    }
  });

  it("leaves open at Noordkade what the company’s own settings say it left open", () => {
    const vision = visionOf(noordkade, noordkade.seed);
    expect(
      VISION_FIELDS.filter((field) => !vision?.fields[field])
    ).toStrictEqual(VISION_OPEN);
  });

  it("is not there to go on until Stephen has read it", () => {
    expect(visionOf(vanrijn, vanrijn.seed)).toBeNull();
    expect(viewOf(vanrijn, vanrijn.seed).vision).toBeNull();
    expect(
      visionOf(vanrijn, { ...vanrijn.seed, conversation: "read" })?.fields
        .business?.quote
    ).toBe(
      "We do the annual accounts, the tax returns and the payroll for about six hundred small companies around Arnhem."
    );
  });

  it("takes what the sponsor answers afterwards, for what it left open only", () => {
    const answered = visionOf(vanrijn, {
      ...vanrijn.seed,
      conversation: "read",
      answers: {
        success: " A day a week back for each partner. ",
        business: "Something else",
      },
    });
    expect(answered?.fields.success).toStrictEqual({
      text: "A day a week back for each partner.",
      later: true,
    });
    expect(answered?.ask.success).toBeUndefined();
    expect(answered?.fields.business?.later).toBeUndefined();
    const view = viewOf(vanrijn, {
      ...vanrijn.seed,
      conversation: "read",
      answers: { success: "A day a week." },
    });
    expect(view.needs[0]).toStrictEqual({
      kind: "ask",
      fields: ["sensitivities"],
    });
  });

  it("is read again once it was brought in or changed here: the old reading was of other words", () => {
    const changed: OrgState = {
      ...noordkade.seed,
      transcript: "Director: We only do mortgages now.",
    };
    expect(transcriptOf(noordkade, changed)).toBe(
      "Director: We only do mortgages now."
    );
    expect(visionOf(noordkade, changed)).toBeNull();
    const reading = {
      fields: {
        business: {
          text: "Mortgages only.",
          quote: "We only do mortgages now.",
        },
      },
      ask: {},
      teams: [],
    };
    expect(
      visionOf(noordkade, { ...changed, reading })?.fields.business?.text
    ).toBe("Mortgages only.");
  });
});

/** Noordkade's customer service team, as it stands. */
const service = (state: OrgState) =>
  viewOf(noordkade, state).teams.find((team) => team.team.id === "service");

describe("the one reminder", () => {
  const day = 8;

  it("can go by hand to whoever has a link, has not finished and was not reminded yet", () => {
    const view = viewOf(noordkade, told(noordkade, day));
    for (const each of view.people) {
      const open =
        each.state === "invited" ||
        each.state === "opened" ||
        each.state === "incomplete";
      expect(each.mayRemind).toBe(open && each.reminded === null);
    }
    // Customer service got its links on day 7: nobody there was reminded yet.
    expect(
      service(told(noordkade, day))?.people.filter((each) => each.mayRemind)
        .length
    ).toBeGreaterThan(5);
  });

  it("sent by hand it shows as that, and does not go again by itself", () => {
    const before = service(told(noordkade, day));
    const ids =
      before?.people
        .filter((each) => each.mayRemind)
        .map((each) => each.person.id) ?? [];
    const reminded = Object.fromEntries(ids.map((id) => [id, day]));
    const after = service(told(noordkade, day, { reminded }));
    for (const each of after?.people.filter((one) =>
      ids.includes(one.person.id)
    ) ?? []) {
      expect(each).toMatchObject({
        reminded: day,
        byHand: true,
        mayRemind: false,
        last: { what: "reminded", day },
      });
    }
    // On the day it would have gone by itself, it is still the one from day 8.
    const later = service(told(noordkade, 13, { reminded }));
    for (const each of later?.people.filter((one) =>
      ids.includes(one.person.id)
    ) ?? []) {
      expect(each.reminded).toBe(day);
    }
  });

  it("is never sent once the link has closed", () => {
    expect(
      viewOf(noordkade, told(noordkade, LISTEN_DAYS)).people.some(
        (each) => each.mayRemind
      )
    ).toBeFalsy();
  });
});

describe("an interview deleted because the person asked", () => {
  it("is gone, with what only they said, and the workflow counts one interview less", () => {
    const view = viewOf(noordkade, told(noordkade, 10));
    const interview = view.interviews.find(
      (each) => each.approved && each.kind === "employee"
    );
    const id = interview?.id ?? "";
    const work = interview?.work?.id ?? "";
    const without = viewOf(noordkade, told(noordkade, 10, { deleted: [id] }));
    expect(without.interviews.some((each) => each.id === id)).toBeFalsy();
    expect(without.works.find((each) => each.id === work)?.approved).toBe(
      (view.works.find((each) => each.id === work)?.approved ?? 0) - 1
    );
    expect(
      without.people.find((each) => each.person.id === id)?.deleted
    ).toBeTruthy();
    expect(DELETE_DAYS).toBe(7);
  });
});

/** How much is known about Van Rijn, in percent, with `state` on top of where it starts. */
const knownAtVanRijn = (state: Partial<OrgState>) =>
  viewOf(vanrijn, { ...vanrijn.seed, ...state }).knowledge.percent;

describe("how much Grasp knows about an organization", () => {
  it("counts the same sources, with the same weights, as the company’s own onboarding", () => {
    const { knowledge } = viewOf(noordkade, noordkade.seed);
    expect(
      knowledge.sources.map((each) => [each.source, each.weight])
    ).toStrictEqual(Object.entries(WEIGHTS));
    expect(knowledge.sources.reduce((sum, each) => sum + each.weight, 0)).toBe(
      100
    );
    // Whole points only, so what the sources show always adds up to the percentage.
    expect(knowledge.sources.reduce((sum, each) => sum + each.points, 0)).toBe(
      knowledge.percent
    );
    for (const each of knowledge.sources) {
      expect(each.known).toBeGreaterThanOrEqual(0);
      expect(each.known).toBeLessThanOrEqual(1);
      expect(each.points).toBe(Math.floor(each.weight * each.known + 1e-9));
    }
  });

  it("starts at nothing, and every step adds its share", () => {
    const at = knownAtVanRijn;
    // Eight of the ten things were said: three quarters of the first share is the conversation, the rest the research.
    expect([
      at({}),
      at({ conversation: "read" }),
      at({ conversation: "read", research: "done" }),
    ]).toStrictEqual([
      0,
      Math.round(WEIGHTS.vision * 0.75 * 0.8),
      Math.round(WEIGHTS.vision * (0.75 * 0.8 + 0.25)),
    ]);
    const read: Partial<OrgState> = { conversation: "read", research: "done" };
    expect(at({ ...read, client: "directory" }) - at(read)).toBe(
      WEIGHTS.directory
    );
    expect(
      at({ ...read, client: "leads" }) - at({ ...read, client: "directory" })
    ).toBe(
      WEIGHTS.sources + WEIGHTS.documents + WEIGHTS.pulse + WEIGHTS.leadsKnown
    );
    // What the sponsor answers afterwards counts as said.
    expect(
      at({
        conversation: "read",
        answers: { success: "A day a week.", sensitivities: "Nothing." },
      })
    ).toBe(Math.round(WEIGHTS.vision * 0.75));
  });

  it("leaves out what the company skipped", () => {
    const pulse = viewOf(veldkamp, veldkamp.seed).knowledge.sources.find(
      (each) => each.source === "pulse"
    );
    expect(pulse?.known).toBe(0);
    expect(viewOf(veldkamp, veldkamp.seed).knowledge.percent).toBe(
      100 -
        WEIGHTS.pulse -
        WEIGHTS.leadsHeard -
        WEIGHTS.everyoneHeard -
        WEIGHTS.review
    );
  });

  it("never goes down as the interviews come in", () => {
    for (const org of SAMPLE_ORGS) {
      let before = 0;
      for (const day of days) {
        const { percent } = viewOf(org, told(org, day)).knowledge;
        expect(percent).toBeGreaterThanOrEqual(before);
        expect(percent).toBeLessThanOrEqual(100);
        before = percent;
      }
    }
  });
});

describe("Grasp opening for a company", () => {
  it("waits for Grasp’s go once enough is known, and says so first", () => {
    const view = viewOf(noordkade, noordkade.seed);
    expect(view.knowledge).toMatchObject({
      threshold: DEFAULT_THRESHOLD,
      ready: true,
      opened: null,
    });
    expect(view.knowledge.percent).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(view.needs[0]).toStrictEqual({
      kind: "go",
      percent: view.knowledge.percent,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(view.stages.open).toBe("now");
  });

  it("is not ready below the share it opens at, wherever Grasp sets that", () => {
    const early = viewOf(noordkade, told(noordkade, 4));
    expect(early.knowledge.ready).toBeFalsy();
    expect(early.stages.open).toBe("later");
    expect(early.needs.some((need) => need.kind === "go")).toBeFalsy();
    expect(
      viewOf(noordkade, told(noordkade, 4, { threshold: 70 })).knowledge.ready
    ).toBeTruthy();
    expect(
      viewOf(noordkade, { ...noordkade.seed, threshold: 90 }).knowledge.ready
    ).toBeFalsy();
  });

  it("is open from the day Grasp gave its go, and asks for nothing more", () => {
    const view = viewOf(noordkade, { ...noordkade.seed, opened: 8 });
    expect(view.stages.open).toBe("done");
    expect(view.knowledge.opened).toBe(8);
    expect(
      view.needs.some((need) => need.kind === "go" || need.kind === "short")
    ).toBeFalsy();
    // The interviews go on: it is the next step that is not done.
    expect(view.stage).toBe("interviews");
    expect(
      viewOf(noordkade, told(noordkade, LISTEN_DAYS, { opened: 8 })).stage
    ).toBe("open");
  });

  it("is Grasp’s to decide when the interviews end below the share it opens at", () => {
    const view = viewOf(
      noordkade,
      told(noordkade, LISTEN_DAYS, { threshold: 95 })
    );
    expect(view.knowledge.ready).toBeFalsy();
    expect(view.stages.open).toBe("now");
    expect(view.needs[0]).toStrictEqual({
      kind: "short",
      percent: view.knowledge.percent,
      threshold: 95,
    });
  });
});
