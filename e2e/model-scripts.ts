/**
 * What the e2e stack's fake providers answer (e2e/model-fake.ts): for each
 * script, the agent's replies in a chat its person opened with `opener`,
 * one per turn of the agent's, in order. The fake keeps no state: each
 * request carries its chat so far, so the turn is the replies the agent
 * already gave in it, and parallel tests never share one. A reply that
 * calls a tool on something the chat names (its App, a workflow) reads
 * it from the request, as the model would: from what the chat said so
 * far, its system prompt among it.
 */
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

/** The workflow the agent plans for suppliers' invoices (`drawsWorkflow`). */
export const workflowPlanned = "Supplier payments";

/** What the agent says once it wrote the contact list (`buildsApp`). */
export const appReady = "Your contact list is ready to try in the preview.";

/** What the agent says once it drew the approval (`drawsApproval`). */
export const approvalDrawn =
  "Drew it: the approver you name decides on each invoice.";

export const modelScripts = {
  /** A chat turn, end to end: the person asks, the agent answers. */
  answers: {
    opener: "What should the weekly sales report cover?",
    replies: [
      says("Revenue by region, the deals that closed, and the pipeline."),
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
   * Something new from Make something that runs on its own: the person
   * says what they want done, Grasp proposes a workflow, and once they say
   * Build it, asks on.
   */
  drawsWorkflow: {
    opener: "Pay our suppliers' invoices once they are checked.",
    replies: [
      calls("planswf01", "proposePlan", {
        parts: [
          {
            kind: "workflow",
            name: workflowPlanned,
            does: "Once an invoice is checked, it is paid.",
          },
        ],
        who: "The finance team",
      }),
      says(
        "Where does a supplier's invoice come in, and who looks at it first?"
      ),
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
          expectedRevision: 0,
          source: invoiceApproval(),
        }),
      says(approvalDrawn),
    ],
  },
  /**
   * An App's own chat whose first page doesn't build: the agent writes
   * the tally with a page that doesn't parse, then, asked, fixes it.
   */
  fixesBrokenTally: {
    opener: "Build a tally, and get it working.",
    replies: [
      (said) =>
        calls(
          "definesbr1",
          "addTable",
          sharedTable(readIn(said, ownApp), "tally", { added: "v.boolean()" })
        ),
      (said) =>
        calls("writesbr1", "writeFile", {
          app: readIn(said, ownApp),
          files: {
            ...codeOf(tallyFiles("in the preview")),
            "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Tally( {

export const Route = createFileRoute("/")({ component: Tally });
`,
          },
        }),
      says("The tally's page doesn't build yet."),
      // Told by the turn's check that its page doesn't build, it answers
      // without fixing it: the draft stays broken until asked.
      says("I'll fix the page when you ask."),
      (said) =>
        calls("fixestly1", "writeFile", {
          app: readIn(said, ownApp),
          files: { "src/routes/index.tsx": tallyPage("Add one") },
        }),
      says("The tally works now."),
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
 * The scripted answer to a provider request's `body`: the next of the
 * replies of the script its chat opened with. Only an agent's turn has
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
  const opened = textOf(messages.find(({ role }) => role === "user")?.content);
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
