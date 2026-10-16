// Compile-time guarantees of the workflow references the host generates
// (spec 10.4.1, 10.4.5, 10.4.6, 10.7.2, 10.7.9), checked against the
// Notes fixture's generated `workflows`: a workflow's input, output,
// waits, events and decisions are inferred from its reference alone, and
// after narrowing a wait by its kind and key, its event and that event's
// data, or its decision's response value, without a cast or a generic
// argument. An event or decision of another workflow, data or a value of
// another one, a key no task or decision has and a `.start`, `.get` or
// `.cancel` all fail. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import { v } from "../src/index.ts";
import type {
  AnyWorkflowReference,
  DecisionContextOf,
  DecisionValueOf,
  EventDataOf,
  Id,
  Infer,
  InferInput,
  RunHandle,
  WorkflowDecisionWait,
  WorkflowEventReference,
  WorkflowEventsOf,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowWaitOf,
} from "../src/index.ts";
import { workflows } from "./notes/.grasp/references.ts";

/**
 * How a screen sends an event to a run of `workflow`: one of that
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

const summarize = workflows.summarizeNote;
const archive = workflows.archiveNotes;

// A run's input and output, from the reference alone.
expectTypeOf<WorkflowInputOf<typeof summarize>>().toEqualTypeOf<{
  noteId: Id<"notes">;
  style?: "short" | "long";
}>();
expectTypeOf<WorkflowOutputOf<typeof summarize>>().toEqualTypeOf<{
  summary: string;
  words: number;
}>();
expectTypeOf<WorkflowInputOf<typeof archive>>().toEqualTypeOf<
  Record<never, never>
>();
expectTypeOf<WorkflowOutputOf<typeof archive>>().toEqualTypeOf<null>();
expectTypeOf(summarize.alias).toEqualTypeOf<"summarizeNote">();

// Data and events only: no children that act, and no phantom names.
expectTypeOf<Extract<keyof typeof summarize, string>>().toEqualTypeOf<
  | "kind"
  | "visibility"
  | "resourceId"
  | "resourceVersion"
  | "alias"
  | "contractId"
  | "fingerprint"
  | "input"
  | "output"
  | "events"
  | "listens"
  | "decisions"
>();
// @ts-expect-error -- no generated start: runs go through useWorkflow
void summarize.start;
// @ts-expect-error -- nor get
void summarize.get;
// @ts-expect-error -- nor cancel
void summarize.cancel;

// Each event binds its workflow binding and its exact type, literally.
const edited = summarize.events.noteEdited;
expectTypeOf(edited.workflow).toEqualTypeOf<"workflows.summarizeNote">();
expectTypeOf(edited.alias).toEqualTypeOf<"noteEdited">();
expectTypeOf(edited.type).toEqualTypeOf<"notes.note.edited">();
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
    // Two events: the alias narrows to one.
    if (wait.event.alias === "noteEdited") {
      expectTypeOf<EventDataOf<typeof wait.event>>().toEqualTypeOf<{
        noteId: Id<"notes">;
        title?: string;
      }>();
    } else {
      expectTypeOf(wait.event.alias).toEqualTypeOf<"styleChosen">();
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
if (wait.kind === "child") {
  expectTypeOf(wait.child).toEqualTypeOf<RunHandle>();
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
 * How a screen answers a decision a run of its workflow is held at: the
 * exact wait, and a value inferred from that wait alone.
 */
declare const respond: <Wait extends WorkflowDecisionWait>(
  wait: Wait,
  response: {
    readonly approved: boolean;
    readonly value: NoInfer<DecisionValueOf<Wait>>;
  }
) => Promise<void>;

// Each decision binds its workflow binding and key, literally, and holds
// its value schema as data.
const approve = summarize.decisions.approveSummary;
expectTypeOf(approve.workflow).toEqualTypeOf<"workflows.summarizeNote">();
expectTypeOf(approve.key).toEqualTypeOf<"approveSummary">();
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
// @ts-expect-error -- a value schema is data: nothing to call
void approve.valueSchema["~standard"];

// A decision's form schema is built from its generated value schema.
const responseSchema = v.object({
  approved: v.boolean(),
  value: approve.valueSchema,
});
expectTypeOf<InferInput<typeof responseSchema>>().toEqualTypeOf<{
  approved: boolean;
  value: { comment: string; rating?: number };
}>();
expectTypeOf<Infer<typeof responseSchema>>().toEqualTypeOf<{
  approved: boolean;
  value: { comment: string; rating?: number };
}>();

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
