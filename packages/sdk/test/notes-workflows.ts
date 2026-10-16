import type { BoundWorkflow } from "../src/host.ts";
import { v } from "../src/index.ts";
import { descriptorOf } from "../src/value-schema.ts";

// The workflows the Notes fixture binds, as the host resolves its
// bindings against the approved records: what `.grasp/references.ts` is
// generated with beside the App's manifest. `summarizeNote` takes a
// note's ID and gives its summary, and listens for two events in two
// tasks; `archiveNotes` takes nothing, gives nothing, and listens for a
// confirmation.

export const notesWorkflows: readonly BoundWorkflow[] = [
  {
    alias: "summarizeNote",
    input: descriptorOf(
      v.object({
        noteId: v.id("notes"),
        style: v.enum(["short", "long"]).default("short"),
      })
    ),
    output: descriptorOf(
      v.object({ summary: v.string(), words: v.number().integer() })
    ),
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
  },
  {
    alias: "archiveNotes",
    input: descriptorOf(v.object({})),
    output: descriptorOf(v.null()),
    events: {
      confirmed: {
        type: "notes.archive.confirmed",
        data: descriptorOf(v.object({ confirmed: v.boolean() })),
      },
    },
    listens: { "do/0/confirm": ["confirmed"] },
  },
];
