/**
 * The demo company's Apps, each binding independent
 * workflows that run on the local stack as they would anywhere:
 * grasp-workflow/2 definitions, their calculations
 * in expressions, with `workflowTest` suites in the App, calling
 * nothing outside Grasp, so a run needs no connection. Inputs stand in
 * for what a connection would bring (an email, an invoice from the
 * bookkeeping), so the seed starts each run with one, and a few are bad
 * on purpose, so some runs fail as real ones do.
 */
import { v } from "@grasp-os/runtime";
import type { BusinessProcess } from "@grasp-os/shared/business-processes";

import type { PersonKey, TeamName } from "./company.ts";
import { boolean, listOf, objectOf, raiseWhen, text } from "./definitions.ts";
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
  /** The alias its App binds it under: `workflows.<alias>`. */
  alias: string;
  /** What its App's page calls it. */
  title: string;
  /**
   * Who owns it, as in the prototype, when not its App's owner: a
   * builder, as only a builder creates a workflow.
   */
  owner?: PersonKey;
  /** Its definition, with its calculations in expressions. */
  parts: DefinitionParts;
  /** Its decision, if it asks one. */
  decision?: DecisionSeed;
  /** What the App declares of it: its args and returns, as `v` code. */
  declared: { args: string; returns: string };
  /** Its `workflowTest` suite, in the App's `tests/`. */
  tests: string;
  /** What its page starts a run with. */
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

export interface AppSeed {
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
  `import { workflowTest } from "@grasp-os/runtime/testing";
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

/** A test's check that its run failed with the error its workflow raises, `code`. */
const failsWith = (
  code: string
): string => `const ended = await t.runs.untilTerminal(run);
t.equal(ended.status, "failed");
t.equal(ended.status === "failed" ? ended.code : null, ${JSON.stringify(code)});`;

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

/** What every application needs before it becomes a client file, as an expression's list. */
const required = JSON.stringify(requiredDocuments);

const clientOnboarding: WorkflowSeed = {
  id: "client-onboarding",
  alias: "clientOnboarding",
  title: "Client onboarding",
  owner: "nina",
  parts: {
    args: objectOf({ client: text, town: text, documents: listOf(text) }),
    returns: objectOf({
      client: text,
      town: text,
      complete: boolean,
      chase: listOf(text),
    }),
    result: {
      client: { $expr: "args.client" },
      town: { $expr: "args.town" },
      complete: {
        $expr: `${required}.every((document) => args.documents.includes(document))`,
      },
      chase: {
        $expr: `${required}.filter((document) => !args.documents.includes(document))`,
      },
    },
    steps: [
      raiseWhen("noClient", 'args.client.trim() === ""', {
        code: "application.no_client",
        message:
          "The application has no client name, so no file can be opened for it.",
      }),
    ],
  },
  declared: {
    args: "v.object({ client: v.string(), town: v.string(), documents: v.array(v.string()) })",
    returns:
      "v.object({ client: v.string(), town: v.string(), complete: v.boolean(), chase: v.array(v.string()) })",
  },
  tests: suite({
    "opens a complete file when nothing is missing": `const run = await desk.start(workflows.clientOnboarding, { client: "Fam. Willems", town: "Utrecht", documents: ${JSON.stringify(requiredDocuments)} });
t.equal(await t.runs.untilTerminal(run), { status: "completed", result: { client: "Fam. Willems", town: "Utrecht", complete: true, chase: [] } });`,
    "lists the documents to chase": `const run = await desk.start(workflows.clientOnboarding, { client: "D. Mulder", town: "Zeist", documents: ["identity"] });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  result: { client: "D. Mulder", town: "Zeist", complete: false, chase: ["payslip", "employer statement", "bank statements"] },
});`,
    "refuses an application without a client": `const run = await desk.start(workflows.clientOnboarding, { client: " ", town: "Zeist", documents: [] });
${failsWith("application.no_client")}`,
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

const opportunityToCash: AppSeed = {
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

/** The words that give a complaint away: an urgent email's. */
const complaintWords = ["complaint", "not happy", "unacceptable"];

/** Where each kind of question goes, by words that give it away, as an expression's list. */
const queues = JSON.stringify([
  { queue: "complaints", words: complaintWords },
  {
    queue: "payments",
    words: ["payment", "bank account", "repayment", "pay off"],
  },
  { queue: "documents", words: ["document", "payslip", "offer", "attachment"] },
  { queue: "file status", words: ["file", "lender", "status"] },
]);

/** The email's subject and body, lower-cased, as one text. */
const mailText = '(args.subject + " " + args.body).toLowerCase()';

const emailTriage: WorkflowSeed = {
  id: "email-triage",
  alias: "emailTriage",
  title: "Email triage",
  parts: {
    args: objectOf({ from: text, subject: text, body: text }),
    returns: objectOf({ from: text, queue: text, urgent: boolean }),
    result: {
      from: { $expr: "args.from" },
      // The first queue whose words the email gives away, or general.
      queue: {
        $expr: `(${queues}.find((kind) => kind.words.some((word) => ${mailText}.includes(word))) ?? { queue: "general" }).queue`,
      },
      urgent: {
        $expr: `${JSON.stringify(complaintWords)}.some((word) => ${mailText}.includes(word))`,
      },
    },
    steps: [
      raiseWhen("noText", 'args.body.trim() === ""', {
        code: "triage.empty_email",
        message: "The email has no text to sort.",
      }),
    ],
  },
  declared: {
    args: "v.object({ from: v.string(), subject: v.string(), body: v.string() })",
    returns:
      "v.object({ from: v.string(), queue: v.string(), urgent: v.boolean() })",
  },
  tests: suite({
    "sends a complaint to the complaints queue, urgently": `const run = await desk.start(workflows.emailTriage, { from: "M. Hendriks", subject: "Complaint", body: "I'm not happy with the valuation." });
t.equal(await t.runs.untilTerminal(run), { status: "completed", result: { from: "M. Hendriks", queue: "complaints", urgent: true } });`,
    "sends a question about a file to file status": `const run = await desk.start(workflows.emailTriage, { from: "S. Peeters", subject: "Where is my file?", body: "Has it gone to the lender?" });
t.equal(await t.runs.untilTerminal(run), { status: "completed", result: { from: "S. Peeters", queue: "file status", urgent: false } });`,
    "refuses an empty email": `const run = await desk.start(workflows.emailTriage, { from: "R. Bos", subject: "Question", body: "" });
${failsWith("triage.empty_email")}`,
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

const issueToResolution: AppSeed = {
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

const purchaseToPay: AppSeed = {
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

/** What the board pack holds, and who brings it. */
const sections = [
  { section: "Revenue and costs", from: "Exact" },
  { section: "New clients and files", from: "the CRM" },
  { section: "Inbox and complaints", from: "the service desk" },
  { section: "Commissions", from: "the lenders' statements" },
];

/**
 * The Monday of the week the run started in, as YYYY-MM-DD, from
 * `run.startedAt` (ms since the epoch, the same on every replay): an
 * expression has no clock and no `Date`, so it counts the days, steps
 * back to Monday (day 0, 1970-01-01, was a Thursday) and turns the day
 * into a date by Howard Hinnant's `civil_from_days`, each `.map` on a
 * list of one naming what the next step reads. `a - a % b` is
 * `Math.floor`'s, for the whole numbers ≥ 0 these are.
 */
const mondayOfRun = [
  "[run.startedAt - run.startedAt % 86400000]",
  ".map((ms) => ms / 86400000)",
  ".map((day) => day - (day + 3) % 7 + 719468)",
  ".map((z) => ({ era: (z - z % 146097) / 146097, doe: z % 146097 }))",
  ".map((e) => ({ era: e.era, doe: e.doe, t: e.doe - (e.doe - e.doe % 1460) / 1460 + (e.doe - e.doe % 36524) / 36524 - (e.doe - e.doe % 146096) / 146096 }))",
  ".map((e) => ({ era: e.era, doe: e.doe, yoe: (e.t - e.t % 365) / 365 }))",
  ".map((e) => ({ y: e.yoe + e.era * 400, doy: e.doe - (365 * e.yoe + (e.yoe - e.yoe % 4) / 4 - (e.yoe - e.yoe % 100) / 100) }))",
  ".map((e) => ({ y: e.y, doy: e.doy, mp: (5 * e.doy + 2 - (5 * e.doy + 2) % 153) / 153 }))",
  ".map((e) => ({ y: e.y, m: e.mp < 10 ? e.mp + 3 : e.mp - 9, d: e.doy - (153 * e.mp + 2 - (153 * e.mp + 2) % 5) / 5 + 1 }))",
  '.map((e) => [e.m <= 2 ? e.y + 1 : e.y, e.m < 10 ? "0" + e.m : e.m, e.d < 10 ? "0" + e.d : e.d].join("-"))[0]',
].join("");

const weeklyReport: WorkflowSeed = {
  id: "weekly-report",
  alias: "weeklyReport",
  title: "Weekly report",
  parts: {
    args: objectOf({ week: text }, ["week"]),
    returns: objectOf({
      week: text,
      sections: listOf(objectOf({ section: text, from: text })),
      due: text,
    }),
    // The Monday of the week it ran in, unless it was given one.
    result: {
      week: { $expr: `args.week ?? ${mondayOfRun}` },
      sections,
      due: "10:00",
    },
    steps: [],
  },
  declared: {
    args: "v.object({ week: v.string().optional() })",
    returns:
      "v.object({ week: v.string(), sections: v.array(v.object({ section: v.string(), from: v.string() })), due: v.string() })",
  },
  tests: suite({
    "plans the week's board pack": `const run = await desk.start(workflows.weeklyReport, { week: "2026-10-05" });
t.equal(await t.runs.untilTerminal(run), {
  status: "completed",
  result: {
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

const recordToReport: AppSeed = {
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

const riskToCompliance: AppSeed = {
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
 * An App with nothing in it yet, as the prototype has one: core holds
 * it, with no workflows and no pages.
 */
const hireToRetire: AppSeed = {
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
 * The prototype's processes (`lib/processes.ts`), each one App,
 * with the workflows of the prototype's that core can run: those that ask
 * someone to decide (mortgage handovers, complaint compensation, invoice
 * approval, enhanced due diligence) come back once grasp-workflow/2 has
 * its decision step.
 */
export const apps: AppSeed[] = [
  opportunityToCash,
  issueToResolution,
  purchaseToPay,
  riskToCompliance,
  recordToReport,
  hireToRetire,
];
