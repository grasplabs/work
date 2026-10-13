import { app, resource } from "@grasp-os/sdk";

import schema from "./schema.ts";

// What the intake's workflows reach besides its server (app/server.ts):
// the model its extract workflow reads notes with (workflows/extract.ts),
// which an admin binds to a model the deployment allows, with any caps
// they set, on the engine's Resources tab. Until then, reading notes fails
// with `resource.unavailable`: an App starts with access to nothing.
//
// The bound on its answers holds for one reading as a whole: the workflow
// may ask once more for an answer that doesn't fit, so each ask gets half,
// 6,000 tokens, what the gateway gives the default model's answer anyway.
export const extractor = resource.model("extractor", {
  maxOutputTokens: 12_000,
});

export default app({
  name: "Intake",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [extractor],
});
