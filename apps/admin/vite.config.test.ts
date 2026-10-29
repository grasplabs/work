import { describe, expect, it } from "vite-plus/test";

import { adminWorker } from "./vite.config.ts";

// The admin's Worker as Vite runs it (the root config's "scripts"
// project, in Node): locally, workerd has no Durable Object
// jurisdictions, so the run objects must be reached outside one
// (src/workflow-runs.ts); a build must never carry that, or a deployment
// would keep its objects outside the EU.

/** The vars `command`'s Worker runs with, over `vars` from wrangler.jsonc. */
const varsOf = (
  command: "serve" | "build",
  vars: Record<string, string>
): unknown => {
  const { config } = adminWorker(command);
  if (config === undefined) {
    return vars;
  }
  if (typeof config !== "function") {
    return { ...vars, ...config.vars };
  }
  // SAFETY: the admin's customizer reads `vars` alone of the config it's
  // given (vite.config.ts, `adminWorker`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const shown = { vars } as Parameters<typeof config>[0];
  return config(shown)?.vars ?? vars;
};

describe("the admin's Worker as Vite runs it", () => {
  it("is reached outside any jurisdiction locally, keeping the other vars, and never in a build", () => {
    const vars = { CLIENT_DOMAIN: "grasp.test" };

    expect({
      serve: varsOf("serve", vars),
      build: varsOf("build", vars),
    }).toStrictEqual({
      serve: {
        CLIENT_DOMAIN: "grasp.test",
        DURABLE_OBJECT_JURISDICTION: "none",
      },
      build: { CLIENT_DOMAIN: "grasp.test" },
    });
  });
});
