import { INTERVIEWERS } from "./interviewer.ts";
import type { Interviewer } from "./interviewer.ts";
import { MIN_GROUP, PHASES, RECORD_FIELDS } from "./interviews.ts";
import type { Phase } from "./interviews.ts";
import {
  dateOn,
  DELETE_DAYS,
  factsSaid,
  PARKED_PARTS,
  PLATFORM_PARTS,
  tellingOf,
  timelinesOf,
} from "./onboarding-admin.ts";
import type {
  Interview,
  MistakeKind,
  OrgState,
  OrgTeam,
  OrgView,
  PlatformPart,
  Telling,
  Work,
  WorkEvidence,
} from "./onboarding-admin.ts";
import { LISTEN_DAYS } from "./onboarding.ts";
import { present } from "./present.ts";

/**
 * What the admin shows beyond who talked: the record of one piece of work as its interviews add up
 * to it, how Stephen is doing at an organization, one person's two weeks, what the company itself
 * gets to see, what is kept of the interviews, and everything that happened there day by day. All
 * of it follows from the organization and the day, like the rest of the admin. Pure.
 */

const bare = (sentence: string) => sentence.replace(/[.!?]$/u, "");
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const range = (values: number[]): [number, number] => [
  Math.min(...values),
  Math.max(...values),
];

/** Something said about a piece of work, with how many of the people who talked said it. */
export interface Said {
  text: string;
  people: number;
}

/** How one of the people who talked told a step: as most do, the other way, or not at all. */
export type StepWay = "main" | "other" | "none";

/** One step of a piece of work, as the interviews have it. */
export interface StepRecord extends Said {
  /** How each interview told it, in the order of `interviews`. */
  ways: StepWay[];
  /** A document or a log describes it too. */
  documented: boolean;
  /** Enough people described it for it to count, under the organization's rules. */
  enough: boolean;
  /** The other way some describe it: how many told it so, and why it goes two ways, if anyone could say. */
  other:
    | (Said & {
        why: "condition" | "place" | "conflict";
        because?: string;
        explained: boolean;
      })
    | null;
}

/** The record of one piece of work: what its agreed interviews add up to. A number is always the range people gave. */
export interface WorkRecord {
  evidence: WorkEvidence;
  /** The interviews it rests on, in the order they came in. */
  interviews: Interview[];
  /** People who do the work and have not talked. */
  toAsk: number;
  /** How many people have to describe a step before it counts. */
  needed: number;
  starts: Said;
  steps: StepRecord[];
  waits: Said[];
  /** When it goes differently, with how many out of ten that is; none when nobody said. */
  differently: (Said & { outOfTen: number | null })[];
  decides: Said | null;
  own: Said | null;
  ai: Said | null;
  /** How many there are in a quiet and in a busy week or month: the lowest and the highest anyone said. */
  volume: {
    quiet: [number, number];
    busy: [number, number];
    people: number;
  } | null;
  /** How long one takes: the quickest and the longest anyone named, and what they call normal. */
  takes: {
    least: number;
    most: number;
    normal: [number, number];
    people: number;
  } | null;
  /** How many out of ten come in wrong. */
  wrong: { outOfTen: [number, number]; people: number } | null;
  right: Said;
  ask: Said | null;
  next: Said;
  term: (Said & { word: string }) | null;
  /** Real examples people shared. */
  examples: number;
}

/** How one person tells a step: the usual way, the other way, or not at all. */
const wayOf = (kept: ReadonlySet<string>, index: number): StepWay => {
  if (kept.has(`step:${index}`)) {
    return "main";
  }
  return kept.has(`step:${index}/other`) ? "other" : "none";
};

/** The record of the piece of work `id` as the organization's agreed interviews have it by now; none while its lead has not named it. */
export const recordOf = (view: OrgView, id: string): WorkRecord | null => {
  const evidence = view.works.find((work) => work.id === id);
  if (!evidence) {
    return null;
  }
  const { org, state } = view;
  const work: Work = evidence.work;
  // At a real organization, everyone who told about it counts, whatever they were asked about.
  const about = (interview: Interview) =>
    org.real
      ? org.real.told.has(`${interview.person.id}/${id}`)
      : interview.work?.id === id;
  const interviews = view.interviews
    .filter((interview) => interview.approved && about(interview))
    .toSorted((a, b) => a.day - b.day);
  // What each of them said and left in when it was read back.
  const tellings = interviews.map((interview) => {
    const telling = tellingOf(org, interview.person, work);
    return {
      telling,
      kept: new Set(
        factsSaid(telling, null).filter((fact) => !telling.out.includes(fact))
      ),
    };
  });
  const said = (fact: string) =>
    tellings.filter((each) => each.kept.has(fact)).length;
  // What each of them gave for a number, for the ones who gave it and left it in.
  const numbers = <Value>(
    fact: string,
    of: (telling: Telling) => Value | null
  ): Value[] =>
    tellings.flatMap((each) => {
      const value = each.kept.has(fact) ? of(each.telling) : null;
      return value === null ? [] : [value];
    });
  const needed = evidence.everyone
    ? 1
    : Math.max(1, Math.min(state.rules.people, evidence.doers));
  const { differs } = work;
  const volumes = numbers("volume", (telling) => telling.volume);
  const times = numbers("takes", (telling) => telling.takes);
  const wrongs = numbers("wrong", (telling) => telling.wrong);
  const one = (text: string | undefined, fact: string): Said | null =>
    text === undefined ? null : { text, people: said(fact) };
  return {
    evidence,
    interviews,
    toAsk: evidence.doers - evidence.approved,
    needed,
    starts: { text: work.starts, people: said("start") },
    steps: work.steps.map((text, index) => {
      const ways = tellings.map((each) => wayOf(each.kept, index));
      const otherWay = ways.filter((way) => way === "other").length;
      const people = ways.filter((way) => way !== "none").length;
      const documented = (work.documented ?? []).includes(index);
      return {
        text,
        people,
        ways,
        documented,
        enough:
          people >= needed ||
          (people >= 1 && people >= needed - 1 && documented),
        other:
          differs && differs.step === index && otherWay > 0
            ? {
                text: differs.other,
                people: otherWay,
                why: differs.why,
                because: differs.because,
                explained:
                  differs.why !== "conflict" || state.settled.includes(work.id),
              }
            : null,
      };
    }),
    waits: (work.waits ?? []).map((text, index) => ({
      text,
      people: said(`wait:${index}`),
    })),
    differently: (work.differently ?? []).map(
      ([when, then, outOfTen], index) => ({
        text: `If ${when}, ${lower(bare(then))}.`,
        outOfTen,
        people: said(`differently:${index}`),
      })
    ),
    decides: one(work.decides, "decides"),
    own: one(work.own, "own"),
    ai: one(work.ai, "ai"),
    volume:
      volumes.length === 0
        ? null
        : {
            quiet: range(volumes.map((each) => each[0])),
            busy: range(volumes.map((each) => each[1])),
            people: volumes.length,
          },
    takes:
      times.length === 0
        ? null
        : {
            least: Math.min(...times.map((each) => each[0])),
            most: Math.max(...times.map((each) => each[2])),
            normal: range(times.map((each) => each[1])),
            people: times.length,
          },
    wrong:
      wrongs.length === 0
        ? null
        : { outOfTen: range(wrongs), people: wrongs.length },
    right: { text: work.right, people: said("right") },
    ask:
      work.ask === undefined
        ? null
        : { text: `Stop and ask ${work.ask}.`, people: said("ask") },
    next: { text: upper(work.next), people: said("next") },
    term: work.term
      ? { word: work.term[0], text: work.term[1], people: said("term") }
      : null,
    examples: said("example"),
  };
};

/** How Stephen is doing at one organization, over the interviews people agreed to. */
export interface StephenStats {
  /** Every interview he held that was agreed to, the leads' too. */
  held: number;
  /** The minutes he was in an interview, the ones that stopped halfway too; of the ones whose length is known. */
  minutes: number;
  /** The share of the agreed interviews that went by voice, 0 to 1; the rest were typed. */
  byVoice: number;
  /** Interviews with the people who do the work, agreed to: what the shares below are taken over. */
  interviews: number;
  /** The share of what an interview should bring that it brought, 0 to 1. */
  filled: number;
  /** The share of what he wrote down that people left in, 0 to 1. */
  approved: number;
  /** Questions left over, per interview. */
  followUps: number;
  /** Mistakes of his own, per interview. */
  mistakes: number;
  /** How many interviews stopped halfway, and where, by part. */
  stopped: number;
  stops: Record<Phase, number>;
  /** His mistakes by kind. */
  kinds: Record<MistakeKind, number>;
  /** Interviews with more than one mistake: worth reading. */
  look: Interview[];
  /** His mistakes are scored: where no review runs over the interviews, there are none to show. */
  reviewed: boolean;
  /** How many of the people who started finished: agreed to what was read back. */
  started: number;
  /** What the people who talked to him said of it, from 1 to 5: how many said so, the average, and how many gave each. */
  rating: { count: number; average: number; by: Record<number, number> };
  /** Who people chose to talk with, in the order they are offered: how many each, and what the ones who said so thought of it. */
  chose: {
    interviewer: Interviewer;
    count: number;
    rated: number;
    average: number;
  }[];
  /** How long the agreed interviews took, in minutes: the leads' and everyone else's, on average. */
  length: { lead: number; employee: number };
  /** How many agreed interviews took how long: by minutes, in steps. */
  lengths: { upTo: number | null; count: number }[];
}

/** The steps the lengths of interviews are counted in, in minutes: up to and with each, and everything longer. */
const LENGTH_STEPS = [10, 15, 20, 30];

/** What the people who said so thought of their interview. */
const ratingsOf = (finished: Interview[]): StephenStats["rating"] => {
  const given = finished.flatMap((interview) =>
    interview.rating === null ? [] : [interview.rating]
  );
  const by: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rating of given) {
    by[rating] = (by[rating] ?? 0) + 1;
  }
  return {
    count: given.length,
    average:
      given.length === 0
        ? 0
        : given.reduce((sum, rating) => sum + rating, 0) / given.length,
    by,
  };
};

/** What interviews come to on average; nothing over no interviews. */
const average = (of: (interview: Interview) => number, over: Interview[]) =>
  over.length === 0
    ? 0
    : over.reduce((sum, interview) => sum + of(interview), 0) / over.length;

/** How long an interview took, of one whose length is known. */
const minutesOf = (interview: Interview) => interview.minutes ?? 0;

export const stephenOf = (view: OrgView): StephenStats => {
  const finished = view.interviews.filter((interview) => interview.approved);
  // Lengths are counted over the interviews whose length is known.
  const timed = finished.filter((interview) => interview.minutes !== null);
  const employees = finished.filter(
    (interview) => interview.kind === "employee"
  );
  const written = employees.reduce(
    (sum, interview) => sum + interview.facts,
    0
  );
  // SAFETY: one entry for every phase.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const stops = Object.fromEntries(PHASES.map((phase) => [phase, 0])) as Record<
    Phase,
    number
  >;
  const halfway = view.interviews.filter((interview) => !interview.approved);
  for (const interview of halfway) {
    if (interview.stoppedAt) {
      stops[interview.stoppedAt] += 1;
    }
  }
  const kinds: Record<MistakeKind, number> = {
    formulation: 0,
    order: 0,
    omission: 0,
    communication: 0,
    behaviour: 0,
    interaction: 0,
    planning: 0,
  };
  for (const interview of finished) {
    for (const kind of interview.kinds) {
      kinds[kind] += 1;
    }
  }
  return {
    held: finished.length,
    minutes: view.interviews.reduce(
      (sum, interview) => sum + minutesOf(interview),
      0
    ),
    byVoice: average((interview) => (interview.typed ? 0 : 1), finished),
    interviews: employees.length,
    filled: average(
      (interview) => interview.filled.length / RECORD_FIELDS.length,
      employees
    ),
    approved:
      written === 0
        ? 0
        : (written -
            employees.reduce((sum, interview) => sum + interview.out, 0)) /
          written,
    followUps: average((interview) => interview.followUps, employees),
    mistakes: average((interview) => interview.mistakes, finished),
    stopped: halfway.length,
    stops,
    kinds,
    look: finished.filter((interview) => interview.mistakes > 1),
    reviewed: view.org.real === undefined,
    started: view.interviews.length,
    rating: ratingsOf(finished),
    chose: INTERVIEWERS.map((interviewer) => {
      const theirs = view.interviews.filter(
        (interview) => interview.interviewer === interviewer
      );
      const rating = ratingsOf(
        theirs.filter((interview) => interview.approved)
      );
      return {
        interviewer,
        count: theirs.length,
        rated: rating.count,
        average: rating.average,
      };
    }),
    length: {
      lead: average(
        minutesOf,
        timed.filter((interview) => interview.kind === "lead")
      ),
      employee: average(
        minutesOf,
        timed.filter((interview) => interview.kind === "employee")
      ),
    },
    lengths: [...LENGTH_STEPS, null].map((upTo, index) => {
      const from = index === 0 ? 0 : (LENGTH_STEPS[index - 1] ?? 0);
      return {
        upTo,
        count: timed.filter(
          (interview) =>
            minutesOf(interview) > from &&
            (upTo === null || minutesOf(interview) <= upTo)
        ).length,
      };
    }),
  };
};

/** Something that happened with one person's link. */
export type PersonEvent = { day: number } & (
  | { what: "sent" | "opened" | "completed" | "expired" }
  | { what: "reminded"; byHand: boolean }
  | { what: "stopped"; phase: Phase }
);

/** One person's two weeks so far, in the order things happened; nothing before the team is told. */
export const personLog = (view: OrgView, id: string): PersonEvent[] => {
  const person = view.people.find((each) => each.person.id === id);
  const timeline = timelinesOf(view.org).get(id);
  if (!view.told || !person || !timeline) {
    return [];
  }
  const events: PersonEvent[] = [];
  const by = (day: number | null): day is number =>
    day !== null && day <= view.day;
  if (by(timeline.sent)) {
    events.push({ what: "sent", day: timeline.sent });
  }
  if (by(timeline.opened)) {
    events.push({ what: "opened", day: timeline.opened });
  }
  if (timeline.stopped && by(timeline.stopped.day)) {
    events.push({
      what: "stopped",
      day: timeline.stopped.day,
      phase: timeline.stopped.phase,
    });
  }
  if (person.reminded !== null) {
    events.push({
      what: "reminded",
      day: person.reminded,
      byHand: person.byHand,
    });
  }
  if (by(timeline.completed)) {
    events.push({ what: "completed", day: timeline.completed });
  } else if (view.closed) {
    events.push({ what: "expired", day: LISTEN_DAYS });
  }
  // Of what happened on the same day, in the order it can happen.
  const order: PersonEvent["what"][] = [
    "sent",
    "opened",
    "stopped",
    "reminded",
    "completed",
    "expired",
  ];
  return events.toSorted(
    (a, b) => a.day - b.day || order.indexOf(a.what) - order.indexOf(b.what)
  );
};

/** One team as the company's own admin sees it: numbers, and only for a team where five or more are asked. */
export interface CompanyTeam {
  team: OrgTeam;
  people: number;
  /** Big enough to show: where fewer are asked to talk, the team shows no numbers, so nobody in it can be picked out. */
  shown: boolean;
  completed: number;
  stopped: number;
}

/**
 * What the company's own admin sees of the interviews: numbers per team, and for everyone the
 * teams that show theirs, never a name or anyone's words. A team shows its numbers once enough of
 * it is asked to talk, as core shows the company its progress (core's `progressOf`): someone away
 * is not asked, and a team too small to show adds nothing to everyone's numbers, which would give
 * its own away.
 */
export const companySees = (
  view: OrgView
): {
  teams: CompanyTeam[];
  people: number;
  completed: number;
  stopped: number;
} => {
  // Only the teams that take part: a team that is left out has nothing to count.
  const teams = view.teams
    .filter((team) => !team.off)
    .map((team): CompanyTeam => ({
      team: team.team,
      people: team.people.length,
      shown: team.asked >= MIN_GROUP,
      completed: team.counts.completed,
      stopped: team.counts.incomplete,
    }));
  const shown = teams.filter((team) => team.shown);
  const sum = (of: (team: CompanyTeam) => number): number =>
    shown.reduce((total, team) => total + of(team), 0);
  return {
    teams,
    people: sum((team) => team.people),
    completed: sum((team) => team.completed),
    stopped: sum((team) => team.stopped),
  };
};

/** What Grasp keeps of the interviews at an organization, and what can still be taken back. */
export interface Kept {
  /** Interviews agreed to: their words are kept, and what they said counts. */
  agreed: number;
  /** Interviews that stopped halfway: kept so the link carries on, and counting for nothing. */
  halfway: number;
  /** Interviews deleted because the person asked. */
  deleted: number;
  /** Agreed interviews whose person can still ask for them to be deleted. */
  deletable: number;
}

/**
 * What is kept of the interviews on `asOf`, the day the view is counted up
 * to (`asOf` in admin-usage.ts): once the two weeks close, the view's day
 * stops, but the days a person has to ask for a deletion don't.
 */
export const keptOf = (view: OrgView, asOf: string): Kept => {
  const agreed = view.interviews.filter((interview) => interview.approved);
  return {
    agreed: agreed.length,
    halfway: view.interviews.length - agreed.length,
    deleted: view.state.deleted.length,
    deletable: agreed.filter(
      (interview) => dateOn(view.org, interview.day + DELETE_DAYS) >= asOf
    ).length,
  };
};

/** Something that happened at an organization, on a day. */
export type LogEvent = { on: string } & (
  | { kind: "conversation" }
  /** The company told its team: the leads got their links. */
  | { kind: "told"; leads: number }
  /** A lead talked, and their team got its links. */
  | { kind: "lead"; team: OrgTeam; lead: string; links: number }
  | { kind: "reminded"; count: number; byHand: boolean }
  /** Interviews people agreed to that day, and ones that stopped halfway. */
  | { kind: "talked"; count: number; stopped: number }
  | { kind: "go" }
  | { kind: "closed"; talked: number; people: number }
);

/** Everything that happened at an organization so far, the newest first. */
export const logOf = (view: OrgView): LogEvent[] => {
  const { org } = view;
  const events: (LogEvent & { order: number })[] = [];
  const on = (day: number) => dateOn(org, day);
  if (
    view.state.conversation !== "none" &&
    view.state.transcript === null &&
    present(org.vision?.on)
  ) {
    events.push({ kind: "conversation", on: org.vision.on, order: 0 });
  }
  if (view.told) {
    const taking = view.teams.filter((team) => !team.off);
    events.push({ kind: "told", on: on(0), leads: taking.length, order: 1 });
    for (const team of taking) {
      if (team.sent !== null && team.lead) {
        events.push({
          kind: "lead",
          on: on(team.sent),
          team: team.team,
          lead: team.lead.person.name,
          links: team.people.length - 1,
          order: 2,
        });
      }
    }
    const days = Array.from({ length: view.day + 1 }, (_, day) => day);
    for (const day of days) {
      for (const byHand of [false, true]) {
        const count = view.people.filter(
          (each) => each.reminded === day && each.byHand === byHand
        ).length;
        if (count > 0) {
          events.push({
            kind: "reminded",
            on: on(day),
            count,
            byHand,
            order: 3,
          });
        }
      }
      const count = view.interviews.filter(
        (interview) =>
          interview.approved &&
          interview.kind === "employee" &&
          interview.day === day
      ).length;
      const stopped = view.interviews.filter(
        (interview) => !interview.approved && interview.day === day
      ).length;
      if (count + stopped > 0) {
        events.push({ kind: "talked", on: on(day), count, stopped, order: 4 });
      }
    }
    if (view.knowledge.opened !== null && view.knowledge.opened <= view.day) {
      events.push({ kind: "go", on: on(view.knowledge.opened), order: 5 });
    }
    if (view.closed) {
      events.push({
        kind: "closed",
        on: on(LISTEN_DAYS),
        talked: view.counts.completed,
        people: view.asked,
        order: 6,
      });
    }
  }
  return events
    .toSorted((a, b) => b.on.localeCompare(a.on) || b.order - a.order)
    .map(({ order: _order, ...event }) => event);
};

/** Which parts of the platform the company has: what Grasp switched, and otherwise everything but what is parked. */
export const partsOf = (state: OrgState): Record<PlatformPart, boolean> =>
  // SAFETY: one entry for every part of the platform.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  Object.fromEntries(
    PLATFORM_PARTS.map((part) => [
      part,
      state.parts[part] ?? !PARKED_PARTS.includes(part),
    ])
  ) as Record<PlatformPart, boolean>;
