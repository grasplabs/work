import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "../idp.ts";
import {
  definitionOf,
  endedRun,
  jsonWorkflowAppsOf,
  startedBy,
} from "../json-workflow-apps.ts";
import { unique } from "../sign-in.ts";

// An independent JSON workflow's run on-prem whose calculation the sandbox
// stops past its memory: the run fails at the calculation, as the sandbox
// host's stop. Its builder publishes and starts it through their session;
// the sandbox supervisor is real. Already covered: a calculation the
// sandbox kills past its CPU time, and one given up at its attempt's
// deadline (on-prem/workflow-compute.test.ts). Gone with App workflows: a
// step's own code, retried in a fresh session after the sandbox cut it
// off, and code spinning or filling memory between steps, which a JSON run
// has none of.

const { signedIn } = jsonWorkflowAppsOf(mockIdp());

/** A calculation that keeps more and more memory until it is stopped. */
const fills = `import { compute, v } from "@grasp-os/sdk/compute";

export const fill = compute({
  input: v.array(v.number()).max(10),
  output: v.number(),
  handler: (items) => {
    const held: number[][] = [items];
    for (;;) {
      held.push(new Array<number>(1_000_000).fill(held.length));
    }
  },
});
`;

describe("an independent JSON workflow's run on-prem", () => {
  it("fails at a calculation the sandbox stopped past its memory", async () => {
    const builder = await signedIn("builder");
    const workflow = await builder.api.workflowResources.create(
      `fills-${unique()}`
    );
    await builder.api.workflowResources.publish(workflow.id, {
      definition: definitionOf(
        [{ id: "fill", type: "do", binding: "fill", arguments: [1, 2, 3] }],
        {
          bindings: {
            fill: { kind: "compute", contract: "local:code/fill.ts#fill" },
          },
          status: { $expr: '"" + steps.fill.output' },
        }
      ),
      basedOn: null,
      modules: { "code/fill.ts": fills },
    });
    const run = await endedRun(
      builder,
      workflow.id,
      await startedBy(builder, workflow.id)
    );
    expect({ status: run.status, code: run.error?.code }).toStrictEqual({
      status: "failed",
      code: "workflow.compute_failed",
    });
  }, 120_000);
});
