/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { describe, expect, it } from "vite-plus/test";

import { generateWorkflow } from "../src/generate.ts";
import { validateWorkflow } from "../src/validate.ts";
import { documentAround, options } from "./fixtures.ts";

// A decision's reminder and the action that tells its people (`remindAfter`
// and `ask` in `grasp.decision`'s `with`), as validation takes them and the
// build seals them for the host, which asks and reminds (core's
// resource-host.ts). Only the workflow's own action tells them: whatever
// the host passes it is no catalog contract's input.

/** A definition asking for a decision whose `with` adds `extra`. */
const deciding = (extra: Record<string, unknown>, timeout?: unknown) =>
  documentAround(
    {
      name: "deciding",
      bindings: {
        approval: { kind: "decision", contract: "invoice-approval" },
        notify: { kind: "operation", contract: "local:code/notify.ts#notify" },
        loadNote: { kind: "operation", contract: "notes.get" },
        summaryModel: { kind: "model", contract: "note-summary" },
      },
      input: { amount: { type: "number" } },
      required: ["amount"],
    },
    [
      {
        review: {
          call: "grasp.decision",
          with: {
            binding: "approval",
            recipients: ["role:admin"],
            prompt: "Approve the invoice",
            input: { amount: 1 },
            ...extra,
          },
          ...(timeout === undefined ? {} : { timeout }),
        },
      },
      { done: { set: { status: "done" } } },
    ]
  );

/** The errors validation refuses `definition` with, by code and pointer. */
const refusals = async (definition: unknown) => {
  const result = await validateWorkflow(JSON.stringify(definition), options);
  return result.ok
    ? []
    : result.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ code, pointer }) => ({ code, pointer }));
};

/** What generating `definition` makes: its decision call, or what it refused. */
const sealed = async (definition: unknown) => {
  const checked = await validateWorkflow(JSON.stringify(definition), options);
  if (!checked.ok) {
    throw new Error("The definition doesn't validate");
  }
  const generation = generateWorkflow(checked.workflow);
  if (!generation.ok) {
    return { unsupported: generation.unsupported };
  }
  const review = generation.tasks.find(({ id }) => id === "review");
  return { call: review?.kind === "call" ? review.call : undefined };
};

const pointer = "/do/0/review/with";

describe("a decision's reminder and ask", () => {
  it("seals a reminder and the workflow's own action that tells its people", async () => {
    await expect(
      sealed(
        deciding(
          { ask: "notify", remindAfter: { hours: 1 } },
          {
            after: { days: 1 },
          }
        )
      )
    ).resolves.toStrictEqual({
      call: {
        name: "grasp.decision",
        binding: "approval",
        recipients: { literal: ["role:admin"] },
        prompt: { literal: "Approve the invoice" },
        input: { literal: { amount: 1 } },
        timeoutMs: 86_400_000,
        remindAfterMs: 3_600_000,
        ask: {
          binding: "notify",
          module: "code/notify.ts",
          export: "notify",
        },
      },
    });
  });

  it("refuses an ask that is no action of the workflow's own, and a reminder's time that isn't a literal duration", async () => {
    await expect(
      Promise.all([
        refusals(deciding({ ask: "loadNote" })),
        refusals(deciding({ ask: "summaryModel" })),
        refusals(deciding({ ask: "nobody" })),
        refusals(deciding({ remindAfter: "${ $workflow.input.amount }" })),
        refusals(deciding({ remindAfter: { hours: 0 } })),
      ])
    ).resolves.toStrictEqual([
      [{ code: "binding.contract_mismatch", pointer: `${pointer}/ask` }],
      [{ code: "binding.wrong_kind", pointer: `${pointer}/ask` }],
      [{ code: "binding.unknown", pointer: `${pointer}/ask` }],
      [{ code: "profile.invalid_value", pointer: `${pointer}/remindAfter` }],
      [{ code: "profile.invalid_value", pointer: `${pointer}/remindAfter` }],
    ]);
  });

  it("refuses to seal a reminder due at or after the decision's deadline", async () => {
    const result = await sealed(
      deciding({ remindAfter: "PT1H" }, { after: { hours: 1 } })
    );

    expect(result).toStrictEqual({
      unsupported: [
        expect.objectContaining({
          pointer: `${pointer}/remindAfter`,
          feature: "decision:remindAfter",
        }),
      ],
    });
  });
});
