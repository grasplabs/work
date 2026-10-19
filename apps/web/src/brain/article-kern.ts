import type { Source, Statement, StatementKind } from "@grasp-os/shared/brain";

import type { Place } from "./transcript.ts";

/**
 * What a note's page says about its statements: who they came from, when it was last heard, and
 * how many there are of each kind. Nothing here is ranked or scored.
 */

export interface StatementRow {
  statement: Statement;
  place: Place;
}

/** Someone the team was heard through in an interview, as the source names them. */
export interface Interviewee {
  sourceId: string;
  /** What the source calls them: "Finance assistant 1", or the stakeholder's role. Grasp keeps no names. */
  label: string;
  /** Their role. */
  role: string;
  /** Initials for the banner, numbered where several share a role: "FA1". */
  initials: string;
  /** How they were interviewed, as the source says it: "Live, 45 minutes", "Chat interview". */
  how?: string;
  /** ISO date. */
  date: string;
  stakeholder: boolean;
}

export interface Kern {
  /** Everyone interviewed whose words are here, the stakeholder first, then by date. */
  interviewed: Interviewee[];
  /** The date of the newest source the statements came from, as an ISO date. */
  lastHeard?: string;
  /** How many statements of each kind, in the order kinds are counted elsewhere. */
  counts: { kind: StatementKind; count: number }[];
}

const initialsOf = (role: string): string =>
  role
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase())
    .join("")
    .slice(0, 2);

const trailingNumber = /\d+$/u;

/**
 * Who a source heard, as one person: an employee's interview names them by role and number ("Chat
 * interview: Finance assistant 1"), a stakeholder's by role alone. Initials carry the number, so
 * two finance assistants are told apart.
 */
export const intervieweeOf = (source: Source): Interviewee => {
  const stakeholder = source.interviewee === "stakeholder";
  const role = source.who ?? "";
  const label =
    stakeholder || source.interviewee === undefined
      ? role
      : (source.title.split(": ").at(-1) ?? role);
  const number = trailingNumber.exec(label)?.[0] ?? "";
  return {
    sourceId: source.id,
    label,
    role,
    initials: `${initialsOf(role)}${number}`,
    how: source.how,
    date: source.date,
    stakeholder,
  };
};

/**
 * The team's own interviews the statements came from, one person each, the stakeholder first: not
 * another team's, whose people may name this team too.
 */
const interviewedIn = (teamId: string, rows: StatementRow[]): Interviewee[] => {
  const sources = [
    ...new Map(
      rows.map((row) => [row.place.source.id, row.place.source])
    ).values(),
  ].filter(
    (source) =>
      source.interviewee !== undefined &&
      source.teamIds?.includes(teamId) === true
  );
  return sources
    .map(intervieweeOf)
    .toSorted(
      (a, b) =>
        Number(b.stakeholder) - Number(a.stakeholder) ||
        a.date.localeCompare(b.date)
    );
};

const countOrder: StatementKind[] = [
  "timeSink",
  "blocker",
  "handover",
  "wish",
  "goal",
  "rule",
  "tool",
];

export const kernOf = (noteId: string, rows: StatementRow[]): Kern => {
  const dates = rows.map((row) => row.place.source.date).toSorted();
  return {
    interviewed: interviewedIn(noteId, rows),
    lastHeard: dates.at(-1),
    counts: countOrder.flatMap((kind) => {
      const count = rows.filter((row) => row.statement.kind === kind).length;
      return count > 0 ? [{ kind, count }] : [];
    }),
  };
};
