import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

// The ideas Make something offers for a workflow (make-ideas.tsx): one
// for each business process (`@grasp-os/shared/business-processes`), in
// people's words, each named by its process. Those of the processes the
// organization's Apps and workflows already serve come first, so the
// examples are about its own work; the rest fill in, in a fixed order.

/** An idea: a few words to pick it by, and what it fills the box with. */
export interface MakeExample {
  process: BusinessProcess;
  title: MessageDescriptor;
  idea: MessageDescriptor;
}

const examples: Readonly<Record<BusinessProcess, MakeExample>> = {
  o2c: {
    process: "o2c",
    title: msg`Follow quotes to payment`,
    idea: msg`Follow every quote from the first call until the invoice is paid, and tell me which ones stall.`,
  },
  i2r: {
    process: "i2r",
    title: msg`Answer client questions`,
    idea: msg`Keep every client question in one place, and remind us when one waits too long for an answer.`,
  },
  p2p: {
    process: "p2p",
    title: msg`Approve big invoices`,
    idea: msg`Approve supplier invoices over €10,000 before they're paid.`,
  },
  r2c: {
    process: "r2c",
    title: msg`Keep the compliance checks`,
    idea: msg`Keep track of the yearly compliance checks: who does each one, by when, and proof that it was done.`,
  },
  r2r: {
    process: "r2r",
    title: msg`Track the month-end close`,
    idea: msg`Keep track of the month-end close: who does what, and remind people when they're late.`,
  },
  h2r: {
    process: "h2r",
    title: msg`Onboard a new hire`,
    idea: msg`Onboard a new hire: laptop, accounts and a first-week plan.`,
  },
};

/** The order the ideas fill in after the organization's own. */
const fillOrder: readonly BusinessProcess[] = [
  "p2p",
  "h2r",
  "r2r",
  "o2c",
  "i2r",
  "r2c",
];

/** How many ideas the page offers. */
const offered = 3;

/**
 * The ideas to offer: those of the processes in `served` first, in the
 * order the UI lists processes, then the rest in a fixed order.
 */
export const examplesFor = (
  served: Iterable<BusinessProcess | null>
): MakeExample[] => {
  const own = new Set(served);
  const first = businessProcesses.filter((process) => own.has(process));
  const rest = fillOrder.filter((process) => !own.has(process));
  return [...first, ...rest]
    .slice(0, offered)
    .map((process) => examples[process]);
};
