import { addDays, addMonths, monthOf } from "./admin-account.ts";
import type { MemberView } from "./admin-account.ts";
import { valuePerMonth, WEEKS_PER_MONTH } from "./hours.ts";
import { TALK_SHARE } from "./interviews.ts";
import {
  dateOn,
  listenDays,
  RESEARCH_SOURCES,
  unit,
} from "./onboarding-admin.ts";
import type {
  Interview,
  Org,
  OrgView,
  Telling,
  Work,
  WorkEvidence,
  WorkRun,
} from "./onboarding-admin.ts";
import { present } from "./present.ts";

/**
 * What an organization costs Grasp in AI, and what its work is worth in hours. Both follow from
 * what the admin already knows: every interview, the first conversation, who is in the platform,
 * and the work that runs there. Nothing is typed in as a total. At an organization onboarded for
 * real, what the Worker counted as it happened takes the place of the sample's amounts. The
 * amounts one of each kind of use takes, and the prices, are samples: the same for every
 * organization, and in one place. Pure.
 */

/**
 * What does the work: the three models that read and write (the careful one, the quick one and
 * the small one), Stephen's voice, and his ears; and any other model a deployment calls (core's
 * own default is Workers AI's), counted with no price, for the admin has none for it.
 */
export const MODELS = [
  "opus",
  "sonnet",
  "haiku",
  "voice",
  "ears",
  "other",
] as const;
export type Model = (typeof MODELS)[number];

/** The models as they are called. */
export const MODEL_NAMES: Record<Model, string> = {
  opus: "Claude Opus 5.5",
  sonnet: "Claude Sonnet 5.5",
  haiku: "Claude Haiku 4.5",
  voice: "ElevenLabs v4",
  ears: "ElevenLabs Scribe",
  other: "Other models (not priced)",
};

/**
 * What Grasp pays, in euros: a model per million tokens it reads and writes, the voice per minute
 * Stephen speaks, the ears per minute he listens. Sample prices.
 */
export const PRICES: Record<
  Model,
  { tokensIn: number; tokensOut: number; minute: number }
> = {
  opus: { tokensIn: 5, tokensOut: 25, minute: 0 },
  sonnet: { tokensIn: 3, tokensOut: 15, minute: 0 },
  haiku: { tokensIn: 1, tokensOut: 5, minute: 0 },
  voice: { tokensIn: 0, tokensOut: 0, minute: 0.15 },
  ears: { tokensIn: 0, tokensOut: 0, minute: 0.01 },
  // Not known: its tokens count, its spend stays out of the total.
  other: { tokensIn: 0, tokensOut: 0, minute: 0 },
};
/** What the model read from what it had kept of an earlier call costs a tenth of reading it new. */
export const KEPT_SHARE = 0.1;

/** What AI is used for at an organization. */
export const PURPOSES = [
  "reading",
  "interviews",
  "drawing",
  "chat",
  "runs",
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** How much was used: tokens read and written, the minutes Stephen spoke and listened, and what that cost in euros. */
export interface Use {
  tokensIn: number;
  tokensOut: number;
  spoken: number;
  heard: number;
  spend: number;
}

type Amount = Omit<Use, "spend">;

/** A minute of interview: the whole conversation goes to both models again with every turn. The quick one says his line, the careful one writes down what was said. */
const INTERVIEW_MINUTE: Partial<
  Record<Model, { tokensIn: number; tokensOut: number }>
> = {
  sonnet: { tokensIn: 8000, tokensOut: 120 },
  opus: { tokensIn: 8000, tokensOut: 200 },
};
/** Reading a transcript: its words, with what Stephen is told to look for, and what he writes down. */
const READ = { perWord: 1.4, told: 2000, tokensOut: 1200 };
/** Looking up a company in one public source. */
const RESEARCH = { tokensIn: 18_000, tokensOut: 1500 };
/** Drawing a piece of work again from everyone's agreed facts, once someone agreed to more; and a team's map from its lead's. */
const DRAW = {
  work: { tokensIn: 6000, tokensOut: 1800 },
  map: { tokensIn: 5000, tokensOut: 1400 },
};
/** One message to the chat, with what Grasp knows about the company around it. */
const CHAT = { tokensIn: 5500, tokensOut: 450 };
/** How many messages someone who is in sends a week. */
const CHATS_A_WEEK = 14;
/** Which model answers a chat message: most go to the quick one, a hard question to the careful one. */
const CHAT_BY: Partial<Record<Model, number>> = { sonnet: 0.8, opus: 0.2 };
/** One step of a workflow, run once: what it works on goes to the model with what the step is told to do. */
const RUN_STEP = { tokensIn: 4600, tokensOut: 560 };
/** Which model runs a step: the small one where it can, the quick one where the step needs judgement. */
const RUN_BY: Partial<Record<Model, number>> = { haiku: 0.6, sonnet: 0.4 };

const nothing = (): Use => ({
  tokensIn: 0,
  tokensOut: 0,
  spoken: 0,
  heard: 0,
  spend: 0,
});

/** What an amount costs when this model did it. */
export const priced = (model: Model, amount: Partial<Amount>): Use => {
  const { tokensIn = 0, tokensOut = 0, spoken = 0, heard = 0 } = amount;
  const price = PRICES[model];
  return {
    tokensIn,
    tokensOut,
    spoken,
    heard,
    spend:
      (tokensIn / 1e6) * price.tokensIn +
      (tokensOut / 1e6) * price.tokensOut +
      (spoken + heard) * price.minute,
  };
};

const plus = (a: Use, b: Use): Use => ({
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  spoken: a.spoken + b.spoken,
  heard: a.heard + b.heard,
  spend: a.spend + b.spend,
});

const byModel = (): Record<Model, Use> => ({
  opus: nothing(),
  sonnet: nothing(),
  haiku: nothing(),
  voice: nothing(),
  ears: nothing(),
  other: nothing(),
});
/** One of something for each model. */
const forModels = <T>(make: (model: Model) => T): Record<Model, T> => ({
  opus: make("opus"),
  sonnet: make("sonnet"),
  haiku: make("haiku"),
  voice: make("voice"),
  ears: make("ears"),
  other: make("other"),
});
/** One of something for each purpose. */
const forPurposes = <T>(make: (purpose: Purpose) => T): Record<Purpose, T> => ({
  reading: make("reading"),
  interviews: make("interviews"),
  drawing: make("drawing"),
  chat: make("chat"),
  runs: make("runs"),
});
/** Uses added up, in order. */
const added = (uses: Iterable<Use>): Use => {
  let total = nothing();
  for (const each of uses) {
    total = plus(total, each);
  }
  return total;
};
const cells = (): Record<Purpose, Record<Model, Use>> => ({
  reading: byModel(),
  interviews: byModel(),
  drawing: byModel(),
  chat: byModel(),
  runs: byModel(),
});

/** The day everything about an organization is counted up to: the day its interviews are on while they run, and today otherwise. */
export const asOf = (view: OrgView, today: string): string => {
  if (!view.told) {
    return today;
  }
  if (!view.closed) {
    return dateOn(view.org, view.day);
  }
  // Counted up to the day its own plan closed: a six-week plan's AI is counted over six weeks.
  const closed = dateOn(view.org, listenDays(view.org));
  return today > closed ? today : closed;
};

/** Whether Grasp is open for the company on the day the view is on. */
export const isOpen = (view: OrgView): boolean =>
  view.knowledge.opened !== null && view.knowledge.opened <= view.day;

/** How many of one piece of work a single person handles in a week. */
const itemsAWeek = (work: Work): number =>
  (work.volume[0] + work.volume[1]) /
  2 /
  (work.per === "month" ? WEEKS_PER_MONTH : 1);

export interface Usage {
  /** Everything so far, by what it was used for. */
  purposes: Record<Purpose, Use>;
  /** Everything so far, by what did it. */
  models: Record<Model, Use>;
  /** Which model was used for what: by what it was for, then by model. */
  matrix: Record<Purpose, Record<Model, Use>>;
  /** Month by month, the oldest first: in all, by what it was for, by what did it, and which model for what. */
  months: {
    month: string;
    use: Use;
    purposes: Record<Purpose, Use>;
    models: Record<Model, Use>;
    matrix: Record<Purpose, Record<Model, Use>>;
  }[];
  /** Day by day, the oldest first, for the days something was used: what it cost, by model and by what it was for. */
  days: {
    day: string;
    spend: number;
    models: Record<Model, number>;
    purposes: Record<Purpose, number>;
  }[];
  total: Use;
  /** The month the view is in, so far. */
  thisMonth: Use;
  /** The last month that is over: which one, and what it took. None before there is one. */
  lastMonth: { month: string; use: Use } | null;
  /** Every live workflow: how often it ran since it went live, and what that took. */
  works: { id: string; runs: number; use: Use }[];
  /** Counted by the Worker as it happened, where the organization is onboarded for real; worked out from what happened otherwise. */
  counted: boolean;
}

/** What was spent in a day, the models in order. */
const spendOf = (models: Record<Model, number>): number => {
  let total = 0;
  for (const model of MODELS) {
    total += models[model];
  }
  return total;
};

/**
 * The AI an organization used up to `day`: Stephen reading the first conversation and looking the
 * company up, every interview he held and the work drawn from it, and once Grasp is open the chat
 * and the workflows that run.
 */
// oxlint-disable-next-line complexity -- ported as the prototype has it, every source of use in one place; the admin's tests pin what it counts
export const usageOf = (
  view: OrgView,
  day: string,
  members: MemberView[]
): Usage => {
  const { org, state } = view;
  const months = new Map<string, Record<Purpose, Record<Model, Use>>>();
  const days = new Map<
    string,
    { models: Record<Model, number>; purposes: Record<Purpose, number> }
  >();
  const works: Usage["works"] = [];
  const took = (on: string, purpose: Purpose, model: Model, used: Use) => {
    if (
      on > day ||
      (used.spend === 0 &&
        used.tokensIn === 0 &&
        used.spoken === 0 &&
        used.heard === 0)
    ) {
      return;
    }
    const month = months.get(monthOf(on)) ?? cells();
    month[purpose][model] = plus(month[purpose][model], used);
    months.set(monthOf(on), month);
    const that = days.get(on) ?? {
      models: forModels(() => 0),
      purposes: { reading: 0, interviews: 0, drawing: 0, chat: 0, runs: 0 },
    };
    that.models[model] += used.spend;
    that.purposes[purpose] += used.spend;
    days.set(on, that);
  };
  const usedOn = (
    on: string,
    purpose: Purpose,
    model: Model,
    amount: Partial<Amount>
  ) => {
    took(on, purpose, model, priced(model, amount));
  };
  /** An amount shared out over the models that do it, each its part. */
  const shared = (
    on: string,
    purpose: Purpose,
    by: Partial<Record<Model, number>>,
    amount: { tokensIn: number; tokensOut: number }
  ) => {
    for (const model of MODELS) {
      const part = by[model] ?? 0;
      if (part > 0) {
        usedOn(on, purpose, model, {
          tokensIn: amount.tokensIn * part,
          tokensOut: amount.tokensOut * part,
        });
      }
    }
  };

  // Counted as it happened: every call the Worker made for this organization, by what it was for and which model did it.
  const metered = org.real?.metered ?? [];
  for (const each of metered) {
    took(each.day, each.purpose, each.model, each.use);
  }
  // From the first day the Worker counted, its count is what was used. What happened before that day, and at a sample, is worked out.
  let countedFrom: string | null = null;
  for (const each of metered) {
    if (countedFrom === null || each.day < countedFrom) {
      countedFrom = each.day;
    }
  }

  // The first conversation, and the research that follows it, worked out
  // only for a day before the Worker counted: from then on it counted them.
  const readOn =
    (state.transcript === null ? org.vision?.on : undefined) ?? day;
  if (
    state.conversation === "read" &&
    (countedFrom === null || readOn < countedFrom)
  ) {
    const on = readOn;
    const words = view.transcript.split(/\s+/u).filter(Boolean).length;
    usedOn(on, "reading", "opus", {
      tokensIn: Math.round(words * READ.perWord) + READ.told,
      tokensOut: READ.tokensOut,
    });
    if (state.research === "done") {
      usedOn(on, "reading", "opus", {
        tokensIn: RESEARCH.tokensIn * RESEARCH_SOURCES.length,
        tokensOut: RESEARCH.tokensOut * RESEARCH_SOURCES.length,
      });
    }
  }

  for (const interview of view.interviews) {
    const on = dateOn(org, interview.day);
    const counted = countedFrom !== null && on >= countedFrom;
    // How long it took is unknown for someone who came back after leaving: nothing is worked out from it then.
    const { minutes } = interview;
    if (!counted) {
      // Every interview, the ones that stopped halfway too, and the drawing that follows one that was agreed to.
      const length =
        minutes === null
          ? 0
          : minutes * (0.85 + 0.3 * unit(`${org.id}/${interview.id}/tokens`));
      for (const model of MODELS) {
        const minute = INTERVIEW_MINUTE[model];
        if (minute && length > 0) {
          usedOn(on, "interviews", model, {
            tokensIn: Math.round(length * minute.tokensIn),
            tokensOut: Math.round(length * minute.tokensOut),
          });
        }
      }
      if (interview.approved) {
        usedOn(
          on,
          "drawing",
          "opus",
          interview.kind === "lead" ? DRAW.map : DRAW.work
        );
      }
    }
    if (interview.typed || minutes === null) {
      continue;
    }
    // By voice, Stephen speaks a fifth of the time. His voice is counted where the Worker counts; how long he listened is always worked out from how long people talked.
    if (!counted) {
      usedOn(on, "interviews", "voice", {
        spoken: minutes * TALK_SHARE,
      });
    }
    usedOn(on, "interviews", "ears", {
      heard: minutes * (1 - TALK_SHARE),
    });
  }

  // Once Grasp is open: the chat of everyone who is in, and each workflow from the day it went live.
  // Worked out at a sample only: at a real organization, what the Worker counted is all there was.
  if (
    org.real === undefined &&
    isOpen(view) &&
    view.knowledge.opened !== null
  ) {
    const opened = dateOn(org, view.knowledge.opened);
    const each = (
      from: string,
      purpose: Purpose,
      by: Partial<Record<Model, number>>,
      aDay: { tokensIn: number; tokensOut: number }
    ) => {
      for (
        let on = from > opened ? from : opened;
        on <= day;
        on = addDays(on, 1)
      ) {
        shared(on, purpose, by, aDay);
      }
    };
    for (const member of members) {
      if (member.state !== "active" || !present(member.joined)) {
        continue;
      }
      each(member.joined, "chat", CHAT_BY, {
        tokensIn: (CHAT.tokensIn * CHATS_A_WEEK) / 7,
        tokensOut: (CHAT.tokensOut * CHATS_A_WEEK) / 7,
      });
    }
    for (const work of view.works) {
      const run = org.running?.[work.id];
      if (run?.stage !== "live" || !present(run.since)) {
        continue;
      }
      const runs = (itemsAWeek(work.work) * work.doers) / 7;
      const aDay = {
        tokensIn: runs * work.work.steps.length * RUN_STEP.tokensIn,
        tokensOut: runs * work.work.steps.length * RUN_STEP.tokensOut,
      };
      each(run.since, "runs", RUN_BY, aDay);
      // The same days again, for this workflow alone.
      const from = run.since > opened ? run.since : opened;
      const count =
        from > day
          ? 0
          : Math.round(
              (Date.parse(`${day}T12:00:00Z`) -
                Date.parse(`${from}T12:00:00Z`)) /
                86_400_000
            ) + 1;
      if (count > 0) {
        const all = added(
          MODELS.map((model) =>
            priced(model, {
              tokensIn: aDay.tokensIn * count * (RUN_BY[model] ?? 0),
              tokensOut: aDay.tokensOut * count * (RUN_BY[model] ?? 0),
            })
          )
        );
        works.push({ id: work.id, runs: runs * count, use: all });
      }
    }
  }

  const sorted = [...months.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b)
  );
  const over = (of: Record<Model, Use>) =>
    added(MODELS.map((model) => of[model]));
  const purposesOf = (month: Record<Purpose, Record<Model, Use>>) =>
    forPurposes((purpose) => over(month[purpose]));
  const modelsOf = (month: Record<Purpose, Record<Model, Use>>) =>
    forModels((model) =>
      added(PURPOSES.map((purpose) => month[purpose][model]))
    );
  const sum = (purposes: Record<Purpose, Use>) =>
    added(PURPOSES.map((purpose) => purposes[purpose]));
  const matrix = cells();
  for (const [, month] of sorted) {
    for (const purpose of PURPOSES) {
      for (const model of MODELS) {
        matrix[purpose][model] = plus(
          matrix[purpose][model],
          month[purpose][model]
        );
      }
    }
  }
  const purposes = purposesOf(matrix);
  const now = months.get(monthOf(day));
  const before = monthOf(addMonths(`${monthOf(day)}-01`, -1));
  const last = months.get(before);
  return {
    purposes,
    models: modelsOf(matrix),
    matrix,
    months: sorted.map(([month, each]) => ({
      month,
      use: sum(purposesOf(each)),
      purposes: purposesOf(each),
      models: modelsOf(each),
      matrix: each,
    })),
    days: [...days.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([on, each]) => ({
        day: on,
        spend: spendOf(each.models),
        ...each,
      })),
    total: sum(purposes),
    thisMonth: now ? sum(purposesOf(now)) : nothing(),
    lastMonth: last ? { month: before, use: sum(purposesOf(last)) } : null,
    works,
    counted: metered.length > 0,
  };
};

/** What was used in one month, or over all of them: in all, by what it was for, by what did it, and which model for what. */
export interface UsePeriod {
  total: Use;
  purposes: Record<Purpose, Use>;
  models: Record<Model, Use>;
  matrix: Record<Purpose, Record<Model, Use>>;
}

/** The use of one month; of every month when none is given. A month nothing was used in is all nothing. */
export const usageIn = (usage: Usage, month: string | null): UsePeriod => {
  if (month === null) {
    return {
      total: usage.total,
      purposes: usage.purposes,
      models: usage.models,
      matrix: usage.matrix,
    };
  }
  const found = usage.months.find((each) => each.month === month);
  if (!found) {
    const none = cells();
    return {
      total: nothing(),
      purposes: forPurposes(() => nothing()),
      models: byModel(),
      matrix: none,
    };
  }
  return {
    total: found.use,
    purposes: found.purposes,
    models: found.models,
    matrix: found.matrix,
  };
};

/** The hours in one piece of work, and what of them a workflow frees. */
export interface WorkHours {
  evidence: WorkEvidence;
  /** Hours a week that go into it, across everyone who does it; none while nobody gave both how many and how long. */
  hours: number | null;
  /** How many people's numbers that rests on. */
  said: number;
  /** Where it stands in the platform; none while Grasp is not open, or while it was only heard. */
  run: WorkRun | null;
  /** It runs as a workflow by now. */
  live: boolean;
  /** Hours a week it frees, measured, once it is live. */
  freed: number;
  /** Hours a week its design is expected to free, while it is not live yet. */
  expected: number;
}

export interface Value {
  works: WorkHours[];
  /** Hours a week in the work whose numbers are known. */
  hours: number;
  /** Pieces of work with numbers, and without. */
  counted: number;
  unknown: number;
  /** Workflows that are live, and designs on their way. */
  live: number;
  designs: number;
  freed: number;
  expected: number;
  /** What an hour of the company's people costs, in euros. */
  rate: number;
  /** What the freed hours are worth a month: the value of the time, never money saved. */
  value: number;
  expectedValue: number;
}

/**
 * What `interview` told about the piece of work `id`. At a real organization,
 * everyone who told about it counts, whatever they were asked about, as its
 * record counts them (`recordOf`); in a sample, only who was asked about it.
 */
const tellingAbout = (
  org: Org,
  interview: Interview,
  id: string
): Telling | null => {
  if (org.real) {
    return org.real.told.get(`${interview.person.id}/${id}`) ?? null;
  }
  return interview.work?.id === id ? interview.telling : null;
};

/**
 * The hours in each piece of work, from what the people who do it said: how many they handle a
 * week and how long a normal one takes, averaged over the ones who gave both and counted for
 * everyone who does the work. Once Grasp is open, what the workflows free of that.
 */
export const valueOf = (view: OrgView, day: string): Value => {
  const { org } = view;
  const open = isOpen(view);
  const works = view.works.map((evidence): WorkHours => {
    const { work } = evidence;
    const own = view.interviews.flatMap((interview) => {
      const telling = interview.approved
        ? tellingAbout(org, interview, work.id)
        : null;
      if (
        !telling?.volume ||
        !telling.takes ||
        telling.out.includes("volume") ||
        telling.out.includes("takes")
      ) {
        return [];
      }
      const items =
        (telling.volume[0] + telling.volume[1]) /
        2 /
        (work.per === "month" ? WEEKS_PER_MONTH : 1);
      return [
        (items * telling.takes[1] * (work.unit === "hours" ? 60 : 1)) / 60,
      ];
    });
    const hours =
      own.length === 0
        ? null
        : (own.reduce((sum, each) => sum + each, 0) / own.length) *
          evidence.doers;
    const run = open ? (org.running?.[work.id] ?? null) : null;
    const live =
      run?.stage === "live" && run.since !== undefined && run.since <= day;
    const share = run?.frees ?? 0;
    return {
      evidence,
      hours,
      said: own.length,
      run,
      live,
      freed: live && hours !== null ? hours * share : 0,
      expected: !live && run && hours !== null ? hours * share : 0,
    };
  });
  const freed = works.reduce((sum, work) => sum + work.freed, 0);
  const expected = works.reduce((sum, work) => sum + work.expected, 0);
  return {
    works,
    hours: works.reduce((sum, work) => sum + (work.hours ?? 0), 0),
    counted: works.filter((work) => work.hours !== null).length,
    unknown: works.filter((work) => work.hours === null).length,
    live: works.filter((work) => work.live).length,
    designs: works.filter((work) => !work.live && work.run?.frees !== undefined)
      .length,
    freed,
    expected,
    rate: org.hourly,
    value: valuePerMonth(freed, org.hourly),
    expectedValue: valuePerMonth(expected, org.hourly),
  };
};
