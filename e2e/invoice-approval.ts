import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";

/**
 * An independent workflow that has a person approve an invoice, as a
 * workflow's chat draws one (the fake model's `drawsApproval`,
 * e2e/model-scripts.ts): the run's input names the invoice and who
 * approves it, the approver decides through the release's own approval
 * contract (`grasp/approval`), and the run ends with whether they
 * approved and what they said. A grasp-workflow/1 document.
 */

/** A value's schema: an object of exactly `fields`, each required. */
const objectOf = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** The workflow.json of the approval. */
export const invoiceApproval = (): string =>
  JSON.stringify(
    {
      $schema: workflowSchemaUrl,
      input: objectOf({
        invoice: { kind: "string" },
        approver: { kind: "person" },
      }),
      output: {
        schema: objectOf({
          status: { kind: "string" },
          comment: { kind: "string" },
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
