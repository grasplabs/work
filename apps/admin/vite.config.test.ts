import type { WorkerConfig } from "@cloudflare/vite-plugin";
import { bindings } from "cf/config";
import { describe, expect, it } from "vite-plus/test";

import { adminWorker } from "./vite.config.ts";

// The admin's Worker as Vite runs it (the root config's "scripts"
// project, in Node): locally, workerd has no Durable Object
// jurisdictions, so the run objects must be reached outside one
// (src/workflow-runs.ts); a build must never carry that, or a deployment
// would keep its objects outside the EU. A local run also answers on
// localhost instead of moving to production's own hostname.

/**
 * The config `command`'s Worker runs with, from what cloudflare.config.ts
 * loaded: its name and its `env`.
 */
const configOf = (
  command: "serve" | "build",
  env: WorkerConfig["env"]
): unknown => {
  const loaded = { worker: { name: "grasp-admin", env } };
  const { config } = adminWorker(command);
  if (config === undefined) {
    return loaded;
  }
  // SAFETY: the admin's customizer reads the Worker's `env` alone of the
  // config it's given and carries the rest over (vite.config.ts,
  // `adminWorker`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return config(loaded as Parameters<typeof config>[0]);
};

describe("the admin's Worker as Vite runs it", () => {
  it("is reached outside any jurisdiction and on localhost locally, keeping the rest of its config, and never in a build", () => {
    const env = { CLIENT_DOMAIN: bindings.text("grasp.test") };

    expect({
      serve: configOf("serve", env),
      build: configOf("build", env),
    }).toStrictEqual({
      serve: {
        worker: {
          name: "grasp-admin",
          env: {
            CLIENT_DOMAIN: { type: "text", value: "grasp.test" },
            DURABLE_OBJECT_JURISDICTION: { type: "text", value: "none" },
            ADMIN_HOST: { type: "text", value: "" },
          },
        },
      },
      build: {
        worker: {
          name: "grasp-admin",
          env: { CLIENT_DOMAIN: { type: "text", value: "grasp.test" } },
        },
      },
    });
  });
});
