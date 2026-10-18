import { app, resource } from "@grasp-os/sdk";

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
import schema from "./schema.ts";

// The intake: drafts of what people say about their work, reviewed and
// saved as sources and their statements, in the App's own store
// (schema.ts). Intake is its builders' (an admin is one on every App):
// the store refuses anyone else every read and write of it, so a member
// who opens the App sees that it isn't theirs, and its actions, which
// check the same (operations/chats.ts), invite and read no one's chats
// for them.
//
// The model its extract workflow reads notes with (workflows/extract.ts)
// is `extractor`, which an admin binds to a model the deployment allows,
// with any caps they set, on the engine's Resources tab; stakeholder chats
// are `guests`, bound to the `GUESTS` permission. Until then, reading
// notes or inviting someone fails with `resource.unavailable`: an App
// starts with access to nothing.
//
// The bound on the model's answers holds for one reading as a whole: the
// workflow may ask once more for an answer that doesn't fit, so each ask
// gets half, 3,000 tokens. A binding holds the whole bound to what its
// model can answer, as an action would ask for all of it: 6,000 tokens is
// the most the default model, Llama 3.3, gives one answer.
export const extractor = resource.model("extractor", {
  maxOutputTokens: 6000,
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
  uses: [extractor, guests],
});
