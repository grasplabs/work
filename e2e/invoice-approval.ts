import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";

/**
 * An independent workflow that has a person approve an invoice, as a
 * workflow's chat draws one (the fake model's `drawsApproval`,
 * e2e/model-scripts.ts): the run's args name the invoice and who
 * approves it, the approver decides through the release's own approval
 * contract (`grasp/approval`), and the run ends with whether they
 * approved and what they said. A grasp-workflow/2 document: a decision's
 * result may be a timeout (with no timeout of its own, at the run's
 * deadline), so its expressions read `timedOut` before the answer.
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
      args: objectOf({
        invoice: { kind: "string" },
        approver: { kind: "person" },
      }),
      returns: objectOf({
        status: { kind: "string" },
        comment: { kind: "string" },
      }),
      result: {
        status: {
          $expr:
            '!approve.timedOut && approve.approved ? "approved" : "declined"',
        },
        comment: {
          $expr: 'approve.timedOut ? "" : (approve.payload?.comment ?? "")',
        },
      },
      permissions: {
        decisions: { approval: { contract: "grasp/approval" } },
      },
      steps: [
        {
          id: "approve",
          type: "decide",
          decision: "approval",
          recipients: { $expr: "[args.approver]" },
          prompt: { $expr: '"Approve invoice " + args.invoice' },
          input: { invoice: { $expr: "args.invoice" } },
        },
      ],
    },
    null,
    2
  );
