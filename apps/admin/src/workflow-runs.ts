/**
 * The admin's workflow runs, on Workerflow (@grasp-os/workerflow), the
 * engine core runs on: one SQLite Durable Object per run, all of one
 * class (`AdminRuns`, src/run-object.ts), which runs each by the name of
 * the definition it was started under. A binding here has the `create`
 * and `get` of Cloudflare Workflows' own, so a caller starts and wakes a
 * run as it did on Workflows.
 *
 * Runs keep their data in the EU, as every Durable Object does. workerd
 * has no jurisdictions (tests, local runs), which pass
 * `DURABLE_OBJECT_JURISDICTION=none` (src/env.d.ts).
 */
import { Workflow } from "@grasp-os/workerflow/binding";

import type { AdminRuns } from "./run-object.ts";

/** The name each of the admin's workflows is started under. */
export const adminWorkflows = {
  /** A build of an integration (src/builds/workflow.ts). */
  integrationBuild: "integration-build",
} as const;

/** One of the admin's workflows, by name. */
export type AdminWorkflow =
  (typeof adminWorkflows)[keyof typeof adminWorkflows];

/** The namespace of the admin's runs, in the EU unless turned off. */
export const adminRuns = (
  env: Pick<Env, "ADMIN_RUNS" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectNamespace<AdminRuns> =>
  env.DURABLE_OBJECT_JURISDICTION === "none"
    ? env.ADMIN_RUNS
    : env.ADMIN_RUNS.jurisdiction("eu");

/**
 * The binding of `workflow`'s runs: `create`, `get` and the rest, as
 * Cloudflare Workflows' binding has them. Runs are kept for 30 days once
 * they end, Workerflow's default.
 */
export const adminWorkflow = <Params>(
  env: Pick<Env, "ADMIN_RUNS" | "DURABLE_OBJECT_JURISDICTION">,
  workflow: AdminWorkflow
): Workflow<Params> => new Workflow<Params>(adminRuns(env), workflow);
