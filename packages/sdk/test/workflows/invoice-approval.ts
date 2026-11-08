import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

/**
 * The outside systems the sample invoice workflow talks to. The sample
 * takes them as arguments and tests stand them in.
 */
export interface InvoiceSystems {
  findPurchaseOrder: (number: string) => Promise<{ amount: number } | null>;
  book: (entry: { invoice: string; total: number }) => Promise<string>;
}

/**
 * Matches an incoming invoice to its purchase order, asks a person to
 * approve large invoices and books the invoice.
 */
export const invoiceWorkflow = (systems: InvoiceSystems) =>
  workflow(
    "invoice-approval",
    {
      input: z.object({
        number: z.string(),
        purchaseOrder: z.string(),
        /** In whole minor units: cents for EUR. */
        total: z.int(),
      }),
      params: {
        threshold: money({
          label: "Review invoices above",
          currency: "EUR",
          // €5,000.00
          default: 500_000,
          sensitive: true,
        }),
        reviewer: person({ label: "Reviewer", default: "team:finance" }),
      },
    },
    async (step, { input, params }) => {
      const order = await step.do(
        "match-po",
        { description: "Find the purchase order the invoice refers to" },
        async () => await systems.findPurchaseOrder(input.purchaseOrder)
      );
      if (!order) {
        return { status: "unmatched" } as const;
      }

      if (input.total > params.threshold) {
        const decision = await step.decision("review", {
          description: "Ask the reviewer to approve invoices above the limit",
          from: params.reviewer,
          timeout: "7 days",
        });
        if (decision.timedOut) {
          return { status: "timedOut" } as const;
        }
        if (!decision.approved) {
          return { status: "rejected" } as const;
        }
      }

      const entry = await step.do(
        "book",
        {
          description: "Book the invoice in the ledger",
          input: { invoice: input.number, total: input.total },
        },
        async ({ input: booking }) => await systems.book(booking)
      );
      return { status: "booked", entry } as const;
    }
  );
