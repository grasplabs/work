import { brainOf, phaseOf } from "./admin-health.ts";
import type { AdminPhase } from "./admin-health.ts";
import { todoOf } from "./admin-todo.ts";
import type { Todo } from "./admin-todo.ts";
import type { AdminView } from "./admin-view.ts";
import type { KnowledgeSource, Need, Stage } from "./onboarding-admin.ts";

/**
 * What a person at Grasp takes into the next conversation with a company: where it stands, what
 * to bring up, what Grasp still does not know, and the next steps. Worked out from the view on its
 * day, so it is the same brief in the admin, in its chat and through its MCP. Pure.
 */
export interface Brief {
  phase: AdminPhase;
  stage: Stage;
  percent: number;
  threshold: number;
  /** What needs Grasp there that is worth saying to the company, the most pressing first. */
  bringUp: Need[];
  /** What the brain lacks most, by what it would add. */
  missing: { source: KnowledgeSource; known: number }[];
  /** What people could not say when asked, still to find out. */
  questions: number;
  /** What the step the company is at still asks, before the next one; none once Grasp is open. */
  next: Todo[];
  /** Once open: the work with the most hours by hand that no workflow takes on yet, the most first. */
  opportunities: { id: string; name: string; hours: number }[];
  /** Once open: hours a week freed, and what they are worth a month. */
  freed: number;
  value: number;
}

/** At most this many of each, so the brief fits in one look. */
export const BRIEF_ITEMS = 3;

/** What is worth saying to the company itself; the rest (reading, research) is Grasp's own to do. */
export const WITH_COMPANY: readonly Need["kind"][] = [
  "paused",
  "go",
  "short",
  "ending",
  "blocked",
  "lead",
  "quiet",
  "agreement",
  "contract",
  "conflict",
  "ask",
  "budget",
  "signin",
  "split",
];

export const briefOf = (view: AdminView): Brief => {
  const brain = brainOf(view);
  const todo = todoOf(view);
  const opportunities = view.value.works
    .filter(
      (work) =>
        !work.live &&
        work.expected === 0 &&
        work.hours !== null &&
        work.hours > 0
    )
    .map((work) => ({
      id: work.evidence.id,
      name: work.evidence.work.name,
      hours: work.hours ?? 0,
    }))
    .toSorted((a, b) => b.hours - a.hours);
  return {
    phase: phaseOf(view),
    stage: view.stage,
    percent: view.knowledge.percent,
    threshold: view.knowledge.threshold,
    bringUp: view.needs
      .filter((need) => WITH_COMPANY.includes(need.kind))
      .slice(0, BRIEF_ITEMS),
    missing: brain.sources
      .filter((each) => each.known < 1 && each.weight > 0)
      .slice(0, BRIEF_ITEMS)
      .map(({ source, known }) => ({ source, known })),
    questions: brain.questions,
    next: view.open
      ? []
      : todo.todos.filter((each) => !each.done).slice(0, BRIEF_ITEMS),
    opportunities: view.open ? opportunities.slice(0, BRIEF_ITEMS) : [],
    freed: view.value.freed,
    value: view.value.value,
  };
};
