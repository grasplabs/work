/* oxlint-disable no-template-curly-in-string, unicorn/no-thenable -- workflow expressions are written as ${ … } strings, and transitions as then */
/**
 * The demo company's domains (core's Apps), each binding independent
 * workflows that run on the local stack as they would anywhere: JSON
 * definitions in the grasp-open-workflow/1 profile, their calculations
 * in compute modules, with `workflowTest` suites in the App, calling
 * nothing outside Grasp, so a run needs no connection. Inputs stand in
 * for what a connection would bring (an email, an invoice from the
 * bookkeeping), so the seed starts each run with one, and a few are bad
 * on purpose, so some runs fail as real ones do.
 */
import { v } from "@grasp-os/sdk";

import type { PersonKey, TeamName } from "./company.ts";
import {
  answerTask,
  approvedRoute,
  boolean,
  computeBinding,
  computeTask,
  decisionTask,
  integer,
  limitParam,
  listOf,
  number,
  objectOf,
  personParam,
  text,
  textOrNull,
} from "./definitions.ts";
import type { DefinitionParts } from "./definitions.ts";

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

/**
 * A workflow's decision: its binding, the person parameter that names
 * whom it asks, the team that answers it (the parameter's value, and
 * whom an admin approves the binding for), and the decision contract it
 * pins, with what each decision is about.
 */
export interface DecisionSeed {
  binding: string;
  param: string;
  team: TeamName;
  contract: string;
  /** The descriptor (JSON text) of what a decision of it is about. */
  input: string;
}

export interface WorkflowSeed {
  /** Its name, unique among the organization's workflows. */
  id: string;
  /** The alias its domain App binds it under: `workflows.<alias>`. */
  alias: string;
  title: string;
  /**
   * Who owns it, as in the prototype, when not its domain's owner: a
   * builder, as only a builder creates a workflow.
   */
  owner?: PersonKey;
  /** Its definition, its calculations and its decision, if it asks one. */
  parts: DefinitionParts;
  modules: Record<string, string>;
  decision?: DecisionSeed;
  /** What the App declares of it: its input and output, as `v` code. */
  declared: { input: string; output: string };
  /** Its `workflowTest` suite, in the App's `tests/`. */
  tests: string;
  /** What its screen starts a run with. */
  sample: Input;
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

/** What a person may answer a decision with: a comment, or nothing. */
export const decisionResponse = JSON.stringify(
  v.union(v.null(), v.object({ comment: v.string() })).descriptor
);

/**
 * A `workflowTest` suite of the App's fixture `desk`: `desk` starts each
 * run, and `decider` answers its decisions.
 */
const suite = (tests: Record<string, string>): string =>
  `import { workflowTest } from "@grasp-os/sdk/testing";
import { workflows } from "#grasp";

export default workflowTest({
  fixtures: "desk",
  tests: {
${Object.entries(tests)
  .map(
    ([name, body]) => `    ${JSON.stringify(name)}: async (t) => {
      const desk = await t.as("desk");
      const decider = await t.as("decider");
${body
  .trim()
  .split("\n")
  .map((line) => `      ${line}`)
  .join("\n")}
    },`
  )
  .join("\n")}
  },
});
`;

/** A test's check that its run failed in its calculation. */
const failsInItsCalculation = `const ended = await t.runs.untilTerminal(run);
t.equal(ended.status, "failed");
t.equal(ended.status === "failed" ? ended.code : null, "workflow.compute_failed");`;

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

const onboardingModule = `import { compute, v } from "@grasp-os/sdk/compute";

/** What every application needs before it becomes a client file. */
const required = ${JSON.stringify(requiredDocuments)};

export const check = compute({
  input: v.object({ client: v.string(), town: v.string(), documents: v.array(v.string()) }),
  output: v.object({ client: v.string(), town: v.string(), complete: v.boolean(), chase: v.array(v.string()) }),
  handler: ({ client, town, documents }) => {
    if (client.trim() === "") {
      throw new Error("The application has no client name, so no file can be opened for it.");
    }
    const chase = required.filter((document) => !documents.includes(document));
    return { client, town, complete: chase.length === 0, chase };
  },
});
`;

const clientOnboarding: WorkflowSeed = {
  id: "client-onboarding",
  alias: "clientOnboarding",
  title: "Client onboarding",
  owner: "nina",
  parts: {
    input: objectOf({ client: text, town: text, documents: listOf(text) }),
    output: objectOf({
      client: text,
      town: text,
      complete: boolean,
      chase: listOf(text),
    }),
    bindings: { check: computeBinding("onboarding", "check") },
    tasks: [computeTask("check-documents", "check", "${ $workflow.input }")],
  },
  modules: { "code/onboarding.ts": onboardingModule },
  declared: {
    input:
      "v.object({ client: v.string(), town: v.string(), documents: v.array(v.string()) })",
    output:
      "v.object({ client: v.string(), town: v.string(), complete: v.boolean(), chase: v.array(v.string()) })",
  },
  tests: suite({
    "opens a complete file when nothing is missing": `const run = await desk.start(workflows.clientOnboarding, { client: "Fam. Willems", town: "Utrecht", documents: ${JSON.stringify(requiredDocuments)} });
t.equal(await t.runs.untilTerminal(run), { status: "completed", output: { client: "Fam. Willems", town: "Utrecht", complete: true, chase: [] } });`,
    "lists the documents to chase": `const run = await desk.start(workflows.clientOnboarding, { client: "D. Mulder", town: "Zeist", documents: ["identity"] });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "D. Mulder", town: "Zeist", complete: false, chase: ["payslip", "employer statement", "bank statements"] },
});`,
    "refuses an application without a client": `const run = await desk.start(workflows.clientOnboarding, { client: " ", town: "Zeist", documents: [] });
${failsInItsCalculation}`,
  }),
  sample: {
    client: "Fam. Willems",
    town: "Utrecht",
    documents: ["identity", "payslip"],
  },
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
};

const summaryModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const summarise = compute({
  input: v.object({ client: v.string(), loan: v.number(), chase: v.array(v.string()) }),
  output: v.object({ client: v.string(), loan: v.number() }),
  handler: ({ client, loan, chase }) => {
    if (chase.length > 0) {
      throw new Error(\`The file of \${client} still lacks: \${chase.join(", ")}.\`);
    }
    return { client, loan };
  },
});
`;

const mortgageFiles: WorkflowSeed = {
  id: "mortgage-files",
  alias: "mortgageFiles",
  title: "Mortgage files",
  owner: "mark",
  parts: {
    input: objectOf({ client: text, loan: number, chase: listOf(text) }),
    output: objectOf({
      client: text,
      loan: number,
      handedOver: boolean,
      adviser: textOrNull,
    }),
    params: { advisers: personParam("Who takes files over") },
    bindings: {
      summarise: computeBinding("files", "summarise"),
      accept: {
        kind: "decision",
        contract: "noordkade/mortgage-file-handover",
      },
    },
    tasks: [
      computeTask("summarise", "summarise", "${ $workflow.input }", "file"),
      decisionTask("accept", {
        binding: "accept",
        param: "advisers",
        prompt: '${ "Take over the file of " + $workflow.input.client }',
        input: "${ $context.file }",
        days: 5,
      }),
      approvedRoute("taken", "hand-over", "keep"),
      answerTask(
        "hand-over",
        "${ $context.file + {handedOver: true, adviser: $context.decision.by} }"
      ),
      answerTask(
        "keep",
        "${ $context.file + {handedOver: false, adviser: null} }"
      ),
    ],
  },
  modules: { "code/files.ts": summaryModule },
  decision: {
    binding: "accept",
    param: "advisers",
    team: "Mortgage advice",
    contract: "noordkade/mortgage-file-handover",
    input: JSON.stringify(
      v.object({ client: v.string(), loan: v.number() }).descriptor
    ),
  },
  declared: {
    input:
      "v.object({ client: v.string(), loan: v.number(), chase: v.array(v.string()) })",
    output:
      "v.object({ client: v.string(), loan: v.number(), handedOver: v.boolean(), adviser: v.string().nullable() })",
  },
  tests: suite({
    "hands a complete file over once an adviser takes it": `const run = await desk.start(workflows.mortgageFiles, { client: "Fam. Bakker", loan: 41500000, chase: [] });
await decider.respond(run, "accept-ask", { approved: true });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "Fam. Bakker", loan: 41500000, handedOver: true, adviser: "fixture-decider" },
});`,
    "keeps the file when no adviser takes it": `const run = await desk.start(workflows.mortgageFiles, { client: "T. Kok", loan: 28000000, chase: [] });
await decider.respond(run, "accept-ask", { approved: false });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "T. Kok", loan: 28000000, handedOver: false, adviser: null },
});`,
    "refuses a file that still lacks documents": `const run = await desk.start(workflows.mortgageFiles, { client: "R. Bos", loan: 30000000, chase: ["payslip"] });
${failsInItsCalculation}`,
  }),
  sample: { client: "Fam. Bakker", loan: 41_500_000, chase: [] },
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
};

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

- \`clientOnboarding\` checks the application for the four documents every file needs (identity, payslip, employer statement, bank statements) and opens the file with what is still to chase.
- \`mortgageFiles\` hands a complete file to mortgage advice: an adviser takes it over, or it stays with onboarding.
`,
  workflows: [clientOnboarding, mortgageFiles],
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

const triageModule = `import { compute, v } from "@grasp-os/sdk/compute";

/** Where each kind of question goes, by words that give it away. */
const queues = [
  { queue: "complaints", words: ["complaint", "not happy", "unacceptable"] },
  { queue: "payments", words: ["payment", "bank account", "repayment", "pay off"] },
  { queue: "documents", words: ["document", "payslip", "offer", "attachment"] },
  { queue: "file status", words: ["file", "lender", "status"] },
];

export const sort = compute({
  input: v.object({ from: v.string(), subject: v.string(), body: v.string() }),
  output: v.object({ from: v.string(), queue: v.string(), urgent: v.boolean() }),
  handler: ({ from, subject, body }) => {
    if (body.trim() === "") {
      throw new Error(\`The email from \${from} has no text to sort.\`);
    }
    const words = \`\${subject} \${body}\`.toLowerCase();
    const found = queues.find(({ words: giveaways }) => giveaways.some((word) => words.includes(word)));
    return { from, queue: found?.queue ?? "general", urgent: found?.queue === "complaints" };
  },
});
`;

const emailTriage: WorkflowSeed = {
  id: "email-triage",
  alias: "emailTriage",
  title: "Email triage",
  parts: {
    input: objectOf({ from: text, subject: text, body: text }),
    output: objectOf({ from: text, queue: text, urgent: boolean }),
    bindings: { sort: computeBinding("triage", "sort") },
    tasks: [computeTask("sort", "sort", "${ $workflow.input }")],
  },
  modules: { "code/triage.ts": triageModule },
  declared: {
    input:
      "v.object({ from: v.string(), subject: v.string(), body: v.string() })",
    output:
      "v.object({ from: v.string(), queue: v.string(), urgent: v.boolean() })",
  },
  tests: suite({
    "sends a complaint to the complaints queue, urgently": `const run = await desk.start(workflows.emailTriage, { from: "M. Hendriks", subject: "Complaint", body: "I'm not happy with the valuation." });
t.equal(await t.runs.untilTerminal(run), { status: "completed", output: { from: "M. Hendriks", queue: "complaints", urgent: true } });`,
    "sends a question about a file to file status": `const run = await desk.start(workflows.emailTriage, { from: "S. Peeters", subject: "Where is my file?", body: "Has it gone to the lender?" });
t.equal(await t.runs.untilTerminal(run), { status: "completed", output: { from: "S. Peeters", queue: "file status", urgent: false } });`,
    "refuses an empty email": `const run = await desk.start(workflows.emailTriage, { from: "R. Bos", subject: "Question", body: "" });
${failsInItsCalculation}`,
  }),
  sample: {
    from: "M. Hendriks",
    subject: "Complaint",
    body: "I'm not happy with the valuation.",
  },
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
};

const complaintsModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const register = compute({
  input: v.object({ client: v.string(), about: v.string(), compensation: v.number(), received: v.string() }),
  output: v.object({ client: v.string(), about: v.string(), acknowledgeBy: v.string() }),
  handler: ({ client, about, received }) => {
    // Two working days after the day it came in.
    const due = new Date(\`\${received}T00:00:00Z\`);
    let workingDays = 0;
    while (workingDays < 2) {
      due.setUTCDate(due.getUTCDate() + 1);
      const day = due.getUTCDay();
      if (day !== 0 && day !== 6) {
        workingDays += 1;
      }
    }
    return { client, about, acknowledgeBy: due.toISOString().slice(0, 10) };
  },
});
`;

const complaints: WorkflowSeed = {
  id: "complaints",
  alias: "complaints",
  title: "Complaints",
  parts: {
    input: objectOf({
      client: text,
      about: text,
      compensation: integer,
      received: text,
    }),
    output: objectOf({
      client: text,
      about: text,
      acknowledgeBy: text,
      compensation: integer,
      approvedBy: textOrNull,
    }),
    params: {
      limit: limitParam("Compliance approves compensation above", 25_000),
      compliance: personParam("Who approves compensation"),
    },
    bindings: {
      register: computeBinding("complaints", "register"),
      approval: {
        kind: "decision",
        contract: "noordkade/complaint-compensation",
      },
    },
    tasks: [
      computeTask("register", "register", "${ $workflow.input }", "complaint"),
      {
        size: {
          switch: [
            {
              small: {
                when: "${ $workflow.input.compensation <= $params.limit }",
                then: "offer",
              },
            },
            { large: { then: "approve-compensation" } },
          ],
        },
      },
      answerTask(
        "offer",
        "${ $context.complaint + {compensation: $workflow.input.compensation, approvedBy: null} }"
      ),
      decisionTask("approve-compensation", {
        binding: "approval",
        param: "compliance",
        prompt: '${ "Approve compensation for " + $workflow.input.client }',
        input:
          "${ {client: $workflow.input.client, compensation: $workflow.input.compensation} }",
        days: 3,
      }),
      approvedRoute("approved", "grant", "refuse"),
      answerTask(
        "grant",
        "${ $context.complaint + {compensation: $workflow.input.compensation, approvedBy: $context.decision.by} }"
      ),
      answerTask(
        "refuse",
        "${ $context.complaint + {compensation: 0, approvedBy: null} }"
      ),
    ],
  },
  modules: { "code/complaints.ts": complaintsModule },
  decision: {
    binding: "approval",
    param: "compliance",
    team: "Compliance",
    contract: "noordkade/complaint-compensation",
    input: JSON.stringify(
      v.object({ client: v.string(), compensation: v.number() }).descriptor
    ),
  },
  declared: {
    input:
      "v.object({ client: v.string(), about: v.string(), compensation: v.number().integer(), received: v.string() })",
    output:
      "v.object({ client: v.string(), about: v.string(), acknowledgeBy: v.string(), compensation: v.number().integer(), approvedBy: v.string().nullable() })",
  },
  tests: suite({
    "offers small compensation without asking, and acknowledges within two working days": `const run = await desk.start(workflows.complaints, { client: "K. Mulder", about: "Waiting on the phone", compensation: 2500, received: "2026-10-05" });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "K. Mulder", about: "Waiting on the phone", acknowledgeBy: "2026-10-07", compensation: 2500, approvedBy: null },
});`,
    "acknowledges a complaint from a Friday by Tuesday": `const run = await desk.start(workflows.complaints, { client: "R. Bos", about: "A late answer", compensation: 0, received: "2026-10-09" });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "R. Bos", about: "A late answer", acknowledgeBy: "2026-10-13", compensation: 0, approvedBy: null },
});`,
    "asks compliance for larger compensation": `const run = await desk.start(workflows.complaints, { client: "M. Hendriks", about: "The valuation", compensation: 75000, received: "2026-10-05" });
await decider.respond(run, "approve-compensation-ask", { approved: true });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { client: "M. Hendriks", about: "The valuation", acknowledgeBy: "2026-10-07", compensation: 75000, approvedBy: "fixture-decider" },
});`,
  }),
  sample: {
    client: "M. Hendriks",
    about: "The valuation",
    compensation: 2500,
    received: "2026-10-05",
  },
  dateInput: "received",
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
};

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

- \`emailTriage\` puts each email from the shared inbox in the queue that answers it: file status, documents, payments, complaints, or general.
- \`complaints\` registers a complaint with its acknowledgement deadline, and asks compliance before offering compensation above the limit.
`,
  workflows: [emailTriage, complaints],
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

const invoicesModule = `import { compute, v } from "@grasp-os/sdk/compute";

/** The ledger account each kind of cost is booked on. */
const accounts = [
  { account: "4100 Housing", words: ["rent", "energy", "cleaning"] },
  { account: "4300 Software and data", words: ["subscription", "laptops", "phones"] },
  { account: "4500 Marketing", words: ["brochures"] },
  { account: "4700 Advice", words: ["legal"] },
];

export const code = compute({
  input: v.object({ supplier: v.string(), invoice: v.string(), description: v.string(), amount: v.number(), vatNumber: v.string().optional() }),
  output: v.object({ invoice: v.string(), account: v.string() }),
  handler: ({ supplier, invoice, description, vatNumber }) => {
    if (!vatNumber) {
      throw new Error(\`Invoice \${invoice} from \${supplier} has no VAT number.\`);
    }
    const words = description.toLowerCase();
    const found = accounts.find(({ words: giveaways }) => giveaways.some((word) => words.includes(word)));
    return { invoice, account: found?.account ?? "4900 Other costs" };
  },
});
`;

const supplierInvoices: WorkflowSeed = {
  id: "supplier-invoices",
  alias: "supplierInvoices",
  title: "Supplier invoices",
  parts: {
    input: objectOf(
      {
        supplier: text,
        invoice: text,
        description: text,
        amount: integer,
        vatNumber: text,
      },
      ["vatNumber"]
    ),
    output: objectOf({
      invoice: text,
      account: text,
      amount: integer,
      approved: boolean,
      approvedBy: textOrNull,
    }),
    params: {
      limit: limitParam("Approve invoices above", 250_000),
      approvers: personParam("Who approves invoices"),
    },
    bindings: {
      code: computeBinding("invoices", "code"),
      approval: { kind: "decision", contract: "noordkade/invoice-approval" },
    },
    tasks: [
      computeTask("code", "code", "${ $workflow.input }", "coded"),
      {
        size: {
          switch: [
            {
              small: {
                when: "${ $workflow.input.amount <= $params.limit }",
                then: "book",
              },
            },
            { large: { then: "approve" } },
          ],
        },
      },
      answerTask(
        "book",
        "${ $context.coded + {amount: $workflow.input.amount, approved: true, approvedBy: null} }"
      ),
      decisionTask("approve", {
        binding: "approval",
        param: "approvers",
        prompt:
          '${ "Approve invoice " + $workflow.input.invoice + " from " + $workflow.input.supplier }',
        input:
          "${ {supplier: $workflow.input.supplier, invoice: $workflow.input.invoice, amount: $workflow.input.amount} }",
        days: 7,
      }),
      approvedRoute("approved", "pay", "hold"),
      answerTask(
        "pay",
        "${ $context.coded + {amount: $workflow.input.amount, approved: true, approvedBy: $context.decision.by} }"
      ),
      answerTask(
        "hold",
        "${ $context.coded + {amount: $workflow.input.amount, approved: false, approvedBy: null} }"
      ),
    ],
  },
  modules: { "code/invoices.ts": invoicesModule },
  decision: {
    binding: "approval",
    param: "approvers",
    team: "Finance",
    contract: "noordkade/invoice-approval",
    input: JSON.stringify(
      v.object({
        supplier: v.string(),
        invoice: v.string(),
        amount: v.number(),
      }).descriptor
    ),
  },
  declared: {
    input:
      "v.object({ supplier: v.string(), invoice: v.string(), description: v.string(), amount: v.number().integer(), vatNumber: v.string().optional() })",
    output:
      "v.object({ invoice: v.string(), account: v.string(), amount: v.number().integer(), approved: v.boolean(), approvedBy: v.string().nullable() })",
  },
  tests: suite({
    "codes a small invoice and books it without asking": `const run = await desk.start(workflows.supplierInvoices, { supplier: "KPN", invoice: "KPN-2291", description: "Phones", amount: 48600, vatNumber: "NL009292056B01" });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { invoice: "KPN-2291", account: "4300 Software and data", amount: 48600, approved: true, approvedBy: null },
});`,
    "asks finance to approve an invoice above the limit": `const run = await desk.start(workflows.supplierInvoices, { supplier: "Kantoorhuis Utrecht", invoice: "KU-1043", description: "Office rent", amount: 418000, vatNumber: "NL812345678B01" });
await decider.respond(run, "approve-ask", { approved: true });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  output: { invoice: "KU-1043", account: "4100 Housing", amount: 418000, approved: true, approvedBy: "fixture-decider" },
});`,
    "refuses an invoice without a VAT number": `const run = await desk.start(workflows.supplierInvoices, { supplier: "Drukkerij Noord", invoice: "DN-77", description: "Brochures", amount: 64000 });
${failsInItsCalculation}`,
  }),
  sample: {
    supplier: "KPN",
    invoice: "KPN-2291",
    description: "Phones",
    amount: 48_600,
    vatNumber: "NL009292056B01",
  },
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
};

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

- \`supplierInvoices\` checks each supplier invoice for a VAT number, codes it to a ledger account, and asks finance to approve it when it is above the limit.
`,
  workflows: [supplierInvoices],
};

const reportModule = `import { compute, v } from "@grasp-os/sdk/compute";

/** What the board pack holds, and who brings it. */
const sections = [
  { section: "Revenue and costs", from: "Exact" },
  { section: "New clients and files", from: "the CRM" },
  { section: "Inbox and complaints", from: "the service desk" },
  { section: "Commissions", from: "the lenders' statements" },
];

const section = v.object({ section: v.string(), from: v.string() });

export const plan = compute({
  input: v.object({ week: v.string().nullable(), today: v.number() }),
  output: v.object({ week: v.string(), sections: v.array(section), due: v.string() }),
  handler: ({ week, today }) => {
    // The Monday of the week it ran in, unless it was given one.
    const monday = new Date(today);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return { week: week ?? monday.toISOString().slice(0, 10), sections, due: "10:00" };
  },
});
`;

const weeklyReport: WorkflowSeed = {
  id: "weekly-report",
  alias: "weeklyReport",
  title: "Weekly report",
  parts: {
    input: objectOf({ week: text }, ["week"]),
    output: objectOf({
      week: text,
      sections: listOf(objectOf({ section: text, from: text })),
      due: text,
    }),
    bindings: { plan: computeBinding("report", "plan") },
    tasks: [
      computeTask(
        "plan",
        "plan",
        "${ {week: ($workflow.input.week // null), today: $workflow.startedAt.epoch.milliseconds} }"
      ),
    ],
  },
  modules: { "code/report.ts": reportModule },
  declared: {
    input: "v.object({ week: v.string().optional() })",
    output:
      "v.object({ week: v.string(), sections: v.array(v.object({ section: v.string(), from: v.string() })), due: v.string() })",
  },
  tests: suite({
    "plans the week's board pack": `const run = await desk.start(workflows.weeklyReport, { week: "2026-10-05" });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
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
});`,
  }),
  sample: {},
  scheduled: true,
  dateInput: "week",
  runs: () =>
    Array.from({ length: 4 }, () => ({ by: "eva" as const, input: {} })),
};

const recordToReport: EngineSeed = {
  name: "Record-to-Report",
  description:
    "Closing the books and producing the numbers leadership looks at.",
  owner: "eva",
  teams: [{ team: "Finance", role: "builder" }],
  agents: `# Record-to-Report

The numbers the board reads.

- \`weeklyReport\` plans the board pack for Monday's 10:00 meeting.
`,
  workflows: [weeklyReport],
};

// Risk-to-Compliance

const countries = ["NL", "NL", "NL", "BE", "DE", "GB"] as const;

const kycModule = `import { compute, v } from "@grasp-os/sdk/compute";

export const screen = compute({
  input: v.object({ client: v.string(), country: v.string(), politicallyExposed: v.boolean(), identity: v.string().optional() }),
  output: v.object({ client: v.string(), risk: v.enum(["low", "medium", "high"]) }),
  handler: ({ client, country, politicallyExposed, identity }) => {
    if (!identity) {
      throw new Error(\`No identity document to check for \${client}.\`);
    }
    let risk: "low" | "medium" | "high" = "medium";
    if (politicallyExposed) {
      risk = "high";
    } else if (country === "NL") {
      risk = "low";
    }
    return { client, risk };
  },
});
`;

const kycReview: WorkflowSeed = {
  id: "kyc-review",
  alias: "kycReview",
  title: "KYC review",
  parts: {
    input: objectOf(
      {
        client: text,
        country: text,
        politicallyExposed: boolean,
        identity: text,
      },
      ["identity"]
    ),
    output: objectOf({
      client: text,
      risk: text,
      cleared: boolean,
      clearedBy: textOrNull,
    }),
    params: { officers: personParam("Who clears high-risk clients") },
    bindings: {
      screen: computeBinding("kyc", "screen"),
      review: { kind: "decision", contract: "noordkade/enhanced-review" },
    },
    tasks: [
      computeTask("screen", "screen", "${ $workflow.input }", "screened"),
      {
        risk: {
          switch: [
            {
              high: {
                when: '${ $context.screened.risk == "high" }',
                then: "enhanced-review",
              },
            },
            { other: { then: "clear" } },
          ],
        },
      },
      answerTask(
        "clear",
        "${ $context.screened + {cleared: true, clearedBy: null} }"
      ),
      decisionTask("enhanced-review", {
        binding: "review",
        param: "officers",
        prompt:
          '${ "Clear " + $workflow.input.client + " after enhanced due diligence" }',
        input: "${ $context.screened }",
        days: 10,
      }),
      approvedRoute("reviewed", "cleared", "not-cleared"),
      answerTask(
        "cleared",
        "${ $context.screened + {cleared: true, clearedBy: $context.decision.by} }"
      ),
      answerTask(
        "not-cleared",
        "${ $context.screened + {cleared: false, clearedBy: null} }"
      ),
    ],
  },
  modules: { "code/kyc.ts": kycModule },
  decision: {
    binding: "review",
    param: "officers",
    team: "Compliance",
    contract: "noordkade/enhanced-review",
    input: JSON.stringify(
      v.object({ client: v.string(), risk: v.string() }).descriptor
    ),
  },
  declared: {
    input:
      "v.object({ client: v.string(), country: v.string(), politicallyExposed: v.boolean(), identity: v.string().optional() })",
    output:
      "v.object({ client: v.string(), risk: v.string(), cleared: v.boolean(), clearedBy: v.string().nullable() })",
  },
  tests: suite({
    "clears a low-risk client at once": `const run = await desk.start(workflows.kycReview, { client: "Fam. Willems", country: "NL", politicallyExposed: false, identity: "passport" });
t.equal(await t.runs.untilTerminal(run), { status: "completed", output: { client: "Fam. Willems", risk: "low", cleared: true, clearedBy: null } });`,
    "asks an officer to clear a politically exposed client": `const run = await desk.start(workflows.kycReview, { client: "S. de Jong", country: "NL", politicallyExposed: true, identity: "passport" });
await decider.respond(run, "enhanced-review-ask", { approved: true });
t.equal(await t.runs.untilTerminal(run), { status: "completed", output: { client: "S. de Jong", risk: "high", cleared: true, clearedBy: "fixture-decider" } });`,
    "refuses a client without an identity document": `const run = await desk.start(workflows.kycReview, { client: "T. Kok", country: "NL", politicallyExposed: false });
${failsInItsCalculation}`,
  }),
  sample: {
    client: "Fam. Willems",
    country: "NL",
    politicallyExposed: false,
    identity: "passport",
  },
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
};

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

- \`kycReview\` screens a new client and scores the risk: low for Dutch residents, medium for clients abroad, high for politically exposed people, whom a compliance officer clears after enhanced due diligence.
`,
  workflows: [kycReview],
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
