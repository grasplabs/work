import type {
  Statement,
  ThinkingGround,
  Workspace,
} from "@grasp-os/shared/brain";
import { hoursPerWeek } from "@grasp-os/shared/thinking";

import type { NeuronState } from "../atlas-map.ts";
import type { Atlas } from "../brain-atlas.ts";
import type { Brain } from "../brain.ts";
import type { FigureWork } from "./hours.ts";

// What a shape of Grasp's thinking is drawn from, apart from how it is
// drawn (shapes.ts): the brain page takes it from the brain it built
// (`groundOf`), with each team's state in the atlas and each workflow's
// note; an answer's card from core's narrow read (`brain.thinking`,
// `cardGround`), with no brain to build, where every team is known and no
// workflow opens a note.

/** A team the shape may show, in the brain's order. */
export interface GroundTeam {
  id: string;
  name: string;
  state: NeuronState;
}

/** Something a team in the brain said, with that team and who said it, as a role. */
export type GroundStatement = Pick<
  Statement,
  "id" | "text" | "kind" | "sourceId"
> & { teamId: string; who?: string };

/** What a shape of Grasp's thinking is drawn from. */
export interface ShapeGround {
  teams: readonly GroundTeam[];
  /** Only what the teams in `teams` said. */
  statements: readonly GroundStatement[];
  works: readonly FigureWork[];
}

/** Who said a statement: the team its source speaks for, else its own first. */
const speakerOf =
  (ws: Workspace) =>
  (statement: Statement): string =>
    ws.sources.find(({ id }) => id === statement.sourceId)?.teamIds?.[0] ??
    statement.teamIds[0] ??
    "";

/** What the brain page draws a thinking from: its brain, as built, and its atlas. */
export const groundOf = (
  ws: Workspace,
  brain: Brain,
  atlas: Atlas
): ShapeGround => {
  const notes = new Map(brain.notes.map((note) => [note.id, note]));
  const asked = new Set(
    atlas.open
      .filter((item) => notes.get(item.noteId)?.kind !== "gap")
      .flatMap((item) => item.subjects)
  );
  const waiting = new Set(atlas.regions.flatMap((each) => each.waiting));
  const stateOf = (id: string): NeuronState => {
    if (asked.has(id)) {
      return "open";
    }
    return waiting.has(id) ? "waiting" : "known";
  };
  const teams = ws.teams
    .filter((team) => notes.get(team.id)?.kind === "team")
    .map(({ id, name }) => ({ id, name, state: stateOf(id) }));
  const inBrain = new Set(teams.map(({ id }) => id));
  const speaker = speakerOf(ws);
  const statements = ws.statements.flatMap((statement): GroundStatement[] => {
    const teamId = speaker(statement);
    const who = ws.sources.find(({ id }) => id === statement.sourceId)?.who;
    return inBrain.has(teamId)
      ? [
          {
            id: statement.id,
            text: statement.text,
            kind: statement.kind,
            sourceId: statement.sourceId,
            teamId,
            ...(who === undefined ? {} : { who }),
          },
        ]
      : [];
  });
  const noted = new Set(brain.notes.map(({ id }) => id));
  const works = ws.workflows.map((workflow): FigureWork => {
    const noteId = ws.candidates.find(
      (candidate) =>
        candidate.workflowId === workflow.id && noted.has(candidate.id)
    )?.id;
    return {
      id: workflow.id,
      ...(noteId === undefined ? {} : { noteId }),
      name: workflow.name,
      hours: hoursPerWeek(workflow),
    };
  });
  return { teams, statements, works };
};

/** What an answer's card draws a thinking from: core's narrow read, every team known. */
export const cardGround = (read: ThinkingGround): ShapeGround => {
  const teams = read.teams.map(({ id, name }): GroundTeam => ({
    id,
    name,
    state: "known",
  }));
  const inBrain = new Set(teams.map(({ id }) => id));
  return {
    teams,
    statements: read.statements.filter(({ teamId }) => inBrain.has(teamId)),
    works: read.workflows,
  };
};
