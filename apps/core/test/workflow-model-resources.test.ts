import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";
import {
  answer,
  chooseModel,
  ended,
  greetingWorkflow,
  person,
  providerAnswering,
  started,
} from "./workflow-calls.ts";

// What an independent workflow's model calls spend, as admins read it in
// the models settings: every run of it counted, and a deleted workflow's
// spend kept by its ID.

const idp = mockIdp();

/** This month, as admins read spend in it, such as `2026-11`. */
const thisMonth = (): string =>
  new Date().toISOString().slice(0, "yyyy-mm".length);

/** What the models settings say an independent workflow spent this month. */
const workflowSpend = async (workflowId: string) => {
  const { session } = await signedInWithRole(idp, "admin");
  const { core } = await openRpc(session, {
    coreEnv: { ...env, SPEND_MONTH: thisMonth() },
  });
  const spend = await core.authenticate().models.spend();
  return spend.workflows.filter((each) => each.workflowId === workflowId);
};

describe("an independent workflow's model spend", () => {
  beforeAll(chooseModel);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts every run of it, as admins read it with its name and runs", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(
      answer('{"line":"Hello Ada"}'),
      answer('{"line":"Hello again"}')
    );
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ended(ada, workflow.id, await started(ada, workflow.id));
    }
    const read = await workflowSpend(workflow.id);
    const amount = read[0]?.amount ?? 0;
    expect(amount).toBeGreaterThan(0);
    expect(read).toStrictEqual([
      {
        appId: null,
        appName: null,
        workflowId: workflow.id,
        name: workflow.name,
        amount,
        runs: 2,
      },
    ]);
  });

  it("keeps a deleted workflow's spend for admins, by its ID, with no name to link it by", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await greetingWorkflow(ada, admin);
    await providerAnswering(answer('{"line":"Hello Ada"}'));
    await ended(ada, workflow.id, await started(ada, workflow.id));
    // Deleted since: its row stays, marked.
    await env.DB.prepare(
      "UPDATE workflow_resources SET deleted_at = ? WHERE id = ?"
    )
      .bind(Date.now(), workflow.id)
      .run();
    const read = await workflowSpend(workflow.id);
    expect(
      read.map(({ name, amount, runs }) => ({
        name,
        spent: amount > 0,
        runs,
      }))
    ).toStrictEqual([{ name: null, spent: true, runs: 1 }]);
  });
});
