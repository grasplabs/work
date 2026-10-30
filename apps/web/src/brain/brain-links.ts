import type { Source, Statement, Workspace } from "@grasp-os/shared/brain";

/**
 * The links the brain draws between teams, as the prototype has them
 * (`lib/brain-links.ts`): work passing from one team to another, and the
 * same pain told by more than one team. Grasp proposes a link from what
 * was said; a handover is confirmed when each of its two teams told it
 * from its own side. The same pain in several teams is one thing only once
 * a person says so: core keeps no such decisions yet (GRA-307), so it
 * stays proposed here until it does.
 */
export interface BrainLink {
  /** `handover:<work>:<team>:<team>` or `same-pain:<work>`, the same every time. */
  id: string;
  kind: "handover" | "samePain";
  /** The piece of work it is about. */
  work: string;
  /** The teams it joins, in the company's order. */
  teams: string[];
  confirmed: boolean;
  /** A handover each of the two teams told from its own side. */
  bothSides: boolean;
  /** What it rests on: the statements that told it. */
  statements: string[];
}

/** What a piece of work's pain is told as: what gets in the way, and where the time goes. */
const painKinds: ReadonlySet<Statement["kind"]> = new Set([
  "blocker",
  "timeSink",
]);

/** The team a conversation was with, when it is one. */
const speaker = (source: Source | undefined): string | undefined =>
  source?.kind === "interview" || source?.kind === "chat"
    ? source.teamIds?.[0]
    : undefined;

/** Every link the brain draws, from what was said. */
export const brainLinks = (ws: Workspace): BrainLink[] => {
  const sources = new Map(ws.sources.map((source) => [source.id, source]));
  const order = new Map(ws.teams.map((team, index) => [team.id, index]));
  const inOrder = (teams: string[]): string[] =>
    [...new Set(teams)]
      .filter((id) => order.has(id))
      .toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  // The team a statement was told from: the team of the conversation it was said in.
  const toldBy = (statement: Statement) =>
    speaker(sources.get(statement.sourceId));
  const links: BrainLink[] = [];

  const handovers = new Map<
    string,
    { work: string; teams: string[]; told: Statement[] }
  >();
  for (const statement of ws.statements) {
    const work = statement.candidateId;
    if (statement.kind !== "handover" || work === undefined) {
      continue;
    }
    const teams = inOrder(statement.teamIds);
    if (teams.length !== 2) {
      continue;
    }
    const id = `handover:${work}:${teams.join(":")}`;
    const held = handovers.get(id) ?? { work, teams, told: [] };
    held.told.push(statement);
    handovers.set(id, held);
  }
  for (const [id, { work, teams, told }] of handovers) {
    // Both teams told it, each from its own side: it is how the work passes, not one team's view of the other.
    const bothSides = teams.every((team) =>
      told.some((statement) => toldBy(statement) === team)
    );
    links.push({
      id,
      kind: "handover",
      work,
      teams,
      confirmed: bothSides,
      bothSides,
      statements: told.map((statement) => statement.id),
    });
  }

  for (const candidate of ws.candidates) {
    const told = ws.statements.filter(
      (statement) =>
        statement.candidateId === candidate.id && painKinds.has(statement.kind)
    );
    const teams = inOrder(told.flatMap((statement) => toldBy(statement) ?? []));
    if (teams.length < 2) {
      continue;
    }
    links.push({
      id: `same-pain:${candidate.id}`,
      kind: "samePain",
      work: candidate.id,
      teams,
      confirmed: false,
      bothSides: false,
      statements: told.map((statement) => statement.id),
    });
  }
  return links;
};
