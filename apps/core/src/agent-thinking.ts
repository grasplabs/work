import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Statement, Team, Workflow } from "@grasp-os/shared/brain";
import {
  checkThinkingStep,
  hoursPerWeek,
  isFinding,
  nameKey,
  thinkingMoves,
  thinkingShapes,
} from "@grasp-os/shared/thinking";
import type { ThinkingNoteKind, ThinkingStep } from "@grasp-os/shared/thinking";

// Grasp's thinking, shown in the brain while it answers (GRA-1274): the
// chat agent's `show_thinking` tool. A step says in a short sentence what
// Grasp does, names what it looks at, and the shape the brain takes
// (@grasp-os/shared/thinking). The tool takes only teams, what they said
// and workflows that are in the brain as the asker may read it, as the
// brain page reads it for them (`readBrain`): what was said is a claim of
// five or more of a team's people, or none, so no one person's words can
// be named. A team or a workflow may be named by its id, its name, or an
// id the model makes of its name. Anything else is refused, with a reason
// the model can act on. An accepted step is kept with the answer, as the
// call's result (`details`), so the page plays it as it comes and again
// later; the model is told at once, so the answer never waits on the
// picture. Only for a chat's agent that holds the brain permission, in a
// person's own chat (workspace.ts).

export const showThinkingName = "show_thinking";

/** The brain as a step may name it: what the asker may read of it. */
export interface ThinkingBrain {
  teams: readonly Pick<Team, "id" | "name">[];
  statements: readonly Pick<Statement, "id">[];
  workflows: readonly Pick<Workflow, "id" | "name" | "drawings">[];
}

const parameters = Type.Object(
  {
    step: Type.String({
      description:
        "What you do in this step, or at the last one what you found, in one short plain sentence in the person's language.",
    }),
    shape: Type.Enum(thinkingShapes, {
      description:
        'The shape the brain takes: "same-pain", for whether the same pain hurts more than one team; "hours", for where the hours go.',
    }),
    move: Type.String({
      description:
        'Which step of the shape this is. For "same-pain": "teams", then "said", then "together". For "hours": "work", then "hours", then "most".',
    }),
    notes: Type.Array(Type.String(), {
      description:
        "What it looks at: teams by their id or name and what they said by its statement id, or workflows by their id or name.",
    }),
  },
  { additionalProperties: false }
);

/**
 * Finds what `name` names in `brain`, of `kinds`: by id, then by name,
 * then by an id made of a name; nothing for anything else.
 */
export const resolverOf =
  (brain: ThinkingBrain) =>
  (name: string, kinds: readonly ThinkingNoteKind[]): string | undefined => {
    const named: { id: string; name?: string }[] = [
      ...(kinds.includes("team") ? brain.teams : []),
      ...(kinds.includes("statement") ? brain.statements : []),
      ...(kinds.includes("workflow") ? brain.workflows : []),
    ];
    const key = nameKey(name);
    return (
      named.find(({ id }) => id === name) ??
      named.find((each) => each.name !== undefined && each.name === name) ??
      named.find(
        (each) =>
          key !== "" && each.name !== undefined && nameKey(each.name) === key
      )
    )?.id;
  };

/** Hours said short: "6.5 h a week". */
const hoursText = (hours: number): string => `${hours} h a week`;

/**
 * What the model is told of an accepted step: that the brain shows it,
 * the workflows' hours where it weighs them, and what comes next.
 */
export const toldOf = (step: ThinkingStep, brain: ThinkingBrain): string => {
  const lines = ["Shown in the brain."];
  if (step.shape === "hours" && step.move !== "work") {
    const hours = brain.workflows
      .filter(({ id }) => step.notes.includes(id))
      .map((workflow) => {
        const weekly = hoursPerWeek(workflow);
        return `- ${workflow.name}: ${weekly === null ? "hours not known yet" : hoursText(weekly)}`;
      });
    lines.push(
      "Their hours today, from the brain's own numbers (say a workflow's hours are not known yet where they are not):",
      ...hours
    );
  }
  if (isFinding(step)) {
    lines.push(
      "That was the last step: now write your answer to the person in words."
    );
  } else {
    const moves: readonly string[] = thinkingMoves[step.shape];
    const next = moves[moves.indexOf(step.move) + 1];
    lines.push(`Next in this shape: "${next}".`);
  }
  return lines.join("\n");
};

/**
 * The tool, reading the brain as the asker may read it once a turn, the
 * first time a step needs it.
 */
export const showThinking = (
  readBrain: () => Promise<ThinkingBrain>
): AgentTool<typeof parameters, ThinkingStep> => {
  let brain: Promise<ThinkingBrain> | undefined;
  return {
    name: showThinkingName,
    label: "Show thinking",
    description: [
      "Shows your thinking in the company brain while you answer, a step at a time, for one of two questions:",
      '- "same-pain": whether the same pain hurts more than one team. "teams": the teams you read; "said": what they said that slows them down, by statement id; "together": the teams that said the same, with what they said.',
      '- "hours": where the hours go. "work": the workflows you read; "hours": each weighed by its hours a week; "most": the ones that take most of the hours.',
      "Name only teams, statements and workflows that are in the brain. Call it once per move, in order, then answer in words. It never answers for you.",
    ].join("\n"),
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, input) => {
      brain ??= readBrain();
      let read: ThinkingBrain;
      try {
        read = await brain;
      } catch (error) {
        // Only a read that worked is kept: the next step reads again.
        brain = undefined;
        throw error;
      }
      const checked = checkThinkingStep(input, resolverOf(read));
      if ("refused" in checked) {
        throw new Error(checked.refused);
      }
      return {
        content: [{ type: "text", text: toldOf(checked.step, read) }],
        details: checked.step,
      };
    },
  };
};
