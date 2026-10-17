import { MIN_GROUP } from "./interviews.ts";
import type {
  OrgTeam,
  OrgView,
  PersonView,
  TeamView,
  Work,
  WorkEvidence,
} from "./onboarding-admin.ts";

/**
 * The organization as Grasp knows it, for its own page in the admin: every team with its lead, its
 * people and the work it does, who does which piece of work, where the work goes next, and what
 * about a team needs a look. All of it follows from the organization and the day, like the rest of
 * the admin. Pure.
 */

/** Where a piece of work goes when the people who do it are done with it. */
export interface Handoff {
  work: Work;
  /** The team that does it. */
  from: string;
  /** The team that gets it, when the people named one of the organization's own teams; none when it leaves the organization or goes to a role. */
  to: string | null;
  /** Who gets it next, as the people who do it said it. */
  text: string;
}

/** One piece of work on the chart: how far it is known, who does it, and its part of the team's work. */
export interface ChartWork {
  evidence: WorkEvidence;
  /** Who does it, as the lead named them or as each was asked about it. */
  doers: PersonView[];
  /** Its part of the team's work, 0 to 1, as the lead weighed it. */
  share: number;
  known: boolean;
  /** The apps it is done in. */
  tools: string[];
}

/** What about a team needs a look, the most pressing first. */
export type TeamFlag =
  /** It takes part and nobody is named as its lead: its people get their links at once, and each is asked what they do. */
  | { kind: "noLead" }
  /** Its lead was reminded and has not talked: the team's links wait. */
  | { kind: "leadLate"; name: string }
  /** A piece of work nobody is named for. */
  | { kind: "nobody"; work: Work }
  /** People who are asked about no piece of work, though the team's work is named: Stephen asks them what they do. */
  | { kind: "unasked"; count: number };

export interface ChartTeam {
  view: TeamView;
  works: ChartWork[];
  /** How many of its pieces of work count as known. */
  known: number;
  /** People asked about no piece of work, once the team's work is named. */
  unasked: PersonView[];
  /** Fewer people than the company is ever shown numbers for: its own admin never sees this team apart. */
  small: boolean;
  /** Work it hands on, and work it gets from other teams. */
  to: Handoff[];
  from: Handoff[];
  /** The apps its work is done in, with how many of its pieces of work each is named in, the most named first. */
  tools: { name: string; works: number }[];
  flags: TeamFlag[];
}

export interface Organization {
  teams: ChartTeam[];
  /** Work that goes from one of its teams to another. */
  between: Handoff[];
  /** The teams that take part, and of those how many have a lead by name and how many leads have talked. */
  taking: number;
  leadsNamed: number;
  leadsTalked: number;
  /** Everyone on the list, how many are asked to talk, and how many have. */
  people: number;
  asked: number;
  talked: number;
  /** The pieces of work named so far, and how many count as known. */
  works: number;
  known: number;
}

const escaped = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/**
 * The team a sentence names: one of the organization's own, by its name as it is written, capital
 * and all, so "the tax office" is never taken for the team called Tax. The longest name first, so
 * "Finance and administration" is not taken for "Finance".
 */
export const teamNamed = (
  text: string,
  teams: OrgTeam[],
  own: string
): string | null => {
  const others = teams
    .filter((team) => team.id !== own && team.name.trim() !== "")
    .toSorted((a, b) => b.name.length - a.name.length);
  return (
    others.find((team) =>
      new RegExp(
        String.raw`(^|[^\p{L}\p{N}])${escaped(team.name.trim())}($|[^\p{L}\p{N}])`,
        "u"
      ).test(text)
    )?.id ?? null
  );
};

const isKnown = (work: WorkEvidence) =>
  work.state === "complete" || work.state === "variants";

/** Whether a sentence names an app, as a word of its own. */
const names = (sentence: string, app: string) =>
  new RegExp(
    String.raw`(^|[^\p{L}\p{N}])${escaped(app)}($|[^\p{L}\p{N}])`,
    "iu"
  ).test(sentence);

/**
 * The apps a piece of work is done in: as the people who do it named them for each step, at an
 * organization that is onboarded for real; otherwise the apps the company connected that its own
 * sentences name.
 */
const toolsOf = (view: OrgView, work: Work): string[] => {
  const named = view.org.real?.tools.get(work.id);
  if (named) {
    return named;
  }
  const said = [
    ...work.steps,
    work.starts,
    work.own ?? "",
    work.ai ?? "",
    work.decides ?? "",
  ].join(" ");
  return view.org.integrations
    .filter(
      (each) =>
        each.kind !== "signIn" &&
        each.kind !== "pulse" &&
        names(said, each.name)
    )
    .map((each) => each.name);
};

export const organizationOf = (view: OrgView): Organization => {
  const { org } = view;
  const doing = (work: Work, person: PersonView) => {
    const named = org.real?.doers.get(work.id);
    return named
      ? named.includes(person.person.id)
      : person.person.work === work.id;
  };
  const handoffs: Handoff[] = view.works.flatMap((work) => {
    const text = work.work.next.trim();
    return text
      ? [
          {
            work: work.work,
            from: work.team,
            to: teamNamed(text, org.teams, work.team),
            text,
          },
        ]
      : [];
  });
  const teams = view.teams.map((team): ChartTeam => {
    const all = team.works.reduce(
      (sum, work) => sum + Math.max(work.work.share, 0),
      0
    );
    const works = team.works.map((evidence): ChartWork => ({
      evidence,
      doers: team.people.filter((person) => doing(evidence.work, person)),
      share:
        all > 0
          ? Math.max(evidence.work.share, 0) / all
          : 1 / Math.max(team.works.length, 1),
      known: isKnown(evidence),
      tools: toolsOf(view, evidence.work),
    }));
    const tools = [...new Set(works.flatMap((work) => work.tools))]
      .map((name) => ({
        name,
        works: works.filter((work) => work.tools.includes(name)).length,
      }))
      .toSorted((a, b) => b.works - a.works || a.name.localeCompare(b.name));
    // Asked about nothing: only worth saying once the team's work is named, and never for the lead, who is asked about all of it.
    const unasked =
      works.length === 0
        ? []
        : team.people.filter(
            (person) =>
              !person.person.lead &&
              person.state !== "away" &&
              !works.some((work) => work.doers.includes(person))
          );
    const flags: TeamFlag[] = [];
    if (!team.off) {
      if (team.next.kind === "lead" && team.next.reminded && team.lead) {
        flags.push({ kind: "leadLate", name: team.lead.person.first });
      }
      // A lead by name: the company names them, so before it has, every team waits for that and none is flagged.
      else if (team.next.kind !== "lead-unknown" && !team.lead) {
        flags.push({ kind: "noLead" });
      }
      for (const work of works) {
        if (work.doers.length === 0) {
          flags.push({ kind: "nobody", work: work.evidence.work });
        }
      }
      if (unasked.length > 0) {
        flags.push({ kind: "unasked", count: unasked.length });
      }
    }
    return {
      view: team,
      works,
      known: works.filter((work) => work.known).length,
      unasked,
      small: team.people.length > 0 && team.people.length < MIN_GROUP,
      to: handoffs.filter((each) => each.from === team.team.id),
      from: handoffs.filter((each) => each.to === team.team.id),
      tools,
      flags,
    };
  });
  const taking = view.teams.filter((team) => !team.off);
  return {
    teams,
    between: handoffs.filter((each) => each.to !== null),
    taking: taking.length,
    leadsNamed: taking.filter((team) => team.lead !== null).length,
    leadsTalked: taking.filter((team) => team.lead?.state === "completed")
      .length,
    people: view.people.length,
    asked: view.asked,
    talked: view.counts.completed,
    works: view.works.length,
    known: view.works.filter(isKnown).length,
  };
};
