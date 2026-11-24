// Compile-time guarantees of the workflow references the host generates
// (spec 10.4.1, 10.4.5, 10.4.6, 10.7.2, 10.7.9), checked against the
// Notes fixture's generated `workflows`: a workflow's args, result,
// waits, events and decisions are inferred from its reference alone, and
// after narrowing a wait by its kind and key, its event and that event's
// data, or its decision's response value, without a cast or a generic
// argument. An event or decision of another workflow, data or a value of
// another one, a key no task or decision has and a `.start`, `.get` or
// `.cancel` all fail. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type {
  AnyWorkflowReference,
  DecisionContextOf,
  DecisionOutputOf,
  DecisionValueOf,
  EventDataOf,
  Id,
  WorkflowDecisionWait,
  WorkflowEventReference,
  WorkflowEventsOf,
  WorkflowArgsOf,
  WorkflowReturnOf,
  WorkflowWaitOf,
} from "../src/index.ts";
import {
  useForm,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "../src/react.ts";
import type { DecisionAnswer } from "../src/react.ts";
import { workflows } from "./notes/server/_generated/api.ts";

/**
 * How a page sends an event to a run of `workflow`: one of that
 * workflow's own events, with its data, inferred from the event alone.
 */
declare const send: <
  Workflow extends AnyWorkflowReference,
  Event extends WorkflowEventsOf<Workflow>[keyof WorkflowEventsOf<Workflow>],
>(
  workflow: Workflow,
  event: Event,
  data: NoInfer<EventDataOf<Event>>
) => Promise<void>;

declare const noteId: Id<"notes">;
declare const taskId: Id<"tasks">;
declare const untyped: unknown;
declare const runId: string;

const summarize = workflows.summarizeNote;
const archive = workflows.archiveNotes;

// A run's args and result, from the reference alone.
expectTypeOf<WorkflowArgsOf<typeof summarize>>().toEqualTypeOf<{
  noteId: Id<"notes">;
  style?: "short" | "long";
}>();
expectTypeOf<WorkflowReturnOf<typeof summarize>>().toEqualTypeOf<{
  summary: string;
  words: number;
}>();
expectTypeOf<WorkflowArgsOf<typeof archive>>().toEqualTypeOf<
  Record<never, never>
>();
expectTypeOf<WorkflowReturnOf<typeof archive>>().toEqualTypeOf<null>();
expectTypeOf(summarize.name).toEqualTypeOf<"workflows.summarizeNote">();

// Names only: no children that act, no contract, and no phantom names.
expectTypeOf<Extract<keyof typeof summarize, string>>().toEqualTypeOf<
  "name" | "events" | "decisions" | "queries" | "mutations"
>();
// @ts-expect-error -- a reference holds no descriptor of the declaration's
void summarize.args;
// @ts-expect-error -- nor the release it was generated in
void summarize.resourceId;

// Each event is named under its workflow, literally.
const edited = summarize.events.noteEdited;
expectTypeOf(
  edited.name
).toEqualTypeOf<"workflows.summarizeNote.events.noteEdited">();
expectTypeOf<Extract<keyof typeof edited, string>>().toEqualTypeOf<"name">();
expectTypeOf<EventDataOf<typeof edited>>().toEqualTypeOf<{
  noteId: Id<"notes">;
  title?: string;
}>();
expectTypeOf<EventDataOf<typeof summarize.events.styleChosen>>().toEqualTypeOf<{
  style: "short" | "long";
}>();
expectTypeOf<keyof typeof summarize.events>().toEqualTypeOf<
  "noteEdited" | "styleChosen"
>();
// @ts-expect-error -- an event the workflow doesn't declare
void summarize.events.documentUploaded;

// Sending infers the data from the event, never from what is passed.
void send(summarize, edited, { noteId });
void send(summarize, edited, { noteId, title: "Renamed" });
void send(summarize, summarize.events.styleChosen, { style: "long" });
void send(archive, archive.events.confirmed, { confirmed: true });
// @ts-expect-error -- a note's ID, not a task's
void send(summarize, edited, { noteId: taskId });
// @ts-expect-error -- a field the event doesn't carry
void send(summarize, edited, { noteId, words: 3 });
// @ts-expect-error -- another event's data
void send(summarize, summarize.events.styleChosen, { noteId });
// @ts-expect-error -- a value outside the enum
void send(summarize, summarize.events.styleChosen, { style: "medium" });
// @ts-expect-error -- another workflow's event
void send(summarize, archive.events.confirmed, { confirmed: true });
// @ts-expect-error -- a hand-written event, not a generated reference
void send(summarize, "noteEdited", { noteId });
// @ts-expect-error -- untyped data where the event declares its own
void send(summarize, edited, untyped);

// Waits narrow by kind, then key, to the event a task listens for.
declare const wait: WorkflowWaitOf<typeof summarize>;
if (wait.kind === "event") {
  expectTypeOf(wait.key).toEqualTypeOf<"do/0/chooseStyle" | "do/2/awaitEdit">();
  expectTypeOf(wait.canSend).toEqualTypeOf<boolean>();
  if (wait.key === "do/0/chooseStyle") {
    expectTypeOf(wait.event).toEqualTypeOf<
      typeof summarize.events.styleChosen
    >();
    expectTypeOf<EventDataOf<typeof wait.event>>().toEqualTypeOf<{
      style: "short" | "long";
    }>();
    void send(summarize, wait.event, { style: "short" });
    // @ts-expect-error -- the data of an event this task doesn't listen for
    void send(summarize, wait.event, { noteId });
  }
  if (wait.key === "do/2/awaitEdit") {
    // Two events: the name narrows to one.
    if (wait.event.name === "workflows.summarizeNote.events.noteEdited") {
      expectTypeOf<EventDataOf<typeof wait.event>>().toEqualTypeOf<{
        noteId: Id<"notes">;
        title?: string;
      }>();
    } else {
      expectTypeOf(
        wait.event.name
      ).toEqualTypeOf<"workflows.summarizeNote.events.styleChosen">();
    }
  }
  // @ts-expect-error -- no listen task has this path
  void (wait.key === "do/9/nothing");
}
if (wait.kind === "timer") {
  expectTypeOf(wait.key).toEqualTypeOf<string>();
  expectTypeOf(wait.purpose).toEqualTypeOf<"sleep" | "retry">();
  // @ts-expect-error -- a timer has no event
  void wait.event;
}

// A run of archiveNotes listens for its own event only.
declare const archiveWait: WorkflowWaitOf<typeof archive>;
if (archiveWait.kind === "event") {
  expectTypeOf(archiveWait.key).toEqualTypeOf<"do/0/confirm">();
  expectTypeOf(archiveWait.event).toEqualTypeOf<
    typeof archive.events.confirmed
  >();
  // @ts-expect-error -- archiveNotes's wait carries none of summarizeNote's events
  void send(summarize, archiveWait.event, { confirmed: true });
}

// The generic event reference stays usable where any event is shown.
const anyEvent: WorkflowEventReference = edited;
void anyEvent;

/**
 * How a page answers a decision a run of its workflow is held at: the
 * exact wait, and a value inferred from that wait alone.
 */
declare const respond: <Wait extends WorkflowDecisionWait>(
  wait: Wait,
  response: {
    readonly approved: boolean;
    readonly value: NoInfer<DecisionValueOf<Wait>>;
  }
) => Promise<void>;

// Each decision is named under its workflow, literally, its value's and
// context's types phantom.
const approve = summarize.decisions.approveSummary;
expectTypeOf(
  approve.name
).toEqualTypeOf<"workflows.summarizeNote.decisions.approveSummary">();
expectTypeOf<DecisionValueOf<typeof approve>>().toEqualTypeOf<{
  comment: string;
  rating?: number;
}>();
expectTypeOf<DecisionContextOf<typeof approve>>().toEqualTypeOf<{
  noteId: Id<"notes">;
  summary: string;
}>();
expectTypeOf<
  DecisionValueOf<typeof summarize.decisions.chooseLength>
>().toEqualTypeOf<"short" | "long">();
expectTypeOf<
  DecisionValueOf<typeof archive.decisions.confirmArchive>
>().toEqualTypeOf<null>();
expectTypeOf<keyof typeof summarize.decisions>().toEqualTypeOf<
  "approveSummary" | "chooseLength"
>();
// @ts-expect-error -- a decision the workflow doesn't declare
void summarize.decisions.reviewInvoice;
// @ts-expect-error -- read-only schema metadata: nothing answers through it
void approve.respond;
// @ts-expect-error -- a name, with no value schema of its own
void approve.valueSchema;
expectTypeOf<DecisionOutputOf<typeof approve>>().toEqualTypeOf<{
  comment: string;
  rating?: number;
}>();

// A decision's answer form is typed from its reference alone.
export const useDecisionFormChecks = (): void => {
  void useForm(approve, {
    defaultValues: { approved: false, value: { comment: "" } },
    onSubmit: (answer) => {
      expectTypeOf(answer).toEqualTypeOf<
        DecisionAnswer<{ comment: string; rating?: number }>
      >();
    },
  });
  void useForm(summarize.decisions.chooseLength, {
    defaultValues: { approved: true, value: "short" },
    onSubmit: () => null,
  });
  // @ts-expect-error -- chooseLength's value, not approveSummary's
  void useForm(approve, {
    defaultValues: { approved: false, value: "short" },
    onSubmit: () => null,
  });
  // @ts-expect-error -- an answer says whether it approves
  void useForm(approve, {
    defaultValues: { value: { comment: "" } },
    onSubmit: () => null,
  });
};

// Decision waits narrow by key to their own value, never another's.
if (wait.kind === "decision") {
  expectTypeOf(wait.key).toEqualTypeOf<"approveSummary" | "chooseLength">();
  expectTypeOf(wait.canRespond).toEqualTypeOf<boolean>();
  if (wait.key === "approveSummary") {
    void respond(wait, { approved: true, value: { comment: "Checked." } });
    void respond(wait, {
      approved: false,
      value: { comment: "Too long.", rating: 2 },
    });
    // @ts-expect-error -- chooseLength's value, not approveSummary's
    void respond(wait, { approved: true, value: "short" });
    // @ts-expect-error -- a field the value doesn't declare
    void respond(wait, { approved: true, value: { comment: "", by: "ada" } });
    // @ts-expect-error -- no value at all where one is declared
    void respond(wait, { approved: true });
    // @ts-expect-error -- untyped where the decision declares its value
    void respond(wait, { approved: true, value: untyped });
  }
  if (wait.key === "chooseLength") {
    void respond(wait, { approved: true, value: "long" });
    // @ts-expect-error -- outside the enum
    void respond(wait, { approved: true, value: "medium" });
  }
  // @ts-expect-error -- no decision has this key
  void (wait.key === "reviewInvoice");
}
declare const eventWait: Extract<
  WorkflowWaitOf<typeof summarize>,
  { readonly kind: "event" }
>;
// @ts-expect-error -- an event wait is no decision to answer
void respond(eventWait, { approved: true, value: null });

declare const archiveDecision: Extract<
  WorkflowWaitOf<typeof archive>,
  { readonly kind: "decision" }
>;
expectTypeOf(archiveDecision.key).toEqualTypeOf<"confirmArchive">();
void respond(archiveDecision, { approved: true, value: null });
// @ts-expect-error -- archiveNotes's decision takes no comment
void respond(archiveDecision, { approved: true, value: { comment: "" } });

// The ordinary queries (spec 10.7.2): typed public query references, read
// through useQuery and usePaginatedQuery, never commands.
export const useQueryChecks = (): void => {
  const { queries } = summarize;
  expectTypeOf<keyof typeof queries>().toEqualTypeOf<
    "run" | "canStart" | "runs" | "history" | "decisions" | "decision"
  >();
  // @ts-expect-error -- a query, never a command
  void useMutation(queries.runs);

  // Runs: a status filter, paged; rows without result or error.
  const runs = usePaginatedQuery(queries.runs, {}, { initialPageSize: 25 });
  void usePaginatedQuery(
    queries.runs,
    { status: "failed" },
    { initialPageSize: 25 }
  );
  void usePaginatedQuery(
    queries.runs,
    // @ts-expect-error -- not a run status
    { status: "lost" },
    { initialPageSize: 25 }
  );
  for (const row of runs.items) {
    expectTypeOf(row.run).toEqualTypeOf<{
      manifestHash: string;
      runId: string;
      workflowId: string;
      workflowVersion: number;
    }>();
    expectTypeOf(row.canWatch).toEqualTypeOf<boolean>();
    if (row.status === "compensating") {
      expectTypeOf(row.cause).toEqualTypeOf<"failure" | "cancellation">();
    }
    // @ts-expect-error -- a run's row never carries its result
    void row.result;
  }

  // History: one run's rows, narrowed by kind to their declared keys.
  const history = usePaginatedQuery(
    queries.history,
    { runId },
    { initialPageSize: 50 }
  );
  // @ts-expect-error -- history is of one run
  void usePaginatedQuery(queries.history, {}, { initialPageSize: 50 });
  for (const row of history.items) {
    expectTypeOf(row.sequence).toEqualTypeOf<number>();
    if (row.kind === "event") {
      expectTypeOf(row.key).toEqualTypeOf<"noteEdited" | "styleChosen">();
    }
    if (row.kind === "decision") {
      expectTypeOf(row.key).toEqualTypeOf<"approveSummary" | "chooseLength">();
    }
    if (row.kind === "step" && row.state === "failed") {
      expectTypeOf(row.error.code).toEqualTypeOf<string>();
    }
    if (row.kind === "step" && row.state !== "failed") {
      // @ts-expect-error -- only a failed step has an error
      void row.error;
    }
  }

  // The inbox: each item's exact wait answers with its own value.
  const inbox = usePaginatedQuery(
    queries.decisions,
    { runId },
    { initialPageSize: 20 }
  );
  void usePaginatedQuery(queries.decisions, {}, { initialPageSize: 20 });
  for (const item of inbox.items) {
    if (item.wait.key === "chooseLength") {
      void respond(item.wait, { approved: true, value: "short" });
      // @ts-expect-error -- approveSummary's value, not chooseLength's
      void respond(item.wait, { approved: true, value: { comment: "" } });
    }
  }

  // One decision's detail: null, or narrowed by its key to its context
  // and the exact wait to answer.
  const detail = useQuery(queries.decision, { runId, decisionId: "d" });
  // @ts-expect-error -- not a paginated query
  void usePaginatedQuery(queries.decision, { runId }, { initialPageSize: 1 });
  // @ts-expect-error -- the decision is named
  void useQuery(queries.decision, { runId });
  if (detail?.key === "approveSummary") {
    expectTypeOf(detail.context).toEqualTypeOf<{
      noteId: Id<"notes">;
      summary: string;
    }>();
    expectTypeOf(detail.prompt).toEqualTypeOf<string>();
    void respond(detail.wait, { approved: true, value: { comment: "Fine." } });
    // @ts-expect-error -- chooseLength's value
    void respond(detail.wait, { approved: true, value: "long" });
  }
  if (detail?.key === "chooseLength") {
    expectTypeOf(detail.context).toEqualTypeOf<{ words: number }>();
  }
  expectTypeOf(detail).toExtend<null | undefined | { readonly key: string }>();
};

// The ordinary mutations: typed public mutation references, called through
// useMutation, each taking what its descriptor declares.
export const useMutationChecks = (): void => {
  const { mutations } = summarize;
  expectTypeOf<keyof typeof mutations>().toEqualTypeOf<
    "start" | "pause" | "resume" | "cancel" | "send"
  >();
  const start = useMutation(mutations.start);
  void start({ args: { noteId } });
  // @ts-expect-error -- the workflow's args go under `args`
  void start({ noteId });
  void useMutation(mutations.cancel)({ runId: "run-1" });
  const sent = useMutation(mutations.send);
  void sent({ runId: "run-1", event: "styleChosen", data: { style: "short" } });
  // @ts-expect-error -- styleChosen's data is a style
  void sent({ runId: "run-1", event: "styleChosen", data: { style: 1 } });
  // @ts-expect-error -- an event the workflow doesn't declare
  void sent({ runId: "run-1", event: "documentUploaded", data: {} });
  // @ts-expect-error -- a mutation, never a query
  void useQuery(mutations.start, { args: { noteId } });
};
