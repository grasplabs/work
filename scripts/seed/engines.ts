/**
 * The demo company's domains (core's Apps), each binding independent
 * workflows that run on the local stack as they would anywhere:
 * grasp-workflow/1 definitions, their calculations
 * in compute modules, with `workflowTest` suites in the App, calling
 * nothing outside Grasp, so a run needs no connection. Inputs stand in
 * for what a connection would bring (an email, an invoice from the
 * bookkeeping), so the seed starts each run with one, and a few are bad
 * on purpose, so some runs fail as real ones do.
 */
import { v } from "@grasp-os/sdk";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";

import type { PersonKey, TeamName } from "./company.ts";
import {
  boolean,
  computeBinding,
  computeStep,
  listOf,
  objectOf,
  text,
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
  /** What its domain App's screen calls it. */
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
  /** The business process it serves, which gives it its icon. */
  process: BusinessProcess;
  description: string;
  owner: PersonKey;
  /** The teams it is shared with, and their role in it. */
  teams: { team: TeamName; role: "user" | "builder" }[];
  agents: string;
  workflows: WorkflowSeed[];
}

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
import { workflows } from "@server/_generated/api";

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
    output: {
      schema: objectOf({
        client: text,
        town: text,
        complete: boolean,
        chase: listOf(text),
      }),
      value: { $expr: "steps.check.output" },
    },
    bindings: { check: computeBinding("onboarding", "check") },
    steps: [computeStep("check", "check", "input")],
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

const opportunityToCash: EngineSeed = {
  name: "Opportunity-to-Cash",
  process: "o2c",
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
  workflows: [clientOnboarding],
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
    output: {
      schema: objectOf({ from: text, queue: text, urgent: boolean }),
      value: { $expr: "steps.sort.output" },
    },
    bindings: { sort: computeBinding("triage", "sort") },
    steps: [computeStep("sort", "sort", "input")],
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

const issueToResolution: EngineSeed = {
  name: "Issue-to-Resolution",
  process: "i2r",
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
  workflows: [emailTriage],
};

// Purchase-to-Pay and Record-to-Report

const purchaseToPay: EngineSeed = {
  name: "Purchase-to-Pay",
  process: "p2p",
  description:
    "Everything from ordering from a supplier until their invoice is paid.",
  owner: "eva",
  teams: [
    { team: "Finance", role: "builder" },
    { team: "Operations", role: "user" },
  ],
  agents: `# Purchase-to-Pay

Supplier invoices, from the inbox to the books.

Nothing runs here yet.
`,
  workflows: [],
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
  input: v.object({ week: v.string().nullable() }),
  output: v.object({ week: v.string(), sections: v.array(section), due: v.string() }),
  handler: ({ week }) => {
    // The Monday of the week it ran in, unless it was given one: its
    // answer is kept with the run, so a replay never reads the clock again.
    const monday = new Date();
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
    output: {
      schema: objectOf({
        week: text,
        sections: listOf(objectOf({ section: text, from: text })),
        due: text,
      }),
      value: { $expr: "steps.plan.output" },
    },
    bindings: { plan: computeBinding("report", "plan") },
    steps: [computeStep("plan", "plan", "{ week: input.week ?? null }")],
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
  process: "r2r",
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

const riskToCompliance: EngineSeed = {
  name: "Risk-to-Compliance",
  process: "r2c",
  description:
    "The checks, reviews and records the regulator expects from you.",
  owner: "pieter",
  teams: [
    { team: "Compliance", role: "builder" },
    { team: "Client onboarding", role: "user" },
  ],
  agents: `# Risk-to-Compliance

Know-your-customer checks for every new client.

Nothing runs here yet.
`,
  workflows: [],
};

/**
 * A domain with nothing in it yet, as the prototype has one: core holds
 * it, with no workflows and no apps.
 */
const hireToRetire: EngineSeed = {
  name: "Hire-to-Retire",
  process: "h2r",
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
 * with the workflows of the prototype's that core can run: those that ask
 * someone to decide (mortgage handovers, complaint compensation, invoice
 * approval, enhanced due diligence) come back once grasp-workflow/1 has
 * its decision step.
 */
export const engines: EngineSeed[] = [
  opportunityToCash,
  issueToResolution,
  purchaseToPay,
  riskToCompliance,
  recordToReport,
  hireToRetire,
];
