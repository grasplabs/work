import { app } from "@grasp-os/sdk";

import { hello } from "./operations/greetings.ts";
import schema from "./schema.ts";

/** The built-in blueprint core's tests install: it greets its members. */
export default app({
  name: "Hello",
  schema,
  access: {
    tables: { greetings: { read: "appMembers", write: "appMembers" } },
  },
  operations: { greetings: { hello } },
  internalOperations: {},
  screens: [],
  uses: [],
});
