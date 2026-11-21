// The page's side of the viewer's Workers. Each item with heavy work has a lane: the core's (search,
// a page's words, comments' anchors) and one for each renderer item that registers (Markdown, CSV,
// code). A lane's Worker is made the first time one of its tasks is asked for. When a Worker cannot
// start (the bundler did not ship it, or a policy forbids it), the same tasks run on the page
// itself, loaded only then, and `where()` says so. A task no installed item can do is refused,
// and the renderer that asked shows what it can without it.
"use client";

import type { Found } from "../anchor";
import type { ArtifactFormat } from "../format";
import { artifactViewerNotices } from "../words";
import type { CodeTokens, CoreTask } from "./tasks";

/**
 * Every task a lane can run, by kind, with its answer: the core's here; an item adds its own
 * (`declare module "../artifact-viewer/worker/client"`).
 */
export interface ViewerTasks {
  search: {
    task: Extract<CoreTask, { kind: "search" }>;
    result: { at: number[]; more: boolean };
  };
  htmlText: { task: Extract<CoreTask, { kind: "htmlText" }>; result: string };
  resolve: {
    task: Extract<CoreTask, { kind: "resolve" }>;
    result: (Found | null)[];
  };
  code: {
    task: { kind: "code"; source: string; language: string };
    result: CodeTokens;
  };
}

export type TaskKind = keyof ViewerTasks;
export type Task = ViewerTasks[TaskKind]["task"];

/** What an item registers for its tasks. */
export interface Lane {
  /** The kinds it runs. */
  kinds: readonly TaskKind[];
  /** The formats it serves: opening one starts its Worker early, beside the renderer's code. */
  formats?: readonly ArtifactFormat[];
  /** Makes its Worker. `new Worker(new URL("x.worker.ts", import.meta.url), { type: "module" })` in the item's own file. */
  make: () => Worker;
  /** Its tasks, loaded on the page when no Worker can run them. */
  page: () => Promise<{ run: (task: never) => Promise<unknown> }>;
  /** Whether an answer has the shape its task's kind gives it. */
  answers: (kind: TaskKind, value: unknown) => boolean;
  /** The task as it is sent, once it is keyed (a table's search without its text). */
  outgoing?: (task: Task) => Task;
  /** The task given a key before it runs anywhere (a table's number). */
  keyed?: (task: Task) => Task;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  task: Task;
}

interface Running extends Lane {
  worker: Worker | null;
  failed: boolean;
  next: number;
  pending: Map<number, Pending>;
}

const lanes = new Map<TaskKind, Running>();
const byFormat = new Map<ArtifactFormat, Running>();

/** Adds an item's lane: its tasks then run in its Worker, or on the page without one. */
export const registerLane = (lane: Lane) => {
  const running: Running = {
    ...lane,
    worker: null,
    failed: false,
    next: 0,
    pending: new Map(),
  };
  for (const kind of lane.kinds) {
    lanes.set(kind, running);
  }
  for (const format of lane.formats ?? []) {
    byFormat.set(format, running);
  }
};

// Runs on the page: the fallback, and the answer to anything asked while the Worker failed.
const onPage = async (lane: Running, task: Task) => {
  const { run } = await lane.page();
  // SAFETY: the lane was registered for this task's kind, so its `run` takes it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return await run(task as never);
};

// A task that was waiting on the Worker, run on the page instead: its answer or its error goes to
// whoever asked.
const moveToPage = async (lane: Running, job: Pending) => {
  let result: unknown;
  try {
    result = await onPage(lane, job.task);
  } catch (error) {
    job.reject(error);
    return;
  }
  job.resolve(result);
};

const start = (lane: Running) => {
  if (lane.worker || lane.failed || typeof Worker === "undefined") {
    return lane.worker;
  }
  let made: Worker;
  try {
    made = lane.make();
  } catch {
    lane.failed = true;
    return null;
  }
  lane.worker = made;
  made.addEventListener(
    "message",
    (
      event: MessageEvent<{ id?: number; result?: unknown; error?: string }>
    ) => {
      const { id, result, error } = event.data;
      if (id === undefined) {
        return;
      }
      const job = lane.pending.get(id);
      if (!job) {
        return;
      }
      lane.pending.delete(id);
      if (error === undefined) {
        job.resolve(result);
      } else {
        job.reject(new Error(error));
      }
    }
  );
  // A Worker that cannot load its script, or whose answer cannot be read: every task waiting moves
  // to the page.
  const fail = () => {
    lane.failed = true;
    lane.worker?.terminate();
    lane.worker = null;
    for (const [id, job] of lane.pending) {
      lane.pending.delete(id);
      void moveToPage(lane, job);
    }
  };
  made.addEventListener("error", fail);
  made.addEventListener("messageerror", fail);
  return made;
};

const send = async (lane: Running, given: Task): Promise<unknown> => {
  const task = lane.keyed?.(given) ?? given;
  const target = start(lane);
  if (!target) {
    return await onPage(lane, task);
  }
  const id = lane.next;
  lane.next += 1;
  // A plain promise with its settlers kept, not Promise.withResolvers: that is ES2024, and a Vite
  // app's TypeScript stops at ES2023.
  // oxlint-disable-next-line promise/avoid-new -- Promise.withResolvers is ES2024
  const promise = new Promise<unknown>((resolve, reject) => {
    lane.pending.set(id, { resolve, reject, task });
  });
  // A Worker takes no target origin: the second argument is what it hands over, here nothing.
  target.postMessage({ id, task: lane.outgoing?.(task) ?? task }, []);
  return await promise;
};

// The core's answers' shapes. Every answer comes from its tasks, so it always has the shape: the
// check is what lets it be typed as that task's result.
const coreAnswers = (kind: TaskKind, value: unknown) => {
  if (kind === "htmlText") {
    return typeof value === "string";
  }
  if (kind === "resolve") {
    return Array.isArray(value);
  }
  return (
    kind === "search" &&
    typeof value === "object" &&
    value !== null &&
    "at" in value
  );
};

registerLane({
  kinds: ["search", "htmlText", "resolve"],
  formats: ["text", "html"],
  make: () =>
    new Worker(new URL("viewer.worker.ts", import.meta.url), {
      type: "module",
      name: "artifact-viewer",
    }),
  page: async () => await import("./tasks"),
  answers: coreAnswers,
});

/** Whether a task of this kind can run: an installed item registered it. */
export const canRun = (kind: TaskKind) => lanes.has(kind);

/** Runs a task in its item's Worker, or on the page without one. Refused when no item runs it. */
export const runTask = async <K extends TaskKind>(
  task: ViewerTasks[K]["task"] & { kind: K }
): Promise<ViewerTasks[K]["result"]> => {
  const lane = lanes.get(task.kind);
  if (!lane) {
    throw new Error(artifactViewerNotices.wrongAnswer(task.kind));
  }
  const result = await send(lane, task);
  if (!lane.answers(task.kind, result)) {
    throw new Error(artifactViewerNotices.wrongAnswer(task.kind));
  }
  // SAFETY: `answers` checked the shape this kind's result has.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return result as ViewerTasks[K]["result"];
};

/** Starts the Worker a format will need before its first task, so it loads while a renderer's code does. */
export const warmWorker = (format: ArtifactFormat) => {
  const lane = byFormat.get(format);
  if (lane) {
    start(lane);
  }
};

/** Where tasks run now: in the core's Worker, or on the page. */
export const where = (): "worker" | "page" => {
  const core = lanes.get("search");
  return core?.worker && !core.failed ? "worker" : "page";
};
