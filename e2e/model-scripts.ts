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

import type { Answer } from "../apps/core/test/provider-streams.ts";
import { contactsApp } from "./contacts-app.ts";
import { invoiceApproval } from "./invoice-approval.ts";
import { tallyFiles } from "./tally-app.ts";

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

/** The App an App's own chat builds, as its system prompt names it (core's agent.ts). */
const ownApp = /This chat is the App (?<found>\S+)'s own chat/u;

/** The SDK's `app`, as a search of Grasp's reference finds it (core's agent-tools.ts). */
const sdkApp = /(?<found>@grasp-os\/sdk\/src\/app\.ts:\d+:export const app =)/u;

/** The workflow open beside a chat, as its first message names it (web's draw-in-chat.ts). */
const besideWorkflow = /\(ID (?<found>[^)\s]+)\) is open beside this chat/u;

/** That workflow's name, as the same message names it. */
const besideWorkflowName =
  /Workflow (?<found>\S+) \(ID [^)\s]+\) is open beside/u;

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
   * A new workflow drawn in its chat: the person answers the page's own
   * first question, which business process it is for, and Grasp asks on.
   */
  drawsWorkflow: {
    opener: "Which business process is this workflow for?",
    replies: [
      says(
        "Purchase-to-Pay, then. Where does a supplier's invoice come in, and who looks at it first?"
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
              files: tallyFiles("in the preview"),
            },
          },
        ],
        inputTokens: 200,
        outputTokens: 40,
      }),
      says("The tally is in the preview."),
    ],
  },
  /**
   * A new App built in its own chat: the agent reads how an App is
   * written in Grasp's reference (a search of it), writes a contact
   * list's files into its draft, and says it is ready to try. It never proposes it: the builder
   * publishes the draft themselves.
   */
  buildsApp: {
    opener:
      "A contact list for the sales team: each contact's name, added from its screen.",
    replies: [
      calls("findsapp1", "searchFiles", {
        text: "export const app =",
        path: "@grasp-os/sdk/src/app.ts",
      }),
      // Only once the reference answered with how `app` is declared: a
      // search that failed or found nothing ends the script.
      (said) => {
        readIn(said, sdkApp);
        return calls("writesap1", "writeFile", {
          app: readIn(said, ownApp),
          files: contactsApp,
        });
      },
      says(appReady),
    ],
  },
  /**
   * A new workflow drawn in its chat, for Opportunity-to-Cash: the agent saves
   * an invoice approval, a person's decision, as the draft's first
   * revision, and says so.
   */
  drawsApproval: {
    opener: "Which business process is this workflow for? Opportunity-to-Cash",
    replies: [
      (said) =>
        calls("editswf01", "editWorkflow", {
          workflow: readIn(said, besideWorkflow),
          expectedRevision: 0,
          source: invoiceApproval(readIn(said, besideWorkflowName)),
          modules: {},
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
  // begin another's (the process question, then which process).
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
