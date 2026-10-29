import { bindings } from "cf/config";
import { describe, expect, it } from "vite-plus/test";

import { adminWorker } from "./vite.config.ts";

// The admin's Worker as Vite runs it (the root config's "scripts"
// project, in Node): locally, workerd has no Durable Object
// jurisdictions, so the run objects must be reached outside one
// (src/workflow-runs.ts); a build must never carry that, or a deployment
// would keep its objects outside the EU. A local run also answers on
// localhost instead of moving to production's own hostname.

/** The bindings `command`'s Worker runs with, over `env` from cloudflare.config.ts. */
const envOf = (
  command: "serve" | "build",
  env: Record<string, unknown>
): unknown => {
  const { config } = adminWorker(command);
  if (config === undefined) {
    return env;
  }
  if (typeof config !== "function") {
    return { ...env, ...config.env };
  }
  // SAFETY: the admin's customizer reads `env` alone of the config it's
  // given (vite.config.ts, `adminWorker`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const shown = { env } as Parameters<typeof config>[0];
  return config(shown)?.env ?? env;
};

describe("the admin's Worker as Vite runs it", () => {
  it("is reached outside any jurisdiction and on localhost locally, keeping the other vars, and never in a build", () => {
    const env = { CLIENT_DOMAIN: bindings.text("grasp.test") };

    expect({
      serve: envOf("serve", env),
      build: envOf("build", env),
    }).toStrictEqual({
      serve: {
        CLIENT_DOMAIN: { type: "text", value: "grasp.test" },
        DURABLE_OBJECT_JURISDICTION: { type: "text", value: "none" },
        ADMIN_HOST: { type: "text", value: "" },
      },
      build: { CLIENT_DOMAIN: { type: "text", value: "grasp.test" } },
    });
  });
});
