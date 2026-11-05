import type { KnowledgeSignal } from "@grasp-os/shared/knowledge-signals";
import type { ImprovementSignal } from "@grasp-os/shared/signals";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";

// What the dashboard's widget board works out from what core read
// (`widget-board.tsx`): where each workflow stands, and how many signals
// of each kind there are. Pure, so the
// widgets only draw it.

/**
 * Where a workflow stands, as the board sorts it, the most pressing
 * first: it needs attention (runs failed lately), a run waits on a
 * person, it ran, or it hasn't run yet.
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
  if (workflow.failed > 0) {
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

/** Counts of kinds, the most first, those with as many in the board's order. */
export const byKindOrder = (
  counts: readonly { kind: SignalKind; count: number }[]
): { kind: SignalKind; count: number }[] => {
  const of = new Map(counts.map(({ kind, count }) => [kind, count]));
  return kindOrder
    .filter((kind) => of.has(kind))
    .map((kind) => ({ kind, count: of.get(kind) ?? 0 }))
    .toSorted((a, b) => b.count - a.count);
};

/** How many signals there are of each kind there is one of, the most first. */
export const signalKinds = (
  signals: readonly { kind: SignalKind }[]
): { kind: SignalKind; count: number }[] => {
  const counts = new Map<SignalKind, number>();
  for (const { kind } of signals) {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return byKindOrder([...counts].map(([kind, count]) => ({ kind, count })));
};
