/**
 * What the e2e stack's fake providers answer (e2e/model-fake.ts): for each
 * script, the agent's replies in a chat its person opened with `opener`,
 * one per turn of the agent's, in order. The fake keeps no state: each
 * request carries its chat so far, so the turn is the replies the agent
 * already gave in it, and parallel tests never share one. The script is
 * the one the person's own first words open, never one the recall
 * beside them quotes from another of their chats: tests that sign in as
 * the same person each open a script of their own (`wordsOf`). A reply that
 * calls a tool on something the chat names (its App, a workflow) reads
 * it from the request, as the model would: from what the chat said so
 * far, its system prompt among it.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { withoutDefinition } from "../apps/core/test/app-definitions.ts";
import type { Answer } from "../apps/core/test/provider-streams.ts";
import { contactsApp } from "./contacts-app.ts";
import { invoiceApproval } from "./invoice-approval.ts";
import { tallyFiles, tallyPage, tallyServer } from "./tally-app.ts";

/** An agent's turn: its answer, or its answer to what the chat said so far. */
export type ScriptedReply = Answer | ((said: string) => Answer);

export interface ModelScript {
  /** What the person's first message in the chat says, as they type it. */
  opener: string;
  /** The agent's replies, a turn of its each. */
  replies: readonly ScriptedReply[];
}

/** The agent says `text`, and is done. */
const says = (text: string): Answer => ({
  text,
  inputTokens: 200,
  outputTokens: 20,
});

/** The agent calls tool `name` with `input`, and waits for what it returns. */
const calls = (
  id: string,
  name: string,
  input: Record<string, unknown>
): Answer => ({
  text: "",
  toolCalls: [{ id, name, arguments: input }],
  inputTokens: 200,
  outputTokens: 20,
});

/**
 * `pattern`'s `found` group in what the chat said: what the agent read of
 * it. Throws when the chat never said it, so the fake refuses the turn
 * and the test shows the model failing, never a call on nothing.
 */
const readIn = (said: string, pattern: RegExp): string => {
  const found = pattern.exec(said)?.groups?.found;
  if (found === undefined) {
    throw new Error(`The chat never said what ${String(pattern)} reads`);
  }
  return found;
};

/** The App a question is about, as the note beside it names it (core's agent.ts). */
const ownApp = /workspace of the App .*? \((?<found>[^)\s]+)\): /u;

/**
 * The agent says `text` and writes `files` into its draft of the App
 * whose own chat it is, as tool call `id`.
 */
const writesTally = (
  said: string,
  id: string,
  text: string,
  files: Record<string, string>
): Answer => ({
  text,
  toolCalls: [
    {
      id,
      name: "writeFile",
      arguments: { app: readIn(said, ownApp), files },
    },
  ],
  inputTokens: 200,
  outputTokens: 40,
});

/**
 * A docs page's title, as `readDocs` reads the page's Markdown (core's
 * agent-docs.ts): in its frontmatter, which the guides in the system
 * prompt leave out.
 */
const docsPage = /^title: (?<found>.+)$/mu;

/** A table the agent adds with `addTable`, every member reading and writing it. */
const sharedTable = (
  app: string,
  name: string,
  fields: Record<string, string>
): Record<string, unknown> => ({
  app,
  name,
  fields,
  access: { read: "appMembers", write: "appMembers" },
});

/** `files` as the agent writes them: never the definition, its config or its schema. */
const codeOf = withoutDefinition;

/**
 * The workflow a chat's question was asked beside, as core's note on its
 * subject names it (core's agent.ts, the web's chat-subject.ts).
 */
const besideWorkflow = /page of the workflow ".*?" \((?<found>[^)\s]+)\)/u;

/** The App the agent plans for the contact list (`buildsApp`): its name. */
export const appPlanned = "Sales contacts";

/** What the agent says once it wrote the contact list (`buildsApp`). */
export const appReady = "Your contact list is ready to try in the preview.";

/** What the agent says once it drew the approval (`drawsApproval`). */
export const approvalDrawn =
  "Drew it: the approver you name decides on each invoice.";

/** The long answer of `answersAtLength`: a step a paragraph, its last one apart. */
export const monthEndCloseLast =
  "Last, lock the period, so nothing posts into a month you closed.";
const monthEndClose = [
  "First, reconcile every bank account against its statement, and chase what doesn't match.",
  "Then post the accruals: the costs of the month whose invoices haven't come yet.",
  "Next, book the prepayments you spread over the months they cover.",
  "Run depreciation on the fixed assets, as their schedules say.",
  "Match the receivables to what customers paid, and follow up on what is overdue.",
  "Match the payables to the suppliers' statements, and settle the differences.",
  "Count what is in stock, and write off what was lost or damaged.",
  "Revalue what is held in other currencies at the month's closing rates.",
  "Reconcile the intercompany balances, so both sides of each say the same.",
  "Review the payroll journal against the payslips, and the taxes owed on it.",
  "Compare each cost line with its budget, and explain what moved.",
  "Draft the profit and loss account and the balance sheet, and read them through.",
  "Have someone who didn't prepare them review the numbers.",
  "Check the VAT return against the ledger before it is filed.",
  "Post the corrections the review found, each with its reason.",
  "Reconcile the credit cards and the expense claims of the month.",
  "Check that every invoice sent this month is booked in this month.",
  "Write down the bad debts nobody will pay, as the policy allows.",
  "Book the bonuses and holiday pay owed but not yet paid.",
  "Update the cash flow forecast with what the month taught you.",
  "Note anything unusual for the auditors while it is fresh.",
  "Send the management pack to the board, with a page on what changed.",
  monthEndCloseLast,
].join("\n\n");

/** An issue's identifier, as Linear's server names it (connect's test/linear-mcp-fake.ts). */
const linearIssue = /(?<found>ENG-\d+)/u;

/** What the agent says once it asked for the connector's connection (`readsLinear`). */
export const linearAsked = "Grant it here, and I'll look.";

/** What the agent says once it read the first issue through the connector (`readsLinear`). */
export const linearAnswer = /^The first open one is ENG-\d+\.$/u;

export const modelScripts = {
  /** A chat turn, end to end: the person asks, the agent answers. */
  answers: {
    opener: "What should the weekly sales report cover?",
    replies: [
      says("Revenue by region, the deals that closed, and the pipeline."),
    ],
  },
  /**
   * An answer written slowly, its first words then a pause: the person
   * asks again meanwhile, and the agent answers that after it.
   */
  answersWhileAsked: {
    opener: "What should the quarterly plan cover?",
    replies: [
      (): Answer => ({
        ...says("First the goals, then the budget and who owns each part."),
        pause: { at: 15, until: sleep(8000) },
      }),
      says("The budget is set by the end of the month."),
    ],
  },
  /**
   * A long answer, given while the person was away: taller than the
   * window, so the chat opens at its New line, never at its end.
   */
  answersAtLength: {
    opener: "Walk me through the month-end close, step by step.",
    replies: [says(monthEndClose)],
  },
  /**
   * The agent asks for the person's connection to a connector made from a
   * URL whose tools list issues, by what it can do; once they granted it
   * and say so, it lists their issues through it and names the first, as
   * Linear's server answered.
   */
  readsLinear: {
    opener: "Which issues are open in Linear?",
    replies: [
      calls("asklinear", "executeCode", {
        code: `export default async (self, env) => {
  const all = await env.connections.available();
  const linear = all.find((each) => each.actions.includes("list_issues"));
  return await env.connections.request({ connectionId: linear.connectionId, actions: ["list_issues"], binding: "LINEAR", reason: "To find your open issues." });
};`,
      }),
      says(linearAsked),
      calls("listlinear", "executeCode", {
        code: `export default async (self, env) => {
  const { output } = await env.connections.call("LINEAR", "list_issues", { limit: 1 });
  return output;
};`,
      }),
      (said) => says(`The first open one is ${readIn(said, linearIssue)}.`),
    ],
  },
  /**
   * The agent asks two questions in the box's place (`askQuestions`), and
   * answers once the person's answers come.
   */
  asksFirst: {
    opener: "Send me a report every week.",
    replies: [
      {
        text: "",
        toolCalls: [
          {
            id: "askreport",
            name: "askQuestions",
            arguments: {
              questions: [
                {
                  kind: "choice",
                  header: "Rhythm",
                  question: "How often should it come?",
                  options: [
                    { label: "Daily", description: "Every working day" },
                    { label: "Weekly", description: "On Mondays" },
                  ],
                  recommended: 1,
                },
                {
                  kind: "choice",
                  question: "Who should get it?",
                  options: [
                    { label: "Me" },
                    { label: "My team" },
                    { label: "Finance" },
                  ],
                  multiple: true,
                },
              ],
            },
          },
        ],
        inputTokens: 100,
        outputTokens: 40,
      },
      says("A weekly report on Mondays, for you and Finance."),
    ],
  },
  /**
   * The agent asks for an App's npm packages, on a card in its chat (the
   * request itself is written as its resolve proposes it: a local stack
   * reaches no registry, e2e/dependency-request.ts), and carries on once
   * the builder approves them there.
   */
  asksPackages: {
    opener: "Use an npm package for this App's page.",
    replies: [
      says("I asked for the packages it needs: approve them on the card."),
      says("They are approved, so the page uses them now."),
    ],
  },
  /**
   * An App's own chat builds it: the agent writes a tally into the chat's
   * draft of the App, then says it is done.
   */
  buildsTally: {
    opener: "Build a tally that counts what is added.",
    replies: [
      (said) => ({
        text: "Writing the tally.",
        toolCalls: [
          {
            id: "write-tally",
            name: "writeFile",
            arguments: {
              app: readIn(said, ownApp),
              files: codeOf(tallyFiles("in the preview")),
            },
          },
        ],
        inputTokens: 200,
        outputTokens: 40,
      }),
      says("The tally is in the preview."),
      // Asked again: a write of its page alone, which the open preview
      // takes in place.
      (said) => ({
        text: "Renaming the button.",
        toolCalls: [
          {
            id: "rename-button",
            name: "writeFile",
            arguments: {
              app: readIn(said, ownApp),
              files: {
                "src/routes/index.tsx": tallyPage("Add another"),
              },
            },
          },
        ],
        inputTokens: 200,
        outputTokens: 40,
      }),
      says("The button is renamed."),
      // A write of its server code alone, which the open preview takes in
      // place too.
      (said) =>
        writesTally(said, "count-anew", "Counting anew.", {
          "server/tally.ts": tallyServer("counted anew"),
        }),
      says("It counts anew."),
      // Server code that doesn't build, with a write of its page: the
      // page shows, on the server code that last built.
      (said) =>
        writesTally(said, "take-more", "Taking more.", {
          "server/tally.ts": tallyServer("taken", { builds: false }),
          "src/routes/index.tsx": tallyPage("Add more"),
        }),
      says("It takes more."),
      // Told by the turn's check that its server code doesn't build, it
      // answers without fixing it: the draft stays so until asked.
      says("Its server code doesn't build yet: I'll fix it next."),
      (said) =>
        writesTally(said, "fix-server", "Fixing the count.", {
          "server/tally.ts": tallyServer("fixed"),
        }),
      says("The count is fixed."),
    ],
  },
  /**
   * A new App from Make something: the agent proposes a page the team
   * opens, and once the person says Build it, reads how an App's project
   * is laid out in the deployment's docs, writes a contact list's files
   * into its draft, and says it is ready to try. It never shares it: the
   * builder does.
   */
  buildsApp: {
    opener:
      "A contact list for the sales team: each contact's name, added from its page.",
    replies: [
      calls("plansapp1", "proposePlan", {
        parts: [
          {
            kind: "app",
            name: appPlanned,
            does: "Each contact's name, added from its page.",
          },
        ],
        who: "The sales team",
      }),
      calls("findsapp1", "readDocs", { path: "/guides/project" }),
      // Only once the docs answered with the page: a read that failed
      // ends the script.
      (said) => {
        readIn(said, docsPage);
        return calls(
          "definesap1",
          "addTable",
          sharedTable(readIn(said, ownApp), "contacts", {
            name: "v.string().max(200)",
          })
        );
      },
      (said) =>
        calls("writesap1", "writeFile", {
          app: readIn(said, ownApp),
          files: codeOf(contactsApp),
        }),
      says(appReady),
    ],
  },
  /**
   * A new workflow from Make something: the agent proposes something that
   * runs on its own, and once the person says Build it, saves an invoice
   * approval, a person's decision, as the draft's first revision, and
   * says so.
   */
  drawsApproval: {
    opener: "Approve each invoice: the approver I name decides on it.",
    replies: [
      calls("plansapr1", "proposePlan", {
        parts: [
          {
            kind: "workflow",
            name: "Invoice approval",
            does: "Each invoice waits for the approver you name.",
          },
        ],
        who: "The finance team",
      }),
      (said) =>
        calls("editswf01", "editWorkflow", {
          workflow: readIn(said, besideWorkflow),
          revision: 0,
          source: invoiceApproval(),
        }),
      says(approvalDrawn),
    ],
  },
} as const satisfies Record<string, ModelScript>;

const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

/** What a tool returned, as Anthropic's messages carry it. */
const toolResultSchema = z.object({
  type: z.literal("tool_result"),
  content: z.unknown(),
});

/**
 * A provider request's messages (chat completions and Anthropic's messages
 * alike), Anthropic's system prompt, and the tools it offers.
 */
const requestSchema = z.object({
  system: z.unknown().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.unknown()).min(1),
});

/**
 * A message's text, whether a string or a list of parts, what tools
 * returned among them (a chat completion's `tool` message is a string).
 */
const textOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part: unknown) => {
      const text = textPartSchema.safeParse(part);
      if (text.success) {
        return [text.data.text];
      }
      const result = toolResultSchema.safeParse(part);
      return result.success ? [textOf(result.data.content)] : [];
    })
    .join("");
};

/**
 * The person's own words in a question's `content`: its first part, as
 * core puts them first (core's chat-agent.ts, `questionContent`). The
 * parts after them are core's: notes on what the question is about, and
 * what the recall before it found in the Brain, which can quote the same
 * person's other chats, other tests' among them.
 */
const wordsOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  const first = textPartSchema.safeParse(
    Array.isArray(content) ? content[0] : undefined
  );
  return first.success ? first.data.text : "";
};

/**
 * The scripted answer to a provider request's `body`: the next of the
 * replies of the script its chat opened with, by the words its person
 * opened it with alone. Only an agent's turn has
 * one, as only it offers tools: anything else the stack asks a model for,
 * such as a chat's title, has none, nor has a turn past a script's end, so
 * the fake refuses it as it refuses every other request.
 */
export const scriptedAnswer = (body: unknown): Answer | undefined => {
  const request = requestSchema.safeParse(body);
  if (!request.success) {
    return undefined;
  }
  const { system, messages } = request.data;
  const opened = wordsOf(messages.find(({ role }) => role === "user")?.content);
  // The longest opener the chat opened with: one script's opener may
  // begin another's.
  const [script] = Object.values<ModelScript>(modelScripts)
    .filter(({ opener }) => opened.includes(opener))
    .toSorted((a, b) => b.opener.length - a.opener.length);
  const turn = messages.filter(({ role }) => role === "assistant").length;
  const reply = script?.replies[turn];
  if (typeof reply !== "function") {
    return reply;
  }
  const said = [system, ...messages.map(({ content }) => content)]
    .map(textOf)
    .join("\n");
  try {
    return reply(said);
  } catch {
    return undefined;
  }
};
