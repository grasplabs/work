import { describe, expect, it } from "vite-plus/test";

import { provisionProbeSchema } from "../src/provision-probe.ts";

// The probe's answer as the admin reads it, from a core older or newer
// than the admin: client releases and the admin reach production apart.

/** A core's answer from before it named its release and schema. */
const older = {
  version: "version-1",
  clientId: "acme",
  bindings: { DB: true },
  clocks: { core: { armed: true, tasks: [] }, connect: null },
};

describe("the probe's answer", () => {
  it("reads a core that names no release or schema, one that does, and one that says more than the admin knows", () => {
    const named = {
      ...older,
      release: "26.11.1",
      schema: { DB: "0270_last.sql" },
    };
    expect({
      older: provisionProbeSchema.safeParse(older).data,
      named: provisionProbeSchema.safeParse(named).data,
      newer: provisionProbeSchema.safeParse({ ...named, later: "field" }).data,
    }).toStrictEqual({ older, named, newer: named });
  });
});
