import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";

/**
 * An independent workflow that has a person approve an invoice, as a
 * workflow's chat draws one (the fake model's `drawsApproval`,
 * e2e/model-scripts.ts): the run's input names the invoice and who
 * approves it, the approver decides through the release's own approval
 * contract (`grasp/approval`), and the run ends with whether they
 * approved and what they said. A grasp-workflow/1 document.
 */

/** A JSON Schema of an object with exactly `properties`, each required. */
const objectOf = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The workflow.json of the approval. */
export const invoiceApproval = (): string =>
  JSON.stringify(
    {
      $schema: workflowSchemaUrl,
      input: objectOf({
        invoice: { type: "string" },
        approver: { type: "string", "x-grasp-value": { kind: "person" } },
      }),
      output: {
        schema: objectOf({
          status: { type: "string" },
          comment: { type: "string" },
        }),
        value: {
          status: {
            $expr:
              'steps.approve.output.approved === true ? "approved" : "declined"',
          },
          comment: { $expr: 'steps.approve.output.payload?.comment ?? ""' },
        },
      },
      bindings: {
        approval: { kind: "decision", contract: "grasp/approval" },
      },
      steps: [
        {
          id: "approve",
          type: "decision",
          binding: "approval",
          recipients: { $expr: "[input.approver]" },
          prompt: { $expr: '"Approve invoice " + input.invoice' },
          input: { invoice: { $expr: "input.invoice" } },
        },
      ],
    },
    null,
    2
  );
