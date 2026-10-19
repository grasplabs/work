import type { WorkflowBindingExtras } from "../src/host.ts";
import { v } from "../src/index.ts";
import { descriptorOf } from "../src/value-schema.ts";

// What the host resolves of the workflows the Notes fixture declares
// (test/notes/app.ts), against the approved records of its bindings: what
// `.grasp/references.ts` is generated with beside the App's manifest.
// `summarizeNote` listens for two events in two tasks and asks two
// decisions of different values; `archiveNotes` listens for a
// confirmation and asks one decision with no value.

export const notesWorkflows: readonly WorkflowBindingExtras[] = [
  {
    alias: "summarizeNote",
    events: {
      styleChosen: {
        type: "notes.summary.style_chosen",
        data: descriptorOf(v.object({ style: v.enum(["short", "long"]) })),
      },
      noteEdited: {
        type: "notes.note.edited",
        data: descriptorOf(
          v.object({ noteId: v.id("notes"), title: v.string().optional() })
        ),
      },
    },
    listens: {
      "do/0/chooseStyle": ["styleChosen"],
      "do/2/awaitEdit": ["noteEdited", "styleChosen"],
    },
    decisions: {
      approveSummary: {
        value: descriptorOf(
          v.object({
            comment: v.string().max(500),
            rating: v.number().integer().min(1).max(5).optional(),
          })
        ),
        context: descriptorOf(
          v.object({ noteId: v.id("notes"), summary: v.string() })
        ),
      },
      chooseLength: {
        value: descriptorOf(v.enum(["short", "long"])),
        context: descriptorOf(v.object({ words: v.number().integer() })),
      },
    },
  },
  {
    alias: "archiveNotes",
    events: {
      confirmed: {
        type: "notes.archive.confirmed",
        data: descriptorOf(v.object({ confirmed: v.boolean() })),
      },
    },
    listens: { "do/0/confirm": ["confirmed"] },
    decisions: {
      confirmArchive: {
        value: descriptorOf(v.null()),
        context: descriptorOf(v.object({ count: v.number().integer() })),
      },
    },
  },
];
