// Compile-time guarantees of the workflow references the host generates
// (spec 10.4.1, 10.4.5, 10.4.6, 10.7.2, 10.7.9), checked against the
// Notes fixture's generated `workflows`: a workflow's input, output,
// waits and events are inferred from its reference alone, and after
// narrowing a wait by its kind and key, its event and that event's data,
// without a cast or a generic argument. An event of another workflow, data
// of another event, a key no task has and a `.start`, `.get` or `.cancel`
// all fail. Type-checked by `vp check`, never run: every
// `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type {
  AnyWorkflowReference,
  EventDataOf,
  Id,
  RunHandle,
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
