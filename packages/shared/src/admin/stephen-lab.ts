/**
 * The Stephen Lab in Grasp's admin, worked out: one loop, before customers
 * and after. The lab measures a Stephen on practice companies whose truth
 * is known (scripts/lab/); a change to him ships as a release, and the
 * companies on it hold their interviews with it; their numbers, never their
 * words (GRA-329), say how he does with real people.
 *
 * A row is one Stephen as the lab tells them apart: by the mark of his
 * texts and of the code that makes him talk (`talks`, scripts/lab/
 * results.ts), so a change to that code alone is a Stephen of its own. Real
 * interviews say only the release name of his texts (`stephenVersion` in
 * core's onboarding/lab-marks.ts), which a run records too: they join the
 * newest row with that name. Interviews of a release the lab never measured
 * are a row of their own.
 *
 * Pure: the page (apps/admin/src/admin/lab.tsx) only says what this works
 * out. A difference in the lab counts only when it is larger than what the
 * same Stephen moves by chance (`@grasp-os/shared/lab-compare`).
 */
import { compare, meansOf, noiseOf } from "../lab-compare.ts";
import type { CaseScore, Verdict } from "../lab-compare.ts";
import type { Bench, Result, Scores } from "../lab-runs.ts";
import type { Interviewer } from "../onboarding.ts";
import { stephenOf } from "./onboarding-admin-record.ts";
import type { OrgView } from "./onboarding-admin.ts";
import { liveGroupsOf } from "./stephen-live.ts";
import type { LiveGroup } from "./stephen-live.ts";

/** One organization's interviews, as the admin read them from its Grasp. */
export interface LabOrganization {
  clientId: string;
  name: string;
  view: OrgView;
  /** The release channel it follows (Edge, Beta or Stable), which the page can narrow real interviews to. */
  channel?: string;
}

/** The numbers each version is shown by in the lab: what people get to say, the right next line, and notes that rest on what was said. */
export const LAB_NUMBERS = [
  { bench: "whole", metric: "heard", label: "Heard" },
  { bench: "ask", metric: "right", label: "Right line" },
  { bench: "notes", metric: "supported", label: "Supported" },
] as const satisfies readonly { bench: Bench; metric: string; label: string }[];
export type LabNumber = (typeof LAB_NUMBERS)[number];

/** Interviews from a Grasp that didn't say which Stephen held them. */
export const UNRECORDED = "unrecorded";

/** Which Stephen a run measured, as the lab tells them apart: his texts and the code that makes him talk. */
const versionOfRun = (run: Pick<Result, "stephen">): string =>
  run.stephen.talks;

/** Two runs measured the same thing the same way: the same bench, interviewer, models and people. */
const alikeKey = (run: Result | Scores): string =>
  [
    run.bench,
    run.stephen.interviewer,
    run.via.quick ?? "",
    run.via.careful ?? "",
    run.people ?? "",
    run.seed ?? 0,
  ].join("|");

/** Where one number of one version stands in the lab, on the open companies. */
export interface LabStanding {
  value: number;
  runs: number;
  cases: number;
  /** What two runs of it differ by; none with one run. */
  noise: number | null;
  /** The same number on the hidden companies, from runs measured alike: a number only. */
  hidden: number | null;
}

/** What real people did with one version, every organization together. */
export interface RealStanding {
  organizations: number;
  started: number;
  /** Who started and agreed to what was read back. */
  finished: number;
  rating: { count: number; average: number };
  /** Of what he wrote down, how much people left in; none before anyone finished. */
  leftIn: number | null;
}

/** One version of Stephen: its name, and how it did in the lab and with real people. */
export interface LabVersion {
  /** The lab's mark of him (`talks`); for a release the lab never measured, its release name; `UNRECORDED` for interviews that don't say. */
  version: string;
  /** The release name of his texts, which real interviews carry; none where unknown. */
  release: string | null;
  /** "Stephen 3" in the order the lab first measured them; versions the lab never measured are "Not measured". */
  name: string;
  firstRun: string | null;
  lab: Partial<Record<LabNumber["metric"], LabStanding>>;
  real: RealStanding | null;
}

/** What needs one of us, with where on the page it is dealt with. */
export interface LabNeed {
  id: string;
  text: string;
}

/** The one number the Lab leads with, against the version before it, measured alike. */
export interface LabHeadline {
  label: string;
  version: string;
  value: number;
  before: { version: string; value: number } | null;
  verdict: Verdict | null;
  /** The change on the hidden companies between the same two versions, when both were measured there. */
  hiddenChange: number | null;
}

export interface StephenLab {
  versions: LabVersion[];
  headline: LabHeadline | null;
  /** Every organization together. */
  real: RealStanding;
  needs: LabNeed[];
  /** The newest runs, open and hidden, newest first. */
  runs: (Result | Scores)[];
  /**
   * Live: real interviews group by group with the Stephen most people talk with now, against the
   * release before him; none before any interview says which Stephen held it.
   */
  live: {
    now: LabVersion;
    before: LabVersion | null;
    groups: LiveGroup[];
  } | null;
}

const mean = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

/** How many interviews were held, as words. */
const heldWords = (count: number): string =>
  count === 1 ? "1 interview was held" : `${count} interviews were held`;

/** Whole numbers of percent, for the sentences. */
const percent = (value: number): string => `${Math.round(value * 100)}%`;

/** The newest runs of one version on one bench that were measured alike, open companies first. */
const newestAlike = (
  runs: readonly Result[],
  version: string,
  bench: Bench
): Result[] => {
  const of = runs.filter(
    (run) => run.bench === bench && versionOfRun(run) === version
  );
  const newest = of.at(-1);
  return newest === undefined
    ? []
    : of.filter((run) => alikeKey(run) === alikeKey(newest));
};

const standingOf = (
  open: readonly Result[],
  hidden: readonly Scores[],
  version: string,
  number: LabNumber
): LabStanding | null => {
  const runs = newestAlike(open, version, number.bench);
  const values = runs.flatMap((run) => meansOf(run.cases)[number.metric] ?? []);
  const [first] = runs;
  if (values.length === 0 || first === undefined) {
    return null;
  }
  const key = alikeKey(first);
  const hiddenValues = hidden
    .filter(
      (run) =>
        run.bench === number.bench &&
        versionOfRun(run) === version &&
        alikeKey(run) === key
    )
    .flatMap((run) => run.means[number.metric] ?? []);
  return {
    value: mean(values),
    runs: values.length,
    cases: new Set(runs.flatMap((run) => run.cases.map((each) => each.id)))
      .size,
    noise: noiseOf(runs)?.[number.metric] ?? null,
    hidden: hiddenValues.length === 0 ? null : mean(hiddenValues),
  };
};

/** What real people did with the interviews `held` picks out, at every organization. */
const realOf = (
  organizations: readonly LabOrganization[],
  held: (interview: OrgView["interviews"][number]) => boolean
): RealStanding => {
  const each = organizations.map(({ view }) =>
    stephenOf({ ...view, interviews: view.interviews.filter(held) })
  );
  const counted = each.filter((stats) => stats.started > 0);
  const rated = counted.reduce((sum, stats) => sum + stats.rating.count, 0);
  const interviews = counted.reduce((sum, stats) => sum + stats.interviews, 0);
  return {
    organizations: counted.length,
    started: counted.reduce((sum, stats) => sum + stats.started, 0),
    finished: counted.reduce((sum, stats) => sum + stats.held, 0),
    rating: {
      count: rated,
      average:
        rated === 0
          ? 0
          : counted.reduce(
              (sum, stats) => sum + stats.rating.average * stats.rating.count,
              0
            ) / rated,
    },
    leftIn:
      interviews === 0
        ? null
        : counted.reduce(
            (sum, stats) => sum + stats.approved * stats.interviews,
            0
          ) / interviews,
  };
};

/** After how many days without a lab run that is worth saying. */
const QUIET_DAYS = 14;

/** Each case's number over some runs: its mean where several runs held it, as the lab compares them. */
const casesOver = (
  runs: readonly Result[],
  metric: string
): { cases: CaseScore[] } => {
  const found = new Map<string, number[]>();
  for (const run of runs) {
    for (const each of run.cases) {
      const value = each.scores[metric];
      if (value !== undefined) {
        found.set(each.id, [...(found.get(each.id) ?? []), value]);
      }
    }
  }
  return {
    cases: [...found].map(([id, values]) => ({
      id,
      scores: { [metric]: mean(values) },
    })),
  };
};

/**
 * The newest Stephen against the one before, as the lab compares two runs
 * (`compare`, scripts/lab/round.ts): over the cases both were measured on,
 * with what the earlier one moves by chance as the bar.
 */
const headlineOf = (
  open: readonly Result[],
  hidden: readonly Scores[],
  ordered: readonly string[]
): LabHeadline | null => {
  for (const number of LAB_NUMBERS) {
    const measured = ordered.filter(
      (version) => newestAlike(open, version, number.bench).length > 0
    );
    const version = measured.at(-1);
    if (version === undefined) {
      continue;
    }
    const now = newestAlike(open, version, number.bench);
    const [first] = now;
    if (first === undefined) {
      continue;
    }
    const key = alikeKey(first);
    const standing = standingOf(open, hidden, version, number);
    if (standing === null) {
      continue;
    }
    // The version before, measured alike: never set beside one measured another way.
    const previous = measured
      .slice(0, -1)
      .toReversed()
      .find((each) =>
        open.some(
          (run) =>
            versionOfRun(run) === each &&
            run.bench === number.bench &&
            alikeKey(run) === key
        )
      );
    const alike = open.filter((run) => alikeKey(run) === key);
    const was =
      previous === undefined
        ? null
        : standingOf(alike, hidden, previous, number);
    const before =
      previous === undefined ? [] : newestAlike(alike, previous, number.bench);
    const compared = compare(
      casesOver(before, number.metric),
      casesOver(now, number.metric),
      noiseOf(before)
    ).find((each) => each.metric === number.metric);
    return {
      label: number.label,
      version,
      value: standing.value,
      before:
        previous === undefined || was === null || compared === undefined
          ? null
          : { version: previous, value: was.value },
      verdict: was === null ? null : (compared?.verdict ?? null),
      hiddenChange:
        was === null || standing.hidden === null || was.hidden === null
          ? null
          : standing.hidden - was.hidden,
    };
  }
  return null;
};

/** Versions in the order the lab first measured them, each with when that was. */
const firstRunsOf = (
  runs: readonly (Result | Scores)[]
): Map<string, string> => {
  const first = new Map<string, string>();
  for (const run of runs.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (!first.has(versionOfRun(run))) {
      first.set(versionOfRun(run), run.at);
    }
  }
  return first;
};

/** The release name of a row: what its lab Stephen ran as, or the release itself for one the lab never measured. */
const releaseNameOf = (
  version: string,
  measured: readonly string[],
  releaseOf: ReadonlyMap<string, string>
): string | null => {
  if (measured.includes(version)) {
    return releaseOf.get(version) ?? null;
  }
  return version === UNRECORDED ? null : version;
};

/** What a version is called: by the order the lab measured it, or that it never was. */
const nameFor = (
  version: string,
  measured: readonly string[],
  interviewer: Interviewer
): string => {
  if (version === UNRECORDED) {
    return "Not recorded";
  }
  const at = measured.indexOf(version);
  if (at === -1) {
    return "Not measured";
  }
  return `${interviewer === "claire" ? "Claire" : "Stephen"} ${at + 1}`;
};

/** What Live says needs one of us: a group that finishes less often, or rates him lower, with the Stephen in use than before him. */
const liveNeeds = (live: StephenLab["live"]): LabNeed[] => {
  if (live === null || live.before === null) {
    return [];
  }
  const { now, before } = live;
  const all = live.groups.find((group) => group.id === "all");
  // A group that holds every interview on both sides says what "all" says already.
  const repeatsAll = (group: LiveGroup): boolean =>
    group.id !== "all" &&
    all !== undefined &&
    group.now.started === all.now.started &&
    group.before?.started === all.before?.started;
  return live.groups.flatMap((group) => {
    if (repeatsAll(group)) {
      return [];
    }
    const needs: LabNeed[] = [];
    if (group.finishedFell && group.before !== null) {
      needs.push({
        id: `finished-${group.id}`,
        text: `Fewer ${group.who} finish with ${now.name}: ${group.now.finished} of ${group.now.started}, against ${group.before.finished} of ${group.before.started} with ${before.name}, more than chance.`,
      });
    }
    if (group.ratingFell) {
      const who = `${group.who.charAt(0).toUpperCase()}${group.who.slice(1)}`;
      needs.push({
        id: `rating-${group.id}`,
        text: `${who} rate ${now.name} lower than ${before.name}, more than chance.`,
      });
    }
    return needs;
  });
};

/** What the lab itself says needs one of us: a worse version, one the hidden companies don't back, one nobody measured, or a lab gone quiet. */
const labNeeds = ({
  versions,
  headline,
  lastRun,
  now,
}: {
  versions: readonly LabVersion[];
  headline: LabHeadline | null;
  lastRun: string | undefined;
  now: string;
}): LabNeed[] => {
  const needs: LabNeed[] = [];
  const nameOf = (version: string): string =>
    versions.find((each) => each.version === version)?.name ?? version;
  // The Stephen most people talk with now, by the interviews held with it.
  const [inUse] = versions
    .filter((each) => each.version !== UNRECORDED && each.real !== null)
    .toSorted((a, b) => (b.real?.started ?? 0) - (a.real?.started ?? 0));
  if (inUse !== undefined && Object.keys(inUse.lab).length === 0) {
    needs.push({
      id: "untested",
      text: `${heldWords(inUse.real?.started ?? 0)} with a Stephen the lab never measured. Run the benches on that release.`,
    });
  }
  if (headline?.verdict === "worse" && headline.before !== null) {
    needs.push({
      id: "worse",
      text: `${headline.label}: ${nameOf(headline.version)} does worse in the lab than ${nameOf(headline.before.version)}, ${percent(headline.value)} against ${percent(headline.before.value)}, more than chance moves it.`,
    });
  }
  const hiddenDisagrees =
    headline?.verdict === "better" &&
    headline.hiddenChange !== null &&
    headline.hiddenChange <= 0;
  if (hiddenDisagrees) {
    needs.push({
      id: "hidden",
      text: `${headline.label}: ${nameOf(headline.version)} does better on the open companies but not on the hidden ones. Don't release it yet.`,
    });
  }
  const days =
    lastRun === undefined
      ? null
      : Math.floor((Date.parse(now) - Date.parse(lastRun)) / 86_400_000);
  if (days !== null && days > QUIET_DAYS) {
    needs.push({ id: "quiet", text: `The lab hasn't run in ${days} days.` });
  }
  return needs;
};

/**
 * Live: the Stephen most people talk with now (by interviews started with his releases), the
 * one people talked with before him, and every group's numbers with both. A row counts every
 * release it was run as; which came before is told by when real people first talked with
 * each, never by the order organizations or interviews happen to come in.
 */
const liveOf = (
  versions: readonly LabVersion[],
  organizations: readonly LabOrganization[],
  releasesOf: (row: string) => string[]
): StephenLab["live"] => {
  const interviews = organizations.flatMap(({ view }) => view.interviews);
  // When real people first talked with a row, as ISO time; rows that never say come last.
  const firstSeen = (row: string): string => {
    const releases = releasesOf(row);
    const [first = "~"] = interviews
      .flatMap((interview) =>
        interview.startedAt !== undefined &&
        releases.includes(interview.stephen ?? UNRECORDED)
          ? [interview.startedAt]
          : []
      )
      .toSorted();
    return first;
  };
  const withPeople = versions
    .filter((each) => each.version !== UNRECORDED && each.real !== null)
    .map((each) => ({ each, seen: firstSeen(each.version) }))
    .toSorted((a, b) => a.seen.localeCompare(b.seen))
    .map(({ each }) => each);
  const [now] = withPeople.toSorted(
    (a, b) => (b.real?.started ?? 0) - (a.real?.started ?? 0)
  );
  if (now === undefined) {
    return null;
  }
  const before = withPeople[withPeople.indexOf(now) - 1] ?? null;
  return {
    now,
    before,
    groups: liveGroupsOf(
      interviews,
      releasesOf(now.version),
      before === null ? null : releasesOf(before.version)
    ),
  };
};

/**
 * Everything the Stephen Lab page shows, for one interviewer: every version
 * with the lab's numbers and the real ones, the number it leads with, and
 * what needs one of us. `now` is when it is read, as ISO time.
 */
export const stephenLabOf = ({
  results,
  scores,
  organizations,
  interviewer,
  now,
  channel,
}: {
  results: readonly Result[];
  scores: readonly Scores[];
  organizations: readonly LabOrganization[];
  interviewer: Interviewer;
  now: string;
  /** Only the organizations on this release channel; all of them without it. */
  channel?: string;
}): StephenLab => {
  const open = results
    .filter(
      (run) => run.set === "open" && run.stephen.interviewer === interviewer
    )
    .toSorted((a, b) => a.at.localeCompare(b.at));
  const hidden = scores.filter(
    (run) => run.stephen.interviewer === interviewer
  );
  // Real interviews held by this interviewer, and by which Stephen, on the channel asked for.
  const theirs = organizations
    .filter(
      (organization) =>
        channel === undefined || organization.channel === channel
    )
    .map((organization) => ({
      ...organization,
      view: {
        ...organization.view,
        interviews: organization.view.interviews.filter(
          (interview) => interview.interviewer === interviewer
        ),
      },
    }));
  const realVersions = new Set(
    theirs.flatMap(({ view }) =>
      view.interviews.map((interview) => interview.stephen ?? UNRECORDED)
    )
  );
  const firstRun = firstRunsOf([...open, ...hidden]);
  const measured = [...firstRun.keys()];
  // The release name each lab Stephen was run as, from his newest run that says it.
  const releaseOf = new Map<string, string>();
  for (const run of [...open, ...hidden].toSorted((a, b) =>
    a.at.localeCompare(b.at)
  )) {
    if (run.stephen.version !== undefined) {
      releaseOf.set(versionOfRun(run), run.stephen.version);
    }
  }
  // Real interviews of a release join the newest lab Stephen run as that release, whatever else he
  // was run as later (a change to Claire's texts alone is a new release with the same Stephen); the
  // releases the lab never ran are rows of their own.
  const rowOfRelease = new Map<string, string>();
  for (const run of [...open, ...hidden].toSorted((x, y) =>
    x.at.localeCompare(y.at)
  )) {
    if (run.stephen.version !== undefined) {
      rowOfRelease.set(run.stephen.version, versionOfRun(run));
    }
  }
  const unmeasured = [...realVersions].filter(
    (release) => !rowOfRelease.has(release)
  );
  // Every release real people talked with that belongs to one row.
  const releasesOf = (row: string): string[] => [
    ...[...rowOfRelease].flatMap(([release, mark]) =>
      mark === row && realVersions.has(release) ? [release] : []
    ),
    ...(unmeasured.includes(row) ? [row] : []),
  ];
  const realFor = (row: string): RealStanding | null => {
    const releases = releasesOf(row);
    return releases.length === 0
      ? null
      : realOf(theirs, (interview) =>
          releases.includes(interview.stephen ?? UNRECORDED)
        );
  };
  const versions: LabVersion[] = [...measured, ...unmeasured].map(
    (version) => ({
      version,
      release: releaseNameOf(version, measured, releaseOf),
      name: nameFor(version, measured, interviewer),
      firstRun: firstRun.get(version) ?? null,
      lab: Object.fromEntries(
        LAB_NUMBERS.flatMap((number) => {
          const standing = standingOf(open, hidden, version, number);
          return standing === null ? [] : [[number.metric, standing]];
        })
      ),
      real: realFor(version),
    })
  );
  const headline = headlineOf(open, hidden, measured);
  const everyRun = [...open, ...hidden].toSorted((a, b) =>
    b.at.localeCompare(a.at)
  );
  const live = liveOf(versions, theirs, releasesOf);
  return {
    versions,
    headline,
    real: realOf(theirs, () => true),
    live,
    needs: [
      ...labNeeds({ versions, headline, lastRun: everyRun[0]?.at, now }),
      ...liveNeeds(live),
    ],
    runs: everyRun.slice(0, 20),
  };
};
