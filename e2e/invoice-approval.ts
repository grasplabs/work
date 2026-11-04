/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */

/**
 * An independent workflow that has a person approve an invoice, as a
 * workflow's chat draws one (the fake model's `drawsApproval`,
 * e2e/model-scripts.ts): the run's input names the invoice and who
 * approves it, the approver decides through the release's own approval
 * contract (`grasp/approval`), and the run ends with whether they
 * approved and what they said. Grasp's Open Workflow profile, as JSON.
 */

/** A JSON Schema of an object with exactly `properties`, each required. */
const objectOf = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The workflow.json of workflow `name`. */
export const invoiceApproval = (name: string): string =>
  JSON.stringify(
    {
      document: {
        dsl: "1.0.3",
        namespace: "workspace",
        name,
        version: "1.0.0",
        title: name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: {
              approval: { kind: "decision", contract: "grasp/approval" },
            },
          },
        },
      },
      input: {
        schema: objectOf({
          invoice: { type: "string" },
          approver: { type: "string" },
        }),
      },
      output: {
        schema: objectOf({
          status: { type: "string" },
          comment: { type: "string" },
        }),
      },
      do: [
        {
          approve: {
            call: "grasp.decision",
            with: {
              binding: "approval",
              recipients: "${ [$workflow.input.approver] }",
              prompt: '${ "Approve invoice " + $workflow.input.invoice }',
              input: { invoice: "${ $workflow.input.invoice }" },
            },
            export: {
              as: '${ {approved: .approved, comment: (.value.comment // "")} }',
            },
          },
        },
        {
          finish: {
            set: {
              status:
                '${ if $context.approved then "approved" else "declined" end }',
              comment: "${ $context.comment }",
            },
          },
        },
      ],
    },
    null,
    2
  );
