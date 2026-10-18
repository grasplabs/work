import { addMonths } from "./admin-account.ts";
import { KEPT_SHARE, PRICES } from "./admin-usage.ts";
import type { Model } from "./admin-usage.ts";
import { interviewerOf } from "./interviewer.ts";
import { PHASES } from "./interviews.ts";
import type { Phase } from "./interviews.ts";
import {
  filledBy,
  NOTHING_BY_HAND,
  STARTING_ORG_RULES,
} from "./onboarding-admin.ts";
import type {
  ClientStep,
  Interview,
  Org,
  OrgState,
  OrgTeam,
  Person,
  RealHappened,
  Telling,
  Timeline,
  Work,
} from "./onboarding-admin.ts";
import { daysBetween, METER_PURPOSES, PLAN_DAYS } from "./org-record.ts";
import type {
  DrawnWork,
  HeldInterview,
  MeterDay,
  StaffSnapshot,
  WorkRecord,
} from "./org-record.ts";
import { present } from "./present.ts";

/**
 * A real organization, as the Worker keeps it (`StaffSnapshot`), in the shape Grasp's admin reads
 * every organization in (`Org`, `OrgState`): its teams and people from its roster, its work from
 * what the leads named and the interviews drew, and what really happened in days since its
 * interviews started. So every section of the admin works the same for a real organization as for
 * a sample, and nothing in it is played. Pure.
 */

const first = (name: string) => name.split(" ")[0] ?? name;
/** A name as a title starts: the drawing names work as people say it, in small letters. */
const capital = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The middle of some numbers; none for none. */
const middle = (values: number[]): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

/** A term as a piece of work keeps it: the word, and what it means. */
const termOf = (term: { word: string; meaning: string }): [string, string] => [
  term.word,
  term.meaning,
];

/** A piece of work as the admin keeps one: what was drawn, and the middle of what people said for the numbers the admin works out. */
// oxlint-disable-next-line complexity -- ported as the prototype has it, one optional part of a drawing after another; org-adapter.test.ts pins it
export const workOf = (record: WorkRecord): Work => {
  const drawn: DrawnWork | null = record.drawn;
  const told = Object.values(drawn?.told ?? {});
  const volumes = told.flatMap((each) => (each.volume ? [each.volume] : []));
  const takes = told.flatMap((each) => (each.takes ? [each.takes] : []));
  const wrongs = told.flatMap((each) =>
    each.wrong === null ? [] : [each.wrong]
  );
  const quiet = middle(volumes.map((each) => each[0])) ?? 0;
  const busy = middle(volumes.map((each) => each[1])) ?? quiet;
  const normal = middle(takes.map((each) => each[1])) ?? 0;
  return {
    id: record.id,
    team: record.team,
    name: capital(record.name),
    item: record.item,
    share: record.share,
    starts: drawn?.starts ?? "",
    steps: drawn?.steps.map((step) => step.text) ?? [],
    documented:
      drawn?.steps.flatMap((step, index) => (step.documented ? [index] : [])) ??
      [],
    waits: drawn?.waits ?? [],
    differently:
      drawn?.differently.map((each): [string, string, number | null] => [
        each.when,
        each.does,
        each.outOfTen,
      ]) ?? [],
    ...(present(drawn?.decides) ? { decides: drawn.decides } : {}),
    ...(present(drawn?.own) ? { own: drawn.own } : {}),
    ...(present(drawn?.ai) ? { ai: drawn.ai } : {}),
    volume: [quiet, Math.max(busy, quiet)],
    ...(drawn?.per === "month" ? { per: "month" as const } : {}),
    takes: [
      Math.min(normal, ...takes.map((each) => each[0])),
      normal,
      Math.max(normal, ...takes.map((each) => each[2])),
    ],
    ...(drawn?.unit === "hours" ? { unit: "hours" as const } : {}),
    wrong: middle(wrongs) ?? 0,
    right: drawn?.right ?? "",
    ...(present(drawn?.ask) ? { ask: drawn.ask } : {}),
    next: drawn?.next ?? "",
    ...(drawn?.term ? { term: termOf(drawn.term) } : {}),
    ...(drawn?.differs
      ? {
          differs: {
            step: drawn.differs.step,
            other: drawn.differs.other,
            why: drawn.differs.why,
            ...(present(drawn.differs.because)
              ? { because: drawn.differs.because }
              : {}),
          },
        }
      : {}),
    ...(record.from === "grasp" ? { found: true as const } : {}),
  };
};

/** The model a call was made to, by the name its maker gives it: one the admin has no price for is another. */
const modelOf = (name: string): Model => {
  if (name === "voice") {
    return "voice";
  }
  return (
    (["opus", "sonnet", "haiku"] as const).find((model) =>
      name.includes(model)
    ) ?? "other"
  );
};

/**
 * What the Worker counted, as the admin counts use: tokens read (new and kept together) and
 * written, minutes spoken, and what that cost at the admin's prices, with what the model had kept
 * of an earlier call at a tenth. A model with no price is counted as another, its spend unknown.
 */
export const meteredOf = (usage: MeterDay[]): RealHappened["metered"] =>
  usage.flatMap((day) =>
    METER_PURPOSES.flatMap((purpose) =>
      Object.entries(day.use[purpose] ?? {}).flatMap(([name, took]) => {
        const model = modelOf(name);
        const price = PRICES[model];
        const spoken = took.seconds / 60;
        const spend =
          (took.tokensIn / 1e6) * price.tokensIn +
          (took.kept / 1e6) * price.tokensIn * KEPT_SHARE +
          (took.tokensOut / 1e6) * price.tokensOut +
          spoken * price.minute;
        return [
          {
            day: day.day,
            purpose,
            model,
            use: {
              tokensIn: took.tokensIn + took.kept,
              tokensOut: took.tokensOut,
              spoken,
              heard: 0,
              spend,
            },
          },
        ];
      })
    )
  );

/** How far the company's own admin is with their steps, as the admin counts it. */
const clientStepOf = (snapshot: StaffSnapshot): ClientStep => {
  if (snapshot.plan) {
    return "told";
  }
  if (!snapshot.roster) {
    return "none";
  }
  const leadsNamed = snapshot.roster.teams
    .filter((team) => !team.off)
    .every((team) => team.lead !== null);
  return leadsNamed || snapshot.client.reached >= 7 ? "leads" : "directory";
};

/**
 * Every fact written down in an interview, as a sample interview counts them, and how many of those
 * the person took out again. Where only the numbers came, they stand for the facts: their words
 * stay where they were said.
 */
const factsOf = (interview: HeldInterview): { facts: number; out: number } =>
  interview.counted ?? {
    facts: interview.progress.facts.length,
    out: interview.progress.facts.filter((fact) => fact.out === true).length,
  };

/** The day something happened, as the number of days since the interviews started. */
const dayAt = (start: string, time: string | null | undefined) =>
  present(time) ? Math.max(0, daysBetween(start, time)) : null;

/** A real organization as the admin reads it. */
// oxlint-disable-next-line complexity -- ported as the prototype has it, the whole snapshot read in one place; org-adapter.test.ts pins it
export const orgOfSnapshot = (snapshot: StaffSnapshot): Org => {
  const { profile, roster, plan, client } = snapshot;
  const start = plan?.start ?? profile.created.slice(0, 10);
  // Its interviews run as long as its plan says, from five days to six weeks; one not planned yet
  // has the usual length a plan starts from.
  const days = plan?.days ?? PLAN_DAYS;
  const today = Math.min(Math.max(daysBetween(start, snapshot.now), 0), days);
  const people = roster?.people ?? [];
  const teams: OrgTeam[] = (roster?.teams ?? []).map((team) => {
    const lead = people.find((person) => person.id === team.lead);
    return {
      id: team.id,
      name: team.name,
      people: people.filter((person) => person.team === team.id).length,
      pace: 1,
      ...(lead ? { lead: first(lead.name) } : {}),
      leader: lead?.name ?? "",
      does: team.does,
    };
  });
  const works = snapshot.works.map(workOf);
  const everyone: Person[] = (roster?.teams ?? []).flatMap((team) => {
    const mine = people.filter((person) => person.team === team.id);
    const ordered = [
      ...mine.filter((person) => person.id === team.lead),
      ...mine.filter((person) => person.id !== team.lead),
    ];
    return ordered.map((person): Person => ({
      id: person.id,
      name: person.name,
      first: first(person.name),
      team: team.id,
      lead: person.id === team.lead,
      work: person.id === team.lead ? null : person.work,
    }));
  });
  const held = new Map(
    snapshot.interviews.map((interview) => [interview.person, interview])
  );
  const links = new Map(snapshot.links.map((link) => [link.person, link]));

  const timelines = new Map<string, Timeline>();
  for (const [order, person] of everyone.entries()) {
    const link = links.get(person.id);
    const interview = held.get(person.id);
    if (!present(link?.sent)) {
      continue;
    }
    const stopped =
      interview &&
      !present(interview.completed) &&
      interview.progress.startedAt !== null
        ? {
            day: dayAt(start, interview.stopped?.at ?? interview.updated) ?? 0,
            phase: interview.stopped?.phase ?? interview.progress.phase,
          }
        : null;
    timelines.set(person.id, {
      sent: dayAt(start, link.sent) ?? 0,
      opened: dayAt(start, link.opened),
      stopped,
      completed: dayAt(start, interview?.completed),
      reminded: dayAt(start, link.reminded),
      order,
    });
  }

  const told = new Map<string, Telling>();
  for (const record of snapshot.works) {
    for (const [person, telling] of Object.entries(record.drawn?.told ?? {})) {
      told.set(`${person}/${record.id}`, telling);
    }
  }

  // A team's own links went out the day its lead finished, or the day its first member's did.
  const sent = new Map<string, number>();
  for (const team of roster?.teams ?? []) {
    const lead = present(team.lead) ? held.get(team.lead) : undefined;
    const members = people.filter(
      (person) => person.team === team.id && person.id !== team.lead
    );
    const out = members.flatMap((person) =>
      present(links.get(person.id)?.sent)
        ? [dayAt(start, links.get(person.id)?.sent) ?? 0]
        : []
    );
    let day: number | null = null;
    if (present(lead?.completed)) {
      day = dayAt(start, lead.completed);
    } else if (out.length > 0) {
      day = Math.min(...out);
    }
    if (day !== null) {
      sent.set(team.id, day);
    }
  }

  // A team's lead is heard the day they agreed to their interview. Links that went out without
  // them, once the team had waited long enough, are not the lead talking; only a team with no lead
  // to wait for (none named, or away) counts from the day its links went out.
  const heard = new Map<string, number>();
  for (const team of roster?.teams ?? []) {
    const lead = people.find((person) => person.id === team.lead);
    const day =
      lead && !lead.away
        ? dayAt(start, held.get(lead.id)?.completed)
        : (sent.get(team.id) ?? null);
    if (day !== null) {
      heard.set(team.id, day);
    }
  }

  const talking = new Set(
    snapshot.links
      .filter((link) => link.state === "progress")
      .map((link) => link.person)
  );
  const interviews: Interview[] = everyone.flatMap((person): Interview[] => {
    const interview = held.get(person.id);
    if (!interview || interview.progress.startedAt === null) {
      return [];
    }
    const approved = interview.completed !== null;
    const work = works.find((each) => each.id === person.work) ?? null;
    const telling = work ? (told.get(`${person.id}/${work.id}`) ?? null) : null;
    let stoppedAt: Phase | null = null;
    if (!approved) {
      stoppedAt = PHASES.includes(interview.progress.phase)
        ? interview.progress.phase
        : "story";
    }
    const ended = interview.completed ?? interview.updated;
    // From the start to the end is how long they talked only in one go: once they left and came
    // back, the time away is in it too, and the snapshot does not say how long they talked.
    const cameBack =
      interview.stopped !== null &&
      Date.parse(ended) > Date.parse(interview.stopped.at);
    return [
      {
        id: person.id,
        person,
        // As it was held: a lead changed since leaves an interview as it was.
        kind: interview.kind,
        work,
        day: dayAt(start, ended) ?? today,
        approved,
        stoppedAt,
        minutes: cameBack
          ? null
          : Math.max(
              1,
              Math.round(
                (Date.parse(ended) -
                  (interview.progress.startedAt ?? Date.parse(ended))) /
                  60_000
              )
            ),
        typed: interview.progress.mode === "type",
        telling,
        filled: telling ? filledBy(telling) : [],
        ...factsOf(interview),
        mistakes: 0,
        kinds: [],
        followUps: work
          ? (snapshot.works.find((each) => each.id === work.id)?.drawn?.open
              .length ?? 0)
          : 0,
        toRead: false,
        rating: interview.progress.rating ?? null,
        interviewer: interviewerOf(interview.progress.interviewer),
      },
    ];
  });
  // One in five of the finished ones is read by a person at Grasp, in the order they came in.
  for (const [index, interview] of interviews
    .filter((each) => each.approved)
    .toSorted((a, b) => a.day - b.day)
    .entries()) {
    interview.toRead = index % 5 === 0;
  }

  const real: RealHappened = {
    people: everyone,
    timelines,
    told,
    interviews: interviews.toSorted((a, b) => b.day - a.day),
    sent,
    heard,
    talking,
    // Only what was said here: an interview that came as numbers has no transcript to show.
    transcripts: new Map(
      snapshot.interviews
        .filter((interview) => interview.counted === undefined)
        .map((interview) => [
          interview.person,
          { lines: interview.progress.lines, facts: interview.progress.facts },
        ])
    ),
    links: new Map(snapshot.links.map((link) => [link.person, link.code])),
    clientCode: snapshot.clientCode,
    test: profile.test,
    doers: new Map(snapshot.works.map((work) => [work.id, work.doers])),
    tools: new Map(
      snapshot.works.map((work) => [
        work.id,
        [
          ...new Set(
            (work.drawn?.steps ?? [])
              .map((step) => step.tool.trim())
              .filter(Boolean)
          ),
        ],
      ])
    ),
    // A snapshot from before the Worker counted has none.
    metered: meteredOf(snapshot.usage ?? []),
    ...(snapshot.known === undefined ? {} : { known: snapshot.known }),
    ...(snapshot.paused === undefined ? {} : { paused: snapshot.paused }),
    ...(snapshot.unknown === undefined ? {} : { unknown: snapshot.unknown }),
  };

  const skipped: ("sources" | "documents" | "pulse")[] = [
    ...(client.sources.length === 0 && client.sourcesWanted.length === 0
      ? (["sources"] as const)
      : []),
    ...(client.documents.length === 0 ? (["documents"] as const) : []),
    ...(client.pulse === null || client.pulse === "skipped"
      ? (["pulse"] as const)
      : []),
  ];
  const seed: OrgState = {
    conversation: "none",
    research: "none",
    agreed: profile.test
      ? { processing: true, assessment: true, council: "none" }
      : { processing: false, assessment: false, council: "none" },
    client: clientStepOf(snapshot),
    day: plan ? today : 0,
    rules: STARTING_ORG_RULES,
    ...NOTHING_BY_HAND,
    away: people.filter((person) => person.away).map((person) => person.id),
    left: (roster?.teams ?? [])
      .filter((team) => team.off)
      .map((team) => team.id),
  };
  return {
    id: profile.id,
    name: profile.name,
    about: profile.about,
    place: profile.place,
    sponsor: profile.sponsor.title || profile.sponsor.name,
    start,
    days,
    teams,
    works,
    dropped: [],
    transcript: "",
    vision: null,
    research: [],
    library: "",
    brief: client.documents.flatMap((document) =>
      document.reading ? [document.reading.about] : []
    ),
    skipped,
    stephen: {
      languages: [profile.language],
      limits: [],
      terms: [
        ...new Set(
          client.documents.flatMap((document) => document.reading?.tools ?? [])
        ),
      ],
    },
    company: {
      legalName: profile.name,
      url: profile.website,
      register: "",
      vat: "",
      address: [],
    },
    contacts: [
      ...(profile.sponsor.name
        ? [{ role: "sponsor" as const, ...profile.sponsor }]
        : []),
      ...(profile.admin.name
        ? [{ role: "admin" as const, ...profile.admin }]
        : []),
    ],
    contract: {
      status: "draft",
      plan: "",
      fee: 0,
      seats: 0,
      aiIncluded: 0,
      from: profile.created.slice(0, 10),
      until: addMonths(profile.created.slice(0, 10), 12),
      renews: true,
      notice: 3,
    },
    papers: {},
    members: snapshot.members ?? [],
    integrations: [],
    hourly: 0,
    seed,
    real,
  };
};
