import type { App } from "@grasp-os/shared/apps";
import type { KnowledgeSignal } from "@grasp-os/shared/knowledge-signals";
import type { ImprovementSignal } from "@grasp-os/shared/signals";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

// What the dashboard's widget board works out from what core read
// (`widget-board.tsx`): where each workflow stands, each engine's
// workflows, and how many signals of each kind there are. Pure, so the
// widgets only draw it.

/**
 * Where a workflow stands, as the board sorts it, the most pressing
 * first: it needs attention (runs failed lately, or its schedule
 * stopped), a run waits on a person, it ran, or it hasn't run yet.
 */
export const workflowStates = [
  "attention",
  "waiting",
  "ran",
  "notRun",
] as const;

export type WorkflowState = (typeof workflowStates)[number];

/** Where a workflow stands: the first of {@link workflowStates} that holds for it. */
export const stateOf = (workflow: WorkflowSummary): WorkflowState => {
  if (workflow.failed > 0 || workflow.scheduleStopped) {
    return "attention";
  }
  if (workflow.waiting > 0) {
    return "waiting";
  }
  if (workflow.lastRun !== null) {
    return "ran";
  }
  return "notRun";
};

/** The workflows in each state, each state's in the order given. */
export const byState = (
  rows: readonly WorkflowSummary[]
): Record<WorkflowState, WorkflowSummary[]> => {
  const states: Record<WorkflowState, WorkflowSummary[]> = {
    attention: [],
    waiting: [],
    ran: [],
    notRun: [],
  };
  for (const row of rows) {
    states[stateOf(row)].push(row);
  }
  return states;
};

/** An engine (core's App) on the board: its workflows, and how many of them ran. */
export interface EngineWorkflows {
  app: App;
  workflows: WorkflowSummary[];
  ran: number;
}

/**
 * Each engine the person can open, in the order given, with its
 * workflows as the overview lists them. A workflow of an engine not
 * given is left out: the board shows the engines the person can open.
 */
export const enginesOf = (
  apps: readonly App[],
  rows: readonly WorkflowSummary[]
): EngineWorkflows[] =>
  apps.map((app) => {
    const workflows = rows.filter((row) => row.app === app.id);
    return {
      app,
      workflows,
      ran: workflows.filter(({ lastRun }) => lastRun !== null).length,
    };
  });

/** Every kind of signal the board counts, improvement and Knowledge; an unanswered question is one kind for both. */
export type SignalKind = ImprovementSignal["kind"] | KnowledgeSignal["kind"];

/** The order kinds with as many signals come in: what a run waits or fails on first. */
const kindOrder: readonly SignalKind[] = [
  "failing_step",
  "waiting_for_person",
  "correction",
  "cost_per_run",
  "unanswered_question",
  "unread_document",
  "overdue_review",
];

/** How many signals there are of each kind there is one of, the most first. */
export const signalKinds = (
  signals: readonly { kind: SignalKind }[]
): { kind: SignalKind; count: number }[] => {
  const counts = new Map<SignalKind, number>();
  for (const { kind } of signals) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return kindOrder
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
    .toSorted((a, b) => b.count - a.count);
};
