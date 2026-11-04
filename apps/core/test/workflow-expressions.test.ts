import type { Role } from "@grasp-os/shared/roles";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, evaluating } from "./workflow-apps.ts";

// The workflow SDK's `evaluate` in a real run: jq runs in the run's own
// isolate, from the WebAssembly the release loads beside the SDK's
// modules, and needs nothing of core's while it does. What it evaluates
// and refuses is the SDK's to test (packages/sdk's expressions.test.ts);
// here, that a run's isolate has it, type-checked as App code is, and that
// an expression's failure fails its step as the evaluator says it.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

/** How `run` ended, as its starter sees it. */
const outcomeOf = async (
  person: Awaited<ReturnType<typeof personApi>>,
  run: string
) => {
  const { status, failure, output } = await person.api.workflows.status(run);
  return { status, output, step: failure?.step, code: failure?.error.code };
};

describe("a run's expressions", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("evaluate jq in the run's own isolate, as its step's result", async () => {
    const admin = await personApi("admin");
    const app = await appWith(
      admin,
      evaluating("{ total: (.lines | map(.qty * .price) | add) }")
    );
    const run = await admin.api.workflows.start(app, "priced", {
      lines: [
        { qty: 2, price: 150 },
        { qty: 1, price: 900 },
      ],
    });
    await finished(run.id);
    await expect(outcomeOf(admin, run.id)).resolves.toStrictEqual({
      status: "completed",
      output: { total: 1200 },
      step: undefined,
      code: undefined,
    });
  });

  it("fail the step of an expression that fails, with the evaluator's error", async () => {
    const admin = await personApi("admin");
    const app = await appWith(admin, evaluating("[range(0; 100000000)]"));
    const run = await admin.api.workflows.start(app, "priced", {});
    await finished(run.id);
    await expect(outcomeOf(admin, run.id)).resolves.toMatchObject({
      status: "failed",
      step: "price",
      code: "expression.resource_exhausted",
    });
  });
});
