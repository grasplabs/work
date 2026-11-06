// What the host runs the Notes fixture from, as it generates the entry for
// every App (the compiler's `serverEntrySource`): its parts, registered
// together.
import { registerApp } from "../../../src/runner.ts";
import config from "../grasp.config.ts";
import schema from "../server/schema.ts";
import * as m0 from "../server/notes.ts";

export default registerApp({
  config,
  schema,
  modules: { notes: m0 },
  migrations: [],
});
