import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
  section,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { agentErrors } from "@grasp-os/shared/agent";

import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { dedicatedTools, durableTool } from "./agent-tools.ts";
import {
  askQuestions,
  executeCode,
  instructions,
  latestSections,
  readApi,
  readsUnderWay,
  resultRunId,
  sectionNames,
  sectionsOf,
  withholdRuns,
} from "./agent.ts";
import type { CodeRuns, TurnContext } from "./agent.ts";

// The chat agent as a pi-durable extension (GRA-1529): its tools, the
// sections of its system prompt and the hooks that keep what a chat can no
// longer read from the model. pi-durable runs the loop: the model answers
// or calls tools until it answers, the transcript is stored entry by entry,
// compacted when it grows, and a turn cut short resumes. The Workspace
// (GRA-1544) opens the Harness, installs a chat's extension for each turn,
// with what that turn runs with, and selects it for the chat's
// conversation only (`configure({ extensions: [chatAgent(...)] })`).
//
// Left out on purpose, as Claude Code and Codex do: no limit on the
// requests a turn makes, the code it runs, the dedicated tools it calls or
// the thinking it shows. A person stops a turn by cancelling it, and spend
// is recorded per request by the model gateway, not capped. Nor a request
// for an answer in words after a turn that only showed its thinking: a run
// on pi-durable never ends on such a call, as only a round whose every call
// asks to (`askQuestions`) ends a run without another request. Whether
// the person may still take a turn is the host's to check, as the gateway
// admits each request.

/** What a chat's turn runs with: the tools' APIs, whom they act for, and its guards. */
export interface ChatAgent {
  apis: readonly AgentApi[];
  /** What the model reads besides the instructions: memory, skills, channel, App. */
  context: TurnContext;
  /** Whom and where the code acts for; each run adds its own ID. */
  scope: Omit<AgentScope, "runId">;
  runs: CodeRuns;
  loader: WorkerLoader;
  /** Core's static assets, where Grasp's reference is (build-reference.ts). */
  assets: Fetcher;
  /** Where code runs on-prem, or nowhere but `loader` (`sessionHost`). */
  sandbox?: () => Fetcher | undefined;
  /** Each code run's wall-clock limit (`codeTimeoutMs`). */
  codeTimeoutMs: number;
  /**
   * The chat's transcript as the turn starts: the files it read or wrote,
   * which `editFile` may change.
   */
  history: readonly Message[];
  /** The tool that shows the turn's thinking in the brain (agent-thinking.ts), if it may. */
  thinking?: AgentTool;
  /**
   * The code runs whose results may not reach the model now (workspace.ts),
   * asked before every model request.
   */
  withheld: () => Promise<ReadonlySet<string>>;
  /**
   * Stops the turn, for `reason`: a hook can't end a run itself, so the
   * host aborts the chat's conversation (`Conversation.abort`). The request
   * being prepared goes out withheld as the hook left it, or not at all.
   */
  stop: (reason: Error) => void;
}

/** The extension's name: one per chat, so each conversation selects only its own. */
export const chatAgentName = (chatId: string): string => `grasp.chat.${chatId}`;

/** Every code run whose result `messages` hold. */
const runsIn = (messages: readonly Message[]): Set<string> =>
  new Set(messages.flatMap((message) => resultRunId(message) ?? []));

/**
 * What a request may send of `messages`, and why the turn must stop, if
 * it must. Results of runs the chat can no longer read are withheld, and
 * each section is given only where it was given last, so a stale one
 * (memory a person lost) never reaches the model. A result of the turn
 * under way that is withheld stops the turn: the provider takes the
 * latest response whole. Should a check itself fail, every result is
 * withheld and the turn stops: a hook that throws is skipped, which would
 * send the request as it was.
 */
const guarded = async (
  agent: Pick<ChatAgent, "withheld">,
  messages: readonly Message[]
): Promise<{ messages: Message[]; stop?: Error }> => {
  try {
    const withheld = await agent.withheld();
    return {
      messages: latestSections(withholdRuns(messages, withheld)),
      ...(readsUnderWay(messages, withheld)
        ? { stop: agentErrors.create("agent.history_revoked") }
        : {}),
    };
  } catch (error) {
    return {
      messages: latestSections(withholdRuns(messages, runsIn(messages))),
      stop: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * A chat's agent for one turn, as a pi-durable extension: the instructions
 * and the chat's sections (each tagged by itself, as the model has always
 * read them), `executeCode` in our locked isolate, `readApi`, the
 * dedicated tools the chat's APIs allow, the thinking tool where it may,
 * `askQuestions` in Grasp's own chat only, and the guard before every
 * request.
 */
export const chatAgent = (agent: ChatAgent): Extension => {
  const { apis, scope, runs, assets, context } = agent;
  const sections = sectionsOf(apis, context);
  const tools: AgentTool[] = [
    executeCode(agent),
    readApi(apis),
    ...dedicatedTools({ apis, scope, runs, assets }, agent.history),
    ...(agent.thinking === undefined ? [] : [agent.thinking]),
    // A chat app's chat asks in words: the questions take the composer's
    // place, which only Grasp's own chat has.
    ...(context.channel === undefined ? [askQuestions()] : []),
  ];
  return defineExtension({
    name: chatAgentName(scope.chatId),
    tools: tools.map((tool) => durableTool(tool)),
    sections: [
      // Not `instructions`, the key of a conversation's own, which pi renders last.
      section("preamble", () => instructions, { tag: false }),
      ...sectionNames.map((name) =>
        section(name, () => sections[name] ?? undefined, { tag: false })
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }) => {
          const sent = await guarded(agent, messages);
          if (sent.stop !== undefined) {
            agent.stop(sent.stop);
          }
          return { messages: sent.messages };
        },
      }),
    ],
  });
};
