import { app, resource, v } from "@grasp-os/sdk";

import { guests, invite, notes, overview, revoke } from "./operations/chats.ts";
import {
  create,
  discard,
  get,
  keep,
  list,
  propose,
  reviewer,
  save,
  saved,
  source,
  statementsOf,
} from "./operations/drafts.ts";
import schema, { notesMax, statementTags } from "./schema.ts";

// The intake: drafts of what people say about their work, reviewed and
// saved as sources and their statements, in the App's own store
// (schema.ts). Intake is its builders' (an admin is one on every App):
// the store refuses anyone else every read and write of it, so a member
// who opens the App sees that it isn't theirs, and its actions, which
// check the same (operations/chats.ts), invite and read no one's chats
// for them.
//
// Notes are read by `extract`, an independent workflow each copy of the
// intake gets of its own, bound under that alias (the blueprint's
// workflows/extract.json): a model lists each claim in the notes, and the
// screen keeps what it found as a draft (`drafts.propose`), as the person
// who started the run. The workflow calls nothing of the App: a chat is
// read as notes by the App's own `chats.notes` before the run starts.
// Until an admin grants the App's request to start it (`EXTRACT`), and
// approves the model it reads with (its `extractor` binding, on the
// workflow's page), reading notes fails: an App and a workflow start with
// access to nothing. The workflow is its creator's: its model is called
// only for someone with a role in it (its owner, the organization's
// admins, and whom the owner shares it with), which a role in the App
// never gives. Stakeholder chats are `guests`, bound to the `GUESTS`
// permission.

/** A chat's line, as the model reads it: who said it, and what. */
const line = v.object({
  role: v.enum(["guest", "question"]),
  text: v.string(),
});

/**
 * The notes `extract` reads, as text, and a chat's as its lines (none for
 * pasted notes), and the claims it found in them.
 */
export const extract = resource.workflow("extract", {
  input: v.object({
    notes: v.string().min(1).max(notesMax),
    lines: v.array(line),
  }),
  output: v.object({
    statements: v.array(
      v.object({
        text: v.string(),
        tags: v.array(v.enum(statementTags)),
        quote: v.string(),
      })
    ),
  }),
});

const builders = { read: "appBuilders", write: "appBuilders" } as const;

export default app({
  name: "Intake",
  schema,
  access: {
    tables: { drafts: builders, sources: builders, statements: builders },
  },
  operations: {
    drafts: {
      reviewer,
      list,
      get,
      saved,
      source,
      statementsOf,
      create,
      propose,
      keep,
      discard,
      save,
    },
    chats: { overview, invite, revoke, notes },
  },
  internalOperations: {},
  screens: [{ name: "intake", path: "/", source: "screens/intake.tsx" }],
  uses: [extract, guests],
});
