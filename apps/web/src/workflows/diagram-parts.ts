import type {
  DiagramTask,
  DoorFlow,
  WorkflowDiagram,
} from "@grasp-os/shared/workflow-diagrams";

// A workflow drawn as a tree (prototype `inside-parts.tsx`,
// `inside-overview.tsx`, `inside-doors.tsx`): its named parts, each
// beginning at the task that names it and running to the next one that
// does, and the doors its tasks lead through to other workflows. Pure:
// core draws the diagram and resolves the doors for the reader.

/** One named part of a workflow, with the tasks in it. */
export interface DiagramPart {
  /** Its place, from 1. */
  n: number;
  name: string;
  purpose: string | null;
  summary: string | null;
  tasks: DiagramTask[];
  /** How many tasks it holds, those its tasks hold included. */
  steps: number;
  /** How many of them ask a person for a decision: where people come in. */
  decisions: number;
}

/** A task and every task its scopes hold, in order. */
export const within = (task: DiagramTask): DiagramTask[] => [
  task,
  ...task.scopes.flatMap((scope) => scope.tasks.flatMap(within)),
];

/** Whether a task asks a person for a decision (`grasp.decision`). */
export const asksPerson = (task: DiagramTask): boolean =>
  task.kind === "call" && (task.detail?.startsWith("grasp.decision") ?? false);

/**
 * The workflow's named parts, in order: each begins at a top-level task
 * that names one; tasks before the first named one form a part of their
 * own, with no name. None when no task names a part.
 */
export const partsOf = (diagram: WorkflowDiagram): DiagramPart[] => {
  if (!diagram.tasks.some((task) => (task.section ?? null) !== null)) {
    return [];
  }
  const parts: Omit<DiagramPart, "n" | "steps" | "decisions">[] = [];
  for (const task of diagram.tasks) {
    const section = task.section ?? null;
    const current = parts.at(-1);
    if (section !== null || current === undefined) {
      parts.push({
        name: section?.name ?? "",
        purpose: section?.purpose ?? null,
        summary: section?.summary ?? null,
        tasks: [task],
      });
    } else {
      current.tasks.push(task);
    }
  }
  return parts.map((part, index) => {
    const inside = part.tasks.flatMap(within);
    return {
      ...part,
      n: index + 1,
      steps: inside.length,
      decisions: inside.filter(asksPerson).length,
    };
  });
};

/** Another workflow the work goes on in, as the doors list shows it. */
export interface DoorPlace {
  /** The workflow behind it; null for one the reader can't see. */
  workflowId: string | null;
  name: string | null;
  flow: DoorFlow;
  /** The tasks that lead through it, by their pointers, in order. */
  tasks: string[];
}

/**
 * The doors of a diagram, each once, in the order the work reaches them:
 * one per workflow and flow, with every task that leads through it. The
 * doors to workflows the reader can't see stay apart, one per task, as
 * nothing says two of them are the same.
 */
export const doorsOf = (diagram: WorkflowDiagram): DoorPlace[] => {
  const doors = new Map<string, DoorPlace>();
  for (const task of diagram.tasks.flatMap(within)) {
    for (const door of task.doors ?? []) {
      const key =
        door.workflowId === null
          ? JSON.stringify([task.pointer, door.flow])
          : JSON.stringify([door.workflowId, door.flow]);
      const place = doors.get(key) ?? { ...door, tasks: [] };
      place.tasks.push(task.pointer);
      doors.set(key, place);
    }
  }
  return [...doors.values()];
};
