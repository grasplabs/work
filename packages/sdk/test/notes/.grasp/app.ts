// What the host runs the Notes fixture from, as it generates the entry for
// every App (the compiler's `serverEntrySource`): its registration, with
// the functions its server modules export.
import { registerFunctions } from "../../../src/runner.ts";
import registered from "../app.ts";
import * as m0 from "../server/notes.ts";

export default registerFunctions(registered, {
  notes: m0,
});
