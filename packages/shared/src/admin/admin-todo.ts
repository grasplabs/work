import { VISION_FIELDS } from "./interviews.ts";
import { mayInvite } from "./onboarding-admin.ts";
import type { Need, OrgView, Stage } from "./onboarding-admin.ts";
import { present } from "./present.ts";

/**
 * What the stage an organization is at asks of Grasp, as a list to tick off: everything that has
 * to be in place before the next stage, done or not, with how far it is. What needs Grasp from
 * outside that stage (the contract, AI use, a sign-in that stopped) is kept apart. Pure.
 *
 * Grasp OS's onboarding area in a client's deployment works its stages and needs out the same way,
 * adapted to what core's store holds (apps/core/src/onboarding/staff-area.ts).
 */

export type Todo =
  | {
      kind:
        | "transcriptIn"
        | "transcriptRead"
        | "research"
        | "people"
        | "leadsNamed"
        | "told"
        | "go";
      done: boolean;
    }
  | { kind: "askSponsor"; done: boolean; fields: number }
  | { kind: "conflicts"; done: boolean; count: number }
  | {
      kind: "agreement";
      done: boolean;
      what: "processing" | "assessment" | "council";
    }
  /** One team's lead has talked; when not, whether the one reminder can still go to them. */
  | {
      kind: "leadTalked";
      done: boolean;
      team: string;
      person: string;
      name: string;
      mayRemind: boolean;
    }
  | { kind: "linksOut"; done: boolean; out: number; of: number }
  /** How many talked of everyone asked, and who the one reminder can still go to. */
  | {
      kind: "talked";
      done: boolean;
      talked: number;
      of: number;
      remind: string[];
    }
  | { kind: "workflowsKnown"; done: boolean; known: number; of: number }
  | { kind: "blocked"; done: boolean; work: string; name: string }
  | { kind: "read"; done: boolean; count: number }
  | { kind: "known"; done: boolean; percent: number; threshold: number };

export interface StageTodo {
  stage: Stage;
  todos: Todo[];
  /** How many are done, of how many. */
  done: number;
  of: number;
  /** What else needs Grasp, from outside this stage, the most pressing first. */
  elsewhere: Need[];
}

/** The stage each need belongs to; none for what stands beside the onboarding. */
const NEED_STAGE: Record<Need["kind"], Stage | null> = {
  transcript: "conversation",
  ask: "conversation",
  research: "research",
  conflict: "research",
  agreement: "agreed",
  lead: "leads",
  quiet: "interviews",
  blocked: "interviews",
  split: "interviews",
  few: "interviews",
  read: "interviews",
  go: "open",
  short: "open",
  contract: null,
  ending: null,
  signin: null,
  budget: null,
};

/** What one stage asks for. */
export const todosAt = (view: OrgView, stage: Stage): Todo[] => {
  const { state, org } = view;
  if (stage === "conversation") {
    const { vision } = view;
    const missing = vision
      ? VISION_FIELDS.filter((field) => vision.fields[field] === undefined)
          .length
      : 0;
    return [
      { kind: "transcriptIn", done: state.conversation !== "none" },
      { kind: "transcriptRead", done: state.conversation === "read" },
      {
        kind: "askSponsor",
        done: state.conversation === "read" && missing === 0,
        fields: missing,
      },
    ];
  }
  if (stage === "research") {
    const conflicts = org.research.filter(
      (finding) =>
        present(finding.conflict) && !state.passed.includes(finding.source)
    ).length;
    return [
      { kind: "research", done: state.research === "done" },
      {
        kind: "conflicts",
        done: state.research === "done" && conflicts === 0,
        count: conflicts,
      },
    ];
  }
  if (stage === "agreed") {
    return [
      { kind: "agreement", what: "processing", done: state.agreed.processing },
      { kind: "agreement", what: "assessment", done: state.agreed.assessment },
      {
        kind: "agreement",
        what: "council",
        done: state.agreed.council !== "waiting",
      },
    ];
  }
  if (stage === "connected") {
    return [
      { kind: "people", done: state.client !== "none" },
      {
        kind: "leadsNamed",
        done: state.client === "leads" || state.client === "told",
      },
    ];
  }
  if (stage === "leads") {
    return [
      { kind: "told", done: view.told },
      ...view.teams.flatMap((team): Todo[] =>
        team.lead && !team.off
          ? [
              {
                kind: "leadTalked",
                done: team.sent !== null,
                team: team.team.id,
                person: team.lead.person.id,
                name: team.lead.person.name,
                mayRemind: team.lead.mayRemind && mayInvite(state.agreed),
              },
            ]
          : []
      ),
    ];
  }
  if (stage === "interviews") {
    // Everyone who is asked, the leads too: by now they have talked, and every other count has them in it.
    const asked = view.people.filter((each) => each.state !== "away");
    const talked = asked.filter((each) => each.state === "completed").length;
    const out = asked.filter((each) => each.sent !== null).length;
    const known = view.works.filter(
      (work) => work.state === "complete" || work.state === "variants"
    ).length;
    const toRead = view.needs.find((need) => need.kind === "read");
    return [
      {
        kind: "linksOut",
        done: asked.length > 0 && out === asked.length,
        out,
        of: asked.length,
      },
      {
        kind: "talked",
        done: asked.length > 0 && talked === asked.length,
        talked,
        of: asked.length,
        remind: asked
          .filter((each) => each.mayRemind)
          .map((each) => each.person.id),
      },
      {
        kind: "workflowsKnown",
        done: view.works.length > 0 && known === view.works.length,
        known,
        of: view.works.length,
      },
      ...view.works
        .filter((work) => work.state === "blocked")
        .map((work): Todo => ({
          kind: "blocked",
          done: false,
          work: work.id,
          name: work.work.name,
        })),
      {
        kind: "read",
        done: !toRead,
        count: toRead?.kind === "read" ? toRead.count : 0,
      },
    ];
  }
  return [
    {
      kind: "known",
      done: view.knowledge.ready,
      percent: view.knowledge.percent,
      threshold: view.knowledge.threshold,
    },
    { kind: "go", done: view.knowledge.opened !== null },
  ];
};

/** The list for the stage the organization is at, and what needs Grasp beside it. */
export const todoOf = (view: OrgView): StageTodo => {
  const { stage } = view;
  const todos = todosAt(view, stage);
  return {
    stage,
    todos,
    done: todos.filter((todo) => todo.done).length,
    of: todos.length,
    elsewhere: view.needs.filter((need) => NEED_STAGE[need.kind] !== stage),
  };
};
