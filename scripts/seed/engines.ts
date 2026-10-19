/**
 * The demo company's domains (core's Apps), each with workflows that run
 * on the local stack as they would anywhere: real code against
 * `@grasp-os/sdk`, with tests, that calls nothing outside Grasp, so a run
 * needs no connection. Inputs stand in for what a connection would bring
 * (an email, an invoice from the bookkeeping), so the seed starts each
 * run with one, and a few are bad on purpose, so some runs fail as real
 * ones do.
 */
import type { PersonKey, TeamName } from "./company.ts";

/** Every value an input holds: what a run is started with. */
export type Input = Record<string, unknown>;

/** How a run that waits on a decision is left: answered, or still open. */
export type Answer =
  | { by: PersonKey; approved: boolean; comment?: string }
  | "open";

/** One run the seed starts, before it moves it back in time. */
export interface RunPlan {
  by: PersonKey;
  input: Input;
  /** For a run that asks someone to decide. */
  answer?: Answer;
}

/** Draws from the seed's numbers, the same ones each time it runs. */
export interface Draw {
  /** A number from 0 up to 1. */
  next: () => number;
  /** One of `items`. */
  pick: <T>(items: readonly T[]) => T;
  /** A whole number from `min` to `max`. */
  between: (min: number, max: number) => number;
}

export interface WorkflowSeed {
  id: string;
  /** Who owns it, as in the prototype, when not its domain's owner. */
  owner?: PersonKey;
  /** The workflow's code and its tests. */
  code: string;
  tests: string;
  /** Person parameters, set to a team: who decides. */
  deciders?: Record<string, TeamName>;
  /**
   * Its schedule started its runs, each on a Monday morning, rather than
   * the people who start the others.
   */
  scheduled?: boolean;
  /**
   * The input field the day each run starts goes in (YYYY-MM-DD), for a
   * workflow whose result depends on it: runs are started today and moved
   * back, so it can't read the day from the clock.
   */
  dateInput?: string;
  /** The runs of the last 30 days, oldest first. */
  runs: (draw: Draw) => RunPlan[];
}

export interface EngineSeed {
  name: string;
  description: string;
  owner: PersonKey;
  /** The teams it is shared with, and their role in it. */
  teams: { team: TeamName; role: "user" | "builder" }[];
  agents: string;
  workflows: WorkflowSeed[];
}

/** Euros in cents, as money parameters and amounts hold them. */
const euros = (amount: number): number => Math.round(amount * 100);

// Opportunity-to-Cash

const clients = [
  "Fam. Willems",
  "D. Mulder",
  "Fam. van Leeuwen",
  "K. Jacobs",
  "S. de Jong",
  "Fam. Bakker",
  "T. Kok",
  "R. Bos",
  "L. Smit",
  "P. Meijer",
  "A. Visser",
  "H. Dekker",
  "Fam. Peeters",
  "J. de Graaf",
  "M. Hendriks",
] as const;

const towns = [
  "Utrecht",
  "Zeist",
  "Houten",
  "Bunnik",
  "Nieuwegein",
  "De Bilt",
] as const;

const requiredDocuments = [
  "identity",
  "payslip",
  "employer statement",
  "bank statements",
] as const;

const clientOnboarding = `import { workflow, z } from "@grasp-os/sdk/workflow";

/** What every application needs before it becomes a client file. */
const required = ${JSON.stringify(requiredDocuments)};

export default workflow(
  "client-onboarding",
  {
    params: {},
    input: z.object({
      client: z.string(),
      town: z.string(),
      documents: z.array(z.string()),
    }),
  },
  async (step, { input }) => {
    const missing = await step.do(
      "check-documents",
      { description: "Check which required documents the application lacks", locked: true },
      async () => {
        if (input.client.trim() === "") {
          throw new Error("The application has no client name, so no file can be opened for it.");
        }
        return required.filter((document) => !input.documents.includes(document));
      }
    );
    return await step.do(
      "open-file",
      { description: "Open the client file with what is still to chase", locked: true },
      async () => ({
        client: input.client,
        town: input.town,
        complete: missing.length === 0,
        chase: missing,
      })
    );
  }
);
`;

const clientOnboardingTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import intake from "./client-onboarding.ts";

export default workflowTests(intake, [
  {
    name: "opens a complete file when nothing is missing",
    input: { client: "Fam. Willems", town: "Utrecht", documents: ${JSON.stringify(requiredDocuments)} },
    expect: { output: { client: "Fam. Willems", town: "Utrecht", complete: true, chase: [] } },
  },
  {
    name: "lists the documents to chase",
    input: { client: "D. Mulder", town: "Zeist", documents: ["identity"] },
    expect: {
      output: {
        client: "D. Mulder",
        town: "Zeist",
        complete: false,
        chase: ["payslip", "employer statement", "bank statements"],
      },
    },
  },
  {
    name: "refuses an application without a client",
    input: { client: " ", town: "Zeist", documents: [] },
    expect: { error: "no client name" },
  },
]);
`;

const mortgageFiles = `import { person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "mortgage-files",
  {
    params: {
      advisers: person({ label: "Who takes files over", default: "role:admin" }),
    },
    input: z.object({ client: z.string(), loan: z.number(), chase: z.array(z.string()) }),
  },
  async (step, { input, params }) => {
    const summary = await step.do(
      "summarise",
      { description: "Summarise the file for the adviser", locked: true },
      async () => {
        if (input.chase.length > 0) {
          throw new Error(\`The file of \${input.client} still lacks: \${input.chase.join(", ")}.\`);
        }
        return { client: input.client, loan: input.loan };
      }
    );
    const decision = await step.decision("accept", {
      description: \`Take over the file of \${input.client}\`,
      from: params.advisers,
      // Advisers see what waits for them on their dashboard.
      ask: async () => {},
      timeout: "5 days",
    });
    if (decision.timedOut || !decision.approved) {
      return { ...summary, handedOver: false };
    }
    return { ...summary, handedOver: true, adviser: decision.by };
  }
);
`;

const mortgageFilesTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import handover from "./mortgage-files.ts";

export default workflowTests(handover, [
  {
    name: "hands a complete file over once an adviser takes it",
    input: { client: "Fam. Bakker", loan: 41500000, chase: [] },
    decisions: { accept: { approved: true, by: "mark" } },
    expect: { output: { client: "Fam. Bakker", loan: 41500000, handedOver: true, adviser: "mark" } },
  },
  {
    name: "keeps the file when no adviser takes it",
    input: { client: "T. Kok", loan: 28000000, chase: [] },
    decisions: { accept: { approved: false, by: "mark" } },
    expect: { output: { client: "T. Kok", loan: 28000000, handedOver: false } },
  },
  {
    name: "refuses a file that still lacks documents",
    input: { client: "R. Bos", loan: 30000000, chase: ["payslip"] },
    expect: { error: "still lacks: payslip" },
  },
]);
`;

const opportunityToCash: EngineSeed = {
  name: "Opportunity-to-Cash",
  description:
    "Everything from a first client conversation until the money is in the bank.",
  owner: "nina",
  teams: [
    { team: "Client onboarding", role: "builder" },
    { team: "Mortgage advice", role: "builder" },
  ],
  agents: `# Opportunity-to-Cash

From a mortgage application to a complete client file in an adviser's hands.

- \`client-onboarding\` checks the application for the four documents every file needs (identity, payslip, employer statement, bank statements) and opens the file with what is still to chase.
- \`mortgage-files\` hands a complete file to mortgage advice: an adviser takes it over, or it stays with onboarding.
`,
  workflows: [
    {
      id: "client-onboarding",
      owner: "nina",
      code: clientOnboarding,
      tests: clientOnboardingTests,
      runs: (draw) =>
        // The prototype's 42 a week, on working days.
        Array.from({ length: 180 }, (_, index) => {
          const missing = draw.next() < 0.45;
          const documents = missing
            ? requiredDocuments.filter(() => draw.next() < 0.6)
            : [...requiredDocuments];
          // Now and then an application comes in from the web form empty.
          const client = index % 13 === 7 ? "" : draw.pick(clients);
          return {
            by: "nina" as const,
            input: { client, town: draw.pick(towns), documents },
          };
        }),
    },
    {
      id: "mortgage-files",
      owner: "mark",
      code: mortgageFiles,
      tests: mortgageFilesTests,
      deciders: { advisers: "Mortgage advice" },
      runs: (draw) =>
        Array.from({ length: 16 }, (_, index) => {
          const lacking = index % 9 === 4;
          return {
            by: "nina" as const,
            input: {
              client: draw.pick(clients),
              loan: euros(draw.between(180, 520) * 1000),
              chase: lacking ? ["employer statement"] : [],
            },
            ...(lacking
              ? {}
              : {
                  answer:
                    index >= 13
                      ? "open"
                      : {
                          by: "mark" as const,
                          approved: index % 6 !== 2,
                          ...(index % 6 === 2
                            ? {
                                comment:
                                  "The valuation report is older than six months.",
                              }
                            : {}),
                        },
                }),
          };
        }),
    },
  ],
};

// Issue-to-Resolution

const subjects = [
  {
    subject: "Where is my file?",
    body: "I sent my payslip last week. Has my file gone to the lender yet?",
  },
  {
    subject: "Change of the monthly payment",
    body: "We want to pay off more each month from January. What do we need to send?",
  },
  {
    subject: "Copy of the offer",
    body: "Could you send me the offer again? I can't find the attachment.",
  },
  {
    subject: "Complaint about the valuation",
    body: "I'm not happy with how the valuation went and I want to file a complaint.",
  },
  {
    subject: "New bank account",
    body: "My bank account number changed. Please use the new one for the payments.",
  },
  {
    subject: "Early repayment",
    body: "We sold our old house. How much would an early repayment cost us?",
  },
  {
    subject: "Documents for the valuation",
    body: "Which documents does the valuer need from us before Thursday?",
  },
] as const;

const emailTriage = `import { workflow, z } from "@grasp-os/sdk/workflow";

/** Where each kind of question goes, by words that give it away. */
const queues = [
  { queue: "complaints", words: ["complaint", "not happy", "unacceptable"] },
  { queue: "payments", words: ["payment", "bank account", "repayment", "pay off"] },
  { queue: "documents", words: ["document", "payslip", "offer", "attachment"] },
  { queue: "file status", words: ["file", "lender", "status"] },
];

export default workflow(
  "email-triage",
  {
    params: {},
    input: z.object({ from: z.string(), subject: z.string(), body: z.string() }),
  },
  async (step, { input }) =>
    await step.do(
      "sort",
      { description: "Put the email in the queue that answers it", locked: true },
      async () => {
        const text = \`\${input.subject} \${input.body}\`.toLowerCase();
        if (input.body.trim() === "") {
          throw new Error(\`The email from \${input.from} has no text to sort.\`);
        }
        const found = queues.find(({ words }) => words.some((word) => text.includes(word)));
        return { from: input.from, queue: found?.queue ?? "general", urgent: found?.queue === "complaints" };
      }
    )
);
`;

const emailTriageTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import triage from "./email-triage.ts";

export default workflowTests(triage, [
  {
    name: "sends a complaint to the complaints queue, urgently",
    input: { from: "M. Hendriks", subject: "Complaint", body: "I'm not happy with the valuation." },
    expect: { output: { from: "M. Hendriks", queue: "complaints", urgent: true } },
  },
  {
    name: "sends a question about a file to file status",
    input: { from: "S. Peeters", subject: "Where is my file?", body: "Has it gone to the lender?" },
    expect: { output: { from: "S. Peeters", queue: "file status", urgent: false } },
  },
  {
    name: "refuses an empty email",
    input: { from: "R. Bos", subject: "Question", body: "" },
    expect: { error: "no text to sort" },
  },
]);
`;

const complaints = `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "complaints",
  {
    params: {
      limit: money({ label: "Compliance approves compensation above", currency: "EUR", default: 25000 }),
      compliance: person({ label: "Who approves compensation", default: "role:admin" }),
    },
    input: z.object({
      client: z.string(),
      about: z.string(),
      compensation: z.number(),
      /** The day it came in, as YYYY-MM-DD. */
      received: z.string(),
    }),
  },
  async (step, { input, params }) => {
    const registered = await step.do(
      "register",
      { description: "Register the complaint and set the acknowledgement deadline", locked: true },
      async () => {
        // Two working days after the day it came in.
        const due = new Date(\`\${input.received}T00:00:00Z\`);
        let workingDays = 0;
        while (workingDays < 2) {
          due.setUTCDate(due.getUTCDate() + 1);
          const day = due.getUTCDay();
          if (day !== 0 && day !== 6) {
            workingDays += 1;
          }
        }
        return { client: input.client, about: input.about, acknowledgeBy: due.toISOString().slice(0, 10) };
      }
    );
    if (input.compensation <= params.limit) {
      return { ...registered, compensation: input.compensation, approvedBy: null };
    }
    const decision = await step.decision("approve-compensation", {
      description: \`Approve compensation for \${input.client}\`,
      from: params.compliance,
      ask: async () => {},
      timeout: "3 days",
    });
    if (decision.timedOut || !decision.approved) {
      return { ...registered, compensation: 0, approvedBy: null };
    }
    return { ...registered, compensation: input.compensation, approvedBy: decision.by };
  }
);
`;

const complaintsTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import complaint from "./complaints.ts";

export default workflowTests(complaint, [
  {
    name: "offers small compensation without asking, and acknowledges within two working days",
    input: { client: "K. Mulder", about: "Waiting on the phone", compensation: 2500, received: "2026-10-05" },
    expect: {
      output: { client: "K. Mulder", about: "Waiting on the phone", acknowledgeBy: "2026-10-07", compensation: 2500, approvedBy: null },
    },
  },
  {
    name: "acknowledges a complaint from a Friday by Tuesday",
    input: { client: "R. Bos", about: "A late answer", compensation: 0, received: "2026-10-09" },
    expect: {
      output: { client: "R. Bos", about: "A late answer", acknowledgeBy: "2026-10-13", compensation: 0, approvedBy: null },
    },
  },
  {
    name: "asks compliance for larger compensation",
    input: { client: "M. Hendriks", about: "The valuation", compensation: 75000, received: "2026-10-05" },
    decisions: { "approve-compensation": { approved: true, by: "joost" } },
    expect: {
      output: { client: "M. Hendriks", about: "The valuation", acknowledgeBy: "2026-10-07", compensation: 75000, approvedBy: "joost" },
    },
  },
]);
`;

const issueToResolution: EngineSeed = {
  name: "Issue-to-Resolution",
  description:
    "Every client question or complaint, from the first message until it is solved.",
  owner: "lisa",
  teams: [
    { team: "Customer service", role: "builder" },
    { team: "Compliance", role: "user" },
  ],
  agents: `# Issue-to-Resolution

Every question and complaint that reaches customer service.

- \`email-triage\` puts each email from the shared inbox in the queue that answers it: file status, documents, payments, complaints, or general.
- \`complaints\` registers a complaint with its acknowledgement deadline, and asks compliance before offering compensation above the limit.
`,
  workflows: [
    {
      id: "email-triage",
      code: emailTriage,
      tests: emailTriageTests,
      runs: (draw) =>
        Array.from({ length: 46 }, (_, index) => {
          const mail = draw.pick(subjects);
          return {
            by: "lisa" as const,
            input: {
              from: draw.pick(clients),
              subject: mail.subject,
              // A forwarded calendar invite now and then: no text at all.
              body: index % 17 === 5 ? "" : mail.body,
            },
          };
        }),
    },
    {
      id: "complaints",
      owner: "joost",
      code: complaints,
      tests: complaintsTests,
      dateInput: "received",
      deciders: { compliance: "Compliance" },
      runs: (draw) =>
        Array.from({ length: 11 }, (_, index) => {
          const large = index % 3 !== 1;
          return {
            by: "lisa" as const,
            input: {
              client: draw.pick(clients),
              about: draw.pick([
                "The valuation",
                "Waiting on the phone",
                "A late answer",
                "The advice fee",
              ]),
              compensation: large
                ? euros(draw.between(6, 12) * 50)
                : euros(draw.between(1, 4) * 25),
            },
            ...(large
              ? {
                  answer:
                    index === 9
                      ? "open"
                      : {
                          by: "joost" as const,
                          approved: index !== 5,
                        },
                }
              : {}),
          };
        }),
    },
  ],
};

// Purchase-to-Pay and Record-to-Report

const suppliers = [
  { supplier: "Kantoorhuis Utrecht", what: "Office rent", amount: 4180 },
  { supplier: "Hypotheekdata BV", what: "Data subscription", amount: 2950 },
  { supplier: "Brinkman ICT", what: "Laptops", amount: 1720 },
  { supplier: "Drukkerij Noord", what: "Brochures", amount: 640 },
  { supplier: "Eneco", what: "Energy", amount: 1315 },
  { supplier: "KPN", what: "Phones", amount: 486 },
  { supplier: "Schoonmaak Plus", what: "Cleaning", amount: 920 },
  { supplier: "Juridisch Advies Groep", what: "Legal advice", amount: 3400 },
] as const;

const supplierInvoices = `import { money, person, workflow, z } from "@grasp-os/sdk/workflow";

/** The ledger account each kind of cost is booked on. */
const accounts = [
  { account: "4100 Housing", words: ["rent", "energy", "cleaning"] },
  { account: "4300 Software and data", words: ["subscription", "laptops", "phones"] },
  { account: "4500 Marketing", words: ["brochures"] },
  { account: "4700 Advice", words: ["legal"] },
];

export default workflow(
  "supplier-invoices",
  {
    params: {
      limit: money({ label: "Approve invoices above", currency: "EUR", default: 250000 }),
      approvers: person({ label: "Who approves invoices", default: "role:admin" }),
    },
    input: z.object({
      supplier: z.string(),
      invoice: z.string(),
      description: z.string(),
      amount: z.number(),
      vatNumber: z.string().optional(),
    }),
  },
  async (step, { input, params }) => {
    const coded = await step.do(
      "code",
      { description: "Check the invoice and code it to a ledger account", locked: true },
      async () => {
        if (!input.vatNumber) {
          throw new Error(\`Invoice \${input.invoice} from \${input.supplier} has no VAT number.\`);
        }
        const text = input.description.toLowerCase();
        const found = accounts.find(({ words }) => words.some((word) => text.includes(word)));
        return { invoice: input.invoice, account: found?.account ?? "4900 Other costs" };
      }
    );
    if (input.amount <= params.limit) {
      return { ...coded, amount: input.amount, approved: true, approvedBy: null };
    }
    const decision = await step.decision("approve", {
      description: \`Approve invoice \${input.invoice} from \${input.supplier}\`,
      from: params.approvers,
      ask: async () => {},
      timeout: "7 days",
      remindAfter: "2 days",
    });
    const approved = !decision.timedOut && decision.approved;
    return { ...coded, amount: input.amount, approved, approvedBy: approved ? decision.by : null };
  }
);
`;

const supplierInvoicesTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import invoices from "./supplier-invoices.ts";

export default workflowTests(invoices, [
  {
    name: "codes a small invoice and books it without asking",
    input: { supplier: "KPN", invoice: "KPN-2291", description: "Phones", amount: 48600, vatNumber: "NL009292056B01" },
    expect: { output: { invoice: "KPN-2291", account: "4300 Software and data", amount: 48600, approved: true, approvedBy: null } },
  },
  {
    name: "asks finance to approve an invoice above the limit",
    input: { supplier: "Kantoorhuis Utrecht", invoice: "KU-1043", description: "Office rent", amount: 418000, vatNumber: "NL812345678B01" },
    decisions: { approve: { approved: true, by: "eva" } },
    expect: { output: { invoice: "KU-1043", account: "4100 Housing", amount: 418000, approved: true, approvedBy: "eva" } },
  },
  {
    name: "refuses an invoice without a VAT number",
    input: { supplier: "Drukkerij Noord", invoice: "DN-77", description: "Brochures", amount: 64000 },
    expect: { error: "has no VAT number" },
  },
]);
`;

const weeklyReport = `import { schedule, workflow, z } from "@grasp-os/sdk/workflow";

/** What the board pack holds, and who brings it. */
const sections = [
  { section: "Revenue and costs", from: "Exact" },
  { section: "New clients and files", from: "the CRM" },
  { section: "Inbox and complaints", from: "the service desk" },
  { section: "Commissions", from: "the lenders' statements" },
];

export default workflow(
  "weekly-report",
  {
    params: { every: schedule({ label: "Runs", default: "0 7 * * 1" }) },
    input: z.object({ week: z.string().optional() }).optional(),
    triggers: [{ type: "schedule", param: "every", timeZone: "Europe/Amsterdam" }],
  },
  async (step, { input }) =>
    await step.do(
      "plan",
      { description: "Plan the board pack for Monday's meeting", locked: true },
      async () => {
        const today = new Date();
        const monday = new Date(today);
        monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
        return {
          week: input?.week ?? monday.toISOString().slice(0, 10),
          sections,
          due: "10:00",
        };
      }
    )
);
`;

const weeklyReportTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import report from "./weekly-report.ts";

export default workflowTests(report, [
  {
    name: "plans the week's board pack",
    input: { week: "2026-10-05" },
    expect: {
      output: {
        week: "2026-10-05",
        sections: [
          { section: "Revenue and costs", from: "Exact" },
          { section: "New clients and files", from: "the CRM" },
          { section: "Inbox and complaints", from: "the service desk" },
          { section: "Commissions", from: "the lenders' statements" },
        ],
        due: "10:00",
      },
    },
  },
]);
`;

const purchaseToPay: EngineSeed = {
  name: "Purchase-to-Pay",
  description:
    "Everything from ordering from a supplier until their invoice is paid.",
  owner: "eva",
  teams: [
    { team: "Finance", role: "builder" },
    { team: "Operations", role: "user" },
  ],
  agents: `# Purchase-to-Pay

Supplier invoices, from the inbox to the books.

- \`supplier-invoices\` checks each supplier invoice for a VAT number, codes it to a ledger account, and asks finance to approve it when it is above the limit.
`,
  workflows: [
    {
      id: "supplier-invoices",
      code: supplierInvoices,
      tests: supplierInvoicesTests,
      deciders: { approvers: "Finance" },
      runs: (draw) =>
        Array.from({ length: 30 }, (_, index) => {
          const { supplier, what, amount } = draw.pick(suppliers);
          const cents = euros(amount * (0.9 + draw.next() * 0.2));
          const asks = cents > euros(2500);
          const noVat = index % 11 === 3;
          const prefix = supplier
            .split(" ")
            .map((word) => word.charAt(0))
            .join("");
          return {
            by: "jeroen" as const,
            input: {
              supplier,
              invoice: `${prefix}-${1000 + index * 7}`,
              description: what,
              amount: cents,
              ...(noVat
                ? {}
                : {
                    vatNumber: `NL8${String(index).padStart(2, "0")}315478B01`,
                  }),
            },
            ...(asks && !noVat
              ? {
                  answer:
                    index >= 27
                      ? "open"
                      : { by: "eva" as const, approved: index % 8 !== 6 },
                }
              : {}),
          };
        }),
    },
  ],
};

const recordToReport: EngineSeed = {
  name: "Record-to-Report",
  description:
    "Closing the books and producing the numbers leadership looks at.",
  owner: "eva",
  teams: [{ team: "Finance", role: "builder" }],
  agents: `# Record-to-Report

The numbers the board reads.

- \`weekly-report\` plans the board pack every Monday at 7:00, before the 10:00 meeting.
`,
  workflows: [
    {
      id: "weekly-report",
      code: weeklyReport,
      tests: weeklyReportTests,
      scheduled: true,
      dateInput: "week",
      runs: () =>
        Array.from({ length: 4 }, () => ({ by: "eva" as const, input: {} })),
    },
  ],
};

// Risk-to-Compliance

const countries = ["NL", "NL", "NL", "BE", "DE", "GB"] as const;

const kycReview = `import { person, workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "kyc-review",
  {
    params: {
      officers: person({ label: "Who clears high-risk clients", default: "role:admin" }),
    },
    input: z.object({
      client: z.string(),
      country: z.string(),
      politicallyExposed: z.boolean(),
      identity: z.string().optional(),
    }),
  },
  async (step, { input, params }) => {
    const screened = await step.do(
      "screen",
      { description: "Screen the client and score the risk", locked: true },
      async () => {
        if (!input.identity) {
          throw new Error(\`No identity document to check for \${input.client}.\`);
        }
        const risk = input.politicallyExposed ? "high" : input.country === "NL" ? "low" : "medium";
        return { client: input.client, risk };
      }
    );
    if (screened.risk !== "high") {
      return { ...screened, cleared: true, clearedBy: null };
    }
    const decision = await step.decision("enhanced-review", {
      description: \`Clear \${input.client} after enhanced due diligence\`,
      from: params.officers,
      ask: async () => {},
      timeout: "10 days",
    });
    const cleared = !decision.timedOut && decision.approved;
    return { ...screened, cleared, clearedBy: cleared ? decision.by : null };
  }
);
`;

const kycReviewTests = `import { workflowTests } from "@grasp-os/sdk/testing";

import review from "./kyc-review.ts";

export default workflowTests(review, [
  {
    name: "clears a low-risk client at once",
    input: { client: "Fam. Willems", country: "NL", politicallyExposed: false, identity: "passport" },
    expect: { output: { client: "Fam. Willems", risk: "low", cleared: true, clearedBy: null } },
  },
  {
    name: "asks an officer to clear a politically exposed client",
    input: { client: "S. de Jong", country: "NL", politicallyExposed: true, identity: "passport" },
    decisions: { "enhanced-review": { approved: true, by: "joost" } },
    expect: { output: { client: "S. de Jong", risk: "high", cleared: true, clearedBy: "joost" } },
  },
  {
    name: "refuses a client without an identity document",
    input: { client: "T. Kok", country: "NL", politicallyExposed: false },
    expect: { error: "No identity document" },
  },
]);
`;

const riskToCompliance: EngineSeed = {
  name: "Risk-to-Compliance",
  description:
    "The checks, reviews and records the regulator expects from you.",
  owner: "pieter",
  teams: [
    { team: "Compliance", role: "builder" },
    { team: "Client onboarding", role: "user" },
  ],
  agents: `# Risk-to-Compliance

Know-your-customer checks for every new client.

- \`kyc-review\` screens a new client and scores the risk: low for Dutch residents, medium for clients abroad, high for politically exposed people, whom a compliance officer clears after enhanced due diligence.
`,
  workflows: [
    {
      id: "kyc-review",
      owner: "joost",
      code: kycReview,
      tests: kycReviewTests,
      deciders: { officers: "Compliance" },
      runs: (draw) =>
        Array.from({ length: 22 }, (_, index) => {
          const exposed = index % 5 === 2;
          const noIdentity = index % 10 === 6;
          return {
            by: "nina" as const,
            input: {
              client: draw.pick(clients),
              country: draw.pick(countries),
              politicallyExposed: exposed,
              ...(noIdentity
                ? {}
                : { identity: draw.pick(["passport", "identity card"]) }),
            },
            ...(exposed && !noIdentity
              ? {
                  answer:
                    index === 17
                      ? "open"
                      : {
                          by: "joost" as const,
                          approved: true,
                        },
                }
              : {}),
          };
        }),
    },
  ],
};

/**
 * A domain with nothing in it yet, as the prototype has one: core holds
 * it, with no workflows and no apps.
 */
const hireToRetire: EngineSeed = {
  name: "Hire-to-Retire",
  description: "Everything around employees, from hiring to leaving.",
  owner: "sanne",
  teams: [],
  agents: `# Hire-to-Retire

Everything around employees, from hiring to leaving. Nothing runs here yet.
`,
  workflows: [],
};

/**
 * The prototype's domains (`lib/processes.ts`), each one of core's Apps,
 * with the workflows of the prototype's that core can run.
 */
export const engines: EngineSeed[] = [
  opportunityToCash,
  issueToResolution,
  purchaseToPay,
  riskToCompliance,
  recordToReport,
  hireToRetire,
];
