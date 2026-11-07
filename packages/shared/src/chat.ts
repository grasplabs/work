import { z } from "zod";

import type { AppFiles } from "./apps.ts";
import type { DataModelChange, DraftDataModel } from "./data-model.ts";
import type { DependencyRequest } from "./dependencies.ts";
import type { AppId } from "./ids.ts";
import type { ModelEffort, ModelEfforts, ModelErrorCode } from "./models.ts";
import type { PageBundle, PageProblem } from "./pages.ts";
import type { ThinkingStep } from "./thinking.ts";
import { uploadTypes } from "./uploads.ts";

// A person's chats with the organization's agent, as the frontend sees them
// (core's chats-rpc.ts). Each chat belongs to the person who made it: only
// they list, rename, delete, ask in or follow it.

/**
 * A chat app a person talks to the agent through, by the name of its Chat
 * SDK adapter (`teams` first, any platform after): lowercase, so it reads
 * the same in a chat, an audit event and the door it came through
 * (`/api/channels/<platform>`). Never `web`, which is Grasp's own.
 */
export const chatPlatformSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/u)
  .refine((platform) => platform !== "web", {
    message: "web is Grasp's own channel, not a chat platform",
  });

export type ChatPlatform = z.infer<typeof chatPlatformSchema>;

/**
 * The chat platforms and mail Grasp is reached through, as each writes its
 * own name, by adapter name: the same in every language. Every list of
 * chat accounts, places and chats names them from here.
 */
export const chatPlatformNames: Readonly<Record<string, string>> = {
  teams: "Microsoft Teams",
  slack: "Slack",
  discord: "Discord",
  gchat: "Google Chat",
  "google-chat": "Google Chat",
  github: "GitHub",
  linear: "Linear",
};

/** A chat platform as people know it, or its adapter's name for one not listed. */
export const chatPlatformName = (platform: string): string =>
  chatPlatformNames[platform] ?? platform;

/**
 * Which channel a chat came through: Grasp's own app (`web`), or a chat
 * platform.
 */
export const chatChannelSchema = z.union([
  z.literal("web"),
  chatPlatformSchema,
]);
export type ChatChannel = z.infer<typeof chatChannelSchema>;

/** A chat's title: what the person, or their first question, named it. */
export const chatTitleSchema = z.string().trim().min(1).max(200);

/** A chat in the person's list. */
export interface ChatSummary {
  id: string;
  title: string;
  /** When it was made (ISO 8601). */
  createdAt: string;
  /**
   * When it last had a message, or when it was made before it had any
   * (ISO 8601): what `ChatsApi.list` orders by, the most recent first.
   */
  lastAt: string;
  /** Whether its agent is working on a question now. */
  running: boolean;
  /** The App it is for (`ChatsApi.forApp`), or null for none. */
  appId: string | null;
  /**
   * Which channel it came through: Grasp's own app (`web`), or a chat
   * platform by its adapter's name (`teams`, `slack`), for good.
   */
  via: ChatChannel;
}

/**
 * Where a search was found in what was said in a chat: the words just
 * before it, what matched as it was said, and the words after it; cut
 * ends carry an ellipsis.
 */
export interface ChatSearchSnippet {
  before: string;
  found: string;
  after: string;
}

/** A chat a search found (`ChatsApi.search`). */
export interface ChatSearchHit {
  chat: ChatSummary;
  /**
   * Where it was said, for a chat whose title doesn't hold every word
   * searched for; null for one it does.
   */
  said: ChatSearchSnippet | null;
}

// Files attached to a question: the person attaches each to the chat
// (`ChatsApi.attachFile`), core reads its text then, with Knowledge's
// extractor, and the question that names it (`ChatQuestion.files`) carries
// it. Its agent reads the text as data (`env.chat.readFile`), never as its
// instructions. Only the text is kept, with the chat, and goes with it.

/**
 * The file types a chat file may be, by extension: what Knowledge reads
 * an upload of, and plain text.
 */
export const chatFileTypes = {
  pdf: uploadTypes.pdf,
  docx: uploadTypes.docx,
  xlsx: uploadTypes.xlsx,
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
} as const;
export type ChatFileType = keyof typeof chatFileTypes;

/** Largest file one attachment takes, in bytes: 10 MB, as an upload. */
export const chatFileMaxBytes = 10 * 1024 * 1024;

/** Most files one question carries. */
export const chatFilesPerQuestionMax = 5;

/** Most files one chat keeps, sent or waiting for their question. */
export const chatFilesMax = 20;

const fileExtension = /\.(?<extension>[A-Za-z]+)$/u;

const isChatFileType = (value: string): value is ChatFileType =>
  Object.hasOwn(chatFileTypes, value);

/** A chat file's type, by its name's extension; `undefined` for none it takes. */
export const chatFileTypeOf = (name: string): ChatFileType | undefined => {
  const extension = fileExtension.exec(name)?.groups?.extension?.toLowerCase();
  return extension !== undefined && isChatFileType(extension)
    ? extension
    : undefined;
};

/** A file attached to a chat, as its person sees it. */
export interface ChatFile {
  id: string;
  /** The file's name, as it was attached. */
  name: string;
  type: ChatFileType;
  /** The file's size, in bytes. */
  bytes: number;
  /** When it was attached (ISO 8601). */
  createdAt: string;
}

/** A file to attach: its name, with one of {@link chatFileTypes}, and itself. */
export interface ChatFileInput {
  name: string;
  bytes: Uint8Array;
}

/**
 * An App the chat's agent changes in the chat's own draft
 * (`ChatsApi.drafts`): with no `changed` paths once its changes were
 * proposed or discarded, when its preview shows the App's latest version.
 */
export interface ChatDraft {
  app: string;
  /** The version the draft is over; null for an App with none yet. */
  base: number | null;
  /** The paths it changes, sorted. */
  changed: string[];
  /** Those of `changed` it deletes, sorted: nothing to open or preview. */
  deleted: string[];
  /** Which write of the draft this is: a preview of an earlier one is out of date. */
  revision: number;
  /** When it was last written (ISO 8601). */
  updatedAt: string;
  /**
   * The code step or tool call (`ChatCode.callId`, `ChatToolCall.callId`)
   * that wrote this revision:
   * where the thread shows the draft's preview. Null when core doesn't
   * know it (a revision written before it kept one).
   */
  callId: string | null;
}

/**
 * The revision a preview of a version of the draft carries
 * (`ChatsApi.preview` with `version`): no draft
 * is ever at it (a chat's draft starts at 0, before its first write), so
 * every call of that preview (function, query, stream) is refused, the
 * latest version's too, and nothing it reports is kept. Read-only by
 * construction.
 */
export const readOnlyRevision = -1;

/**
 * The build a frame of a chat's preview shows, which its reports name and
 * its updates are asked from: the draft at its revision
 * (`readOnlyRevision` for a version of the draft opened read-only), or a
 * version of the App, shown while the draft changes nothing or its page
 * doesn't build. Only the draft's own revision counts toward the agent's
 * check of the draft. Its calls name nothing of it: they run on the draft
 * as it is, under the frame's lease (`PreviewBundle.lease`).
 */
export type PreviewAt = number | { appVersion: number };

/** What a frame showing `refresh` names (`PreviewAt`). */
export const shownAt = ({
  revision,
  appVersion,
}: Pick<PreviewRefresh, "revision" | "appVersion">): PreviewAt =>
  appVersion === undefined ? revision : { appVersion };

/**
 * One agent turn's writes of the chat's draft of an App, kept as the turn
 * left the draft, or one restore (`ChatsApi.draftVersions`): the newest
 * follows its turn's writes while the turn runs, then never changes; and
 * is restored only as a new one.
 */
export interface ChatDraftVersion {
  /** Its place among the draft's versions, from 1, in the order they landed. */
  number: number;
  /** The draft's revision it made: its preview's calls name it. */
  revision: number;
  /** The version of the App it is over; null for an App with none yet. */
  base: number | null;
  /** The SHA-256 of what it holds: two versions alike hold the same. */
  contentHash: string;
  /**
   * The code step or tool call (`ChatCode.callId`, `ChatToolCall.callId`)
   * that wrote it last, when the
   * chat's agent did; null when the person restored an earlier one.
   */
  callId: string | null;
  /** The version the person restored as this one, if they did. */
  restoredFrom: number | null;
  /** When it was written (ISO 8601). */
  createdAt: string;
}

/**
 * A page of the chat's draft of an App, ready for a frame, as
 * `PageBundle` is for a running App (`ChatsApi.preview`): at the draft's
 * revision instead of a version, with the names of the draft's pages.
 */
export interface PreviewBundle extends Omit<PageBundle, "version" | "lease"> {
  /**
   * The draft's revision it was opened at; `readOnlyRevision` for a
   * version of the draft opened read-only. A frame that takes updates
   * names what its `refresh` shows (`shownAt`) in its reports.
   */
  revision: number;
  /**
   * Core's lease for the builder on the chat's draft, which the frame's
   * calls and live queries carry on the path every page calls on, as a
   * running App's page carries its own: they run on the draft as it is
   * then, on a throwaway store with no resources. Only for the draft as it
   * is now; a version opened read-only has none, and calls nothing.
   */
  lease?: string;
  /**
   * The pages' modules, as the frame opened them: what later updates
   * are measured against (`PreviewUpdate`). Only for the draft as it is
   * now; a version opened read-only never updates.
   */
  refresh?: PreviewRefresh;
  /**
   * The draft's changes left it no page that builds at
   * `refresh.revision`: the frame opened on the App's latest version
   * instead (`refresh.appVersion`), as a draft that changes nothing shows
   * it, its calls on that version, and takes the draft's next write that
   * builds.
   */
  fallback?: true;
}

/**
 * A chat's draft's pages at one revision, for the preview's frame to
 * import and swap in with React Fast Refresh: their route tree's module's
 * address, among the modules core staged for the preview, which the frame
 * loads from core as it imports it, only those it hasn't loaded yet, and
 * the CSS of that revision.
 */
export interface PreviewRefresh {
  /** The draft's revision it was built from. */
  revision: number;
  /** The address of the route tree's module. */
  entry: string;
  /** The App's modules it loads, its own among them: each one's UTF-8 bytes, by address. */
  modules: Record<string, number>;
  css: string;
  /**
   * The kit's modules it imports, by flat name: an update that needs one
   * the frame didn't load can't come in through Refresh, as the frame's
   * import map is fixed once it loaded.
   */
  kit: string[];
  /**
   * The App's version it is of, when it shows one rather than the draft's
   * changes: a draft that changes nothing shows the App's latest, as does
   * a frame in place of a draft whose pages don't build.
   */
  appVersion?: number;
  /**
   * The draft's server code at `revision` doesn't build: its pages are
   * built against, and calls, the last server code of the preview that
   * did (or the App's latest version), and the problem is being fixed.
   */
  serverUnbuilt?: true;
}

/**
 * What an open frame of a chat's preview shows as it asks for an update
 * (`ChatsApi.previewUpdate`): the App's version it shows, when it shows
 * one rather than the draft's changes.
 */
export const previewShownSchema = z.strictObject({
  appVersion: z.int().positive().optional(),
});

/** What an open frame of a chat's preview shows (`previewShownSchema`). */
export type PreviewShown = z.infer<typeof previewShownSchema>;

/**
 * What `ChatsApi.previewUpdate` answers an open frame: a build of its
 * pages to swap in (`refresh`); that the build it shows is still the
 * one to show (`unchanged`); or that the one to show is one it can't swap
 * in, another version of the App (`restart`), which it opens afresh on,
 * at the route it showed, as a published App's page does on a new
 * version.
 */
export type PreviewUpdate =
  | { app: AppId; refresh: PreviewRefresh }
  | { app: AppId; unchanged: true }
  | { app: AppId; restart: true };

/**
 * A problem a preview of a draft reported (`ChatsApi.previewReport`), or
 * one its server code failed with: text the draft's code wrote, held to
 * size, and only ever read as data.
 */
export interface PreviewProblem {
  /** On one of the draft's pages, or in its server code. */
  source: "page" | "server";
  /** The route it happened at, or the server method that failed. */
  at: string;
  /**
   * `warning`: a `console.error` call of the kit's, such as React's
   * development warnings, which a draft's check shows and never fails on.
   */
  kind: "error" | "rejection" | "console" | "failed" | "warning";
  message: string;
  stack?: string;
}

/** Code the agent ran, or is writing, in a code step. */
export interface ChatCode {
  /** Pairs the code with its result. */
  callId: string;
  code: string;
}

/**
 * The agent's tools that change an App's definition (core's
 * agent-tools.ts), as their calls name them: the thread says of each that
 * it changed the App's definition.
 */
export const definitionToolNames = [
  "addTable",
  "addField",
  "changeField",
  "renameField",
  "setAccess",
  "addIndex",
  "addPermission",
  "removeTable",
  "removeField",
  "removeIndex",
  "removePermission",
  "addPreference",
  "changePreference",
  "removePreference",
  "moveField",
] as const;

/**
 * A call of one of the agent's tools made for what it does most (core's
 * agent-tools.ts: `writeFile`, `searchBrain`, …), which the thread shows as
 * one line saying what it did, where a code step shows its code. Its
 * result is a `result` message by the same `callId`, as a code step's is.
 */
export interface ChatToolCall {
  callId: string;
  /** The tool, by its name. */
  tool: string;
  /**
   * How many of the response's code steps (`code`) came before it: the
   * thread shows its steps in the order the response made them.
   */
  codeBefore: number;
  /**
   * What it was given, as far as it has streamed in. While the response is
   * written, each text in it is cut short (`chatToolPreviewChars`).
   */
  input: Record<string, unknown>;
}

/** Most characters of each text a tool call's input shows while it is written. */
export const chatToolPreviewChars = 200;

/** How one of the agent's responses ended. */
export type ChatReplyEnd =
  /** It answered, or asked for code to run. */
  | "done"
  /** It hit the model's output limit. */
  | "cut_off"
  | "cancelled"
  | "failed";

/**
 * What one of the agent's replies used, as the model gateway counted it:
 * counts only, never content. The prompt it was sent is `input` and the
 * cache's (`cacheRead`, `cacheWrite`) together: how full the model's
 * window was, against `contextWindow`.
 */
export interface ChatReplyUsage {
  /** Prompt tokens neither read from nor written to the provider's cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** US dollars, at the prices the gateway charges budgets by. */
  cost: number;
  /** The model's context window, in tokens; null when core doesn't know it. */
  contextWindow: number | null;
}

/**
 * A note an answer cites: a Knowledge document the chat's code was given
 * by one of its reads before the answer, which the answer links to as
 * `[title](grasp:note/<documentId>)`. Only its ID: who reads the answer
 * resolves it with their own access.
 */
export interface ChatCitation {
  kind: "document";
  documentId: string;
}

/** Most citations one answer carries: the first it links to. */
export const chatCitationsMax = 50;

/**
 * A span of an answer that cites a document: one of its links to the
 * note, `[text](grasp:note/<documentId> "quote")`, as stored. `at` is where
 * the link starts in the answer's text (the offset of its `[`), so a page
 * finds it as it renders the Markdown; `text` is the words it links, as
 * Markdown. `quote` is the words of the document it rests on, which the
 * answer wrote as the link's title, only when the document says them now
 * (whitespace aside), and never longer than {@link citedQuoteMax}; else
 * null, and the span cites the document alone.
 */
export interface ChatCitedSpan {
  at: number;
  text: string;
  quote: string | null;
}

/** Longest quote a cited span keeps (`ChatCitedSpan`). */
export const citedQuoteMax = 300;

/**
 * A document an answer cites (`ChatCitation`), as the chat's agent may
 * read it for the chat's person now: where it is, what it is called, and
 * the start of what it says (its description, or else its first section),
 * cut to {@link citedSnippetMax} characters; and the spans of the answer
 * that cite it, in order, each with its quote. A document either of them
 * can no longer read, or that is gone, is never one, so neither are its
 * spans nor their quotes.
 */
export interface ChatCitedDocument {
  documentId: string;
  collectionId: string;
  title: string;
  path: string;
  snippet: string;
  spans: ChatCitedSpan[];
}

/** Longest snippet of a cited document (`ChatCitedDocument`). */
export const citedSnippetMax = 200;

/**
 * How much the chat's agent may ask at once (`askQuestions`, GRA-1001):
 * a few short questions, each with a few short choices, plain text, one
 * line each. The person can always answer otherwise ("Something else") or
 * type instead.
 */
export const chatAskLimits = {
  questions: 4,
  choicesMin: 2,
  choices: 6,
  questionLength: 300,
  choiceLength: 120,
} as const;

/** Text starting and ending with something other than space. */
const unpadded = /^\S(?:.*\S)?$/su;

/**
 * What a question or a choice never holds: controls (line breaks among
 * them), invisible formatting (bidi overrides, zero-width characters) and
 * the line and paragraph separators, so it shows as the one line it reads
 * as, and can't pass for something the page itself shows.
 */
const notInAskLine = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * One line of plain text, as a question or a choice is: taken as written
 * or refused, never trimmed.
 */
const askLine = (max: number) =>
  z
    .string()
    .max(max)
    .regex(unpadded)
    .refine((line) => !notInAskLine.test(line) && line.isWellFormed(), {
      message:
        "A question or choice is one line of well-formed text, with no control or invisible formatting characters",
    });

/** What the agent asks the person at once, as it calls `askQuestions`. */
export const chatAskSchema = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        question: askLine(chatAskLimits.questionLength),
        choices: z
          .array(askLine(chatAskLimits.choiceLength))
          .min(chatAskLimits.choicesMin)
          .max(chatAskLimits.choices)
          .refine((choices) => new Set(choices).size === choices.length, {
            message: "A question's choices are all different",
          }),
      })
    )
    .min(1)
    .max(chatAskLimits.questions),
});
export type ChatAsk = z.infer<typeof chatAskSchema>;

/**
 * Questions the agent asked the person, with choices: data, never
 * commands. A choice only says what the person may answer; their answer
 * is their own next message, and anything the agent then changes still
 * waits for them to confirm it in Grasp.
 */
export interface ChatAsked extends ChatAsk {
  /** The call that asked them. */
  callId: string;
}

/**
 * What the model thought before it answered, as its provider let it be
 * shown: its own words, or a summary of them (OpenAI's). A redacted part
 * (Anthropic's safety filters) shows nothing, but its time counts.
 */
export interface ChatReasoning {
  /** Its parts, joined; empty when the provider showed none of it. */
  text: string;
  /**
   * How long it thought, in milliseconds, from its first word to its last
   * (core's clock, as the answer streamed in); null for a reply core kept
   * before it timed it.
   */
  ms: number | null;
}

/**
 * One stored message of a chat, oldest first by `id`. The agent's
 * instructions and the APIs it was shown aren't among them.
 */
export type ChatMessage =
  | {
      id: number;
      role: "user";
      text: string;
      /** The files the question carried, in the order they were attached. */
      files?: ChatFile[];
      at: string;
    }
  | {
      id: number;
      role: "assistant";
      /**
       * Its answer, in Markdown. A link to a note it was given stays a
       * `grasp:note/<documentId>` link, one of `citations`; one to any
       * other note is shown as its text alone.
       */
      text: string;
      /** The notes it cites, in the order it first links to them. */
      citations: ChatCitation[];
      /** The code it asked to run, each run in a code step. */
      code: ChatCode[];
      /** The calls of its other tools, each shown as one line. */
      tools: ChatToolCall[];
      /** What the model thought before it, when it thought. */
      reasoning?: ChatReasoning;
      /**
       * The questions it asked the person, with choices, if it ended its
       * response asking them (`askQuestions`): shown in place of the
       * composer until they answer.
       */
      asked?: ChatAsked;
      end: ChatReplyEnd;
      /**
       * Why it failed, as one of the model gateway's error codes: the page
       * says it in people's words, never the gateway's or a provider's.
       */
      failure?: ModelErrorCode;
      /**
       * What the reply used, as the model gateway counted it; none for one
       * no model wrote (core's own words, after a restart).
       */
      usage?: ChatReplyUsage;
      at: string;
    }
  | {
      id: number;
      role: "result";
      /**
       * The code step or tool call this is the result of (`ChatCode.callId`,
       * `ChatToolCall.callId`).
       */
      callId: string;
      /** What the code or tool returned, logged or threw, as the agent read it. */
      text: string;
      failed: boolean;
      at: string;
      /**
       * A step of thinking the brain showed (`show_thinking`, see
       * `ThinkingStep`), for the result of a call that showed one; none
       * for any other.
       */
      thinking?: ThinkingStep;
    };

/**
 * What the agent is writing now, before it is stored. It holds no note
 * link: each is its text alone until the answer is stored and its
 * citations decided. A page makes a `grasp:note/<id>` link a link only
 * when `<id>` is among that stored message's `citations`, never in this.
 */
export interface ChatPartial {
  text: string;
  code: ChatCode[];
  /** Its calls of other tools so far, their texts cut short. */
  tools: ChatToolCall[];
  /** What the model thought so far (`ChatReasoning.text`); empty for nothing. */
  reasoning: string;
}

/**
 * What a chat's answers may hold: every source the chat has read from
 * (collections and connections, by ID, and the failed run it was started
 * to fix, with its App's sources), and whether it read restricted data,
 * which puts it in restricted mode for good.
 */
export interface ChatProvenance {
  sources: string[];
  restricted: boolean;
}

/**
 * What the response being written gained since the watcher's last update:
 * each text as the length of what the watcher has that stays (`from`; 0
 * starts it afresh) and what follows it. `applyPartial` puts it together.
 */
export interface ChatPartialUpdate {
  from: number;
  text: string;
  /** Every code step of the response, each as its own text is. */
  code: { callId: string; from: number; code: string }[];
  /** Every other tool call of the response, whole: their texts are cut short. */
  tools: ChatToolCall[];
  /** What the model thought, as `from` and `text` are for its answer. */
  reasoning: { from: number; text: string };
}

/** A text the watcher has, with what an update adds from `from` on. */
const extended = (shown: string, from: number, added: string): string =>
  `${shown.slice(0, from)}${added}`;

/**
 * The response being written, as the watcher had it (`shown`), with an
 * update's change applied; `null` between responses.
 */
export const applyPartial = (
  shown: ChatPartial | null,
  update: ChatPartialUpdate | null
): ChatPartial | null => {
  if (update === null) {
    return null;
  }
  return {
    text: extended(shown?.text ?? "", update.from, update.text),
    code: update.code.map(({ callId, from, code }) => ({
      callId,
      code: extended(
        shown?.code.find((step) => step.callId === callId)?.code ?? "",
        from,
        code
      ),
    })),
    tools: update.tools,
    reasoning: extended(
      shown?.reasoning ?? "",
      update.reasoning.from,
      update.reasoning.text
    ),
  };
};

/**
 * What the code step running now has logged so far, as the chat shows it
 * before the step's result: redacted, and cut where it passed the run's
 * output budget. `callId` is the code step (`ChatCode.callId`).
 */
export interface ChatOutput {
  callId: string;
  text: string;
}

/**
 * What the running step's output gained since the watcher's last update:
 * the length of what the watcher has that stays (`from`; 0 starts it
 * afresh, as for another step) and what follows it.
 */
export interface ChatOutputUpdate {
  callId: string;
  from: number;
  text: string;
}

/**
 * The running step's output, as the watcher had it (`shown`), with an
 * update's change applied (none when the update leaves it out); `null`
 * while no step runs.
 */
export const applyOutput = (
  shown: ChatOutput | null,
  update: ChatOutputUpdate | null | undefined
): ChatOutput | null => {
  if (update === undefined) {
    return shown;
  }
  if (update === null) {
    return null;
  }
  const kept = shown?.callId === update.callId ? shown.text : "";
  return {
    callId: update.callId,
    text: extended(kept, update.from, update.text),
  };
};

/**
 * How one call of the chat's code ended: done, held for the person to
 * confirm (a connection's side effect), refused (an expected error: no
 * permission, an unknown ID, a run that had ended), or failed.
 */
export type ChatToolOutcome = "ok" | "pending" | "refused" | "failed";

/**
 * One call the chat's code made to one of its agent's APIs (Code Mode),
 * as a line a page can show under the code step that made it: the call
 * the audit log records, by the same words. Its summary holds identifiers
 * and counts of what it was given and what it found, never what it read:
 * the run's ID, how many hits a search had, which connection it called.
 */
export interface ChatToolEvent {
  /** Its order in the chat: a later call has a higher ID. */
  id: number;
  /** The code step that made it (`ChatCode.callId`). */
  callId: string;
  /** The API and method, as the code called it, such as `workflows.runs`. */
  method: string;
  /** What it acted on, when the audit log names one. */
  target: { type: string; id: string } | null;
  /** Identifiers and counts of its input and result, never their content. */
  summary: Record<string, string | number | boolean | null>;
  outcome: ChatToolOutcome;
  /** Why it was refused or failed: an error code. */
  reason: string | null;
  at: string;
}

/** Most calls a chat keeps the events of: its latest. */
export const chatToolEventsKept = 200;

/**
 * What changed in a chat since the last update: the messages stored since,
 * and the chat as it is now. The first update of a `watch` catches up: the
 * messages after the one it named, what the agent is writing then, and
 * the chat's provenance.
 */
export interface ChatUpdate {
  messages: ChatMessage[];
  /**
   * What the response being written gained (`applyPartial`); `null`
   * between responses.
   */
  partial: ChatPartialUpdate | null;
  /**
   * What the code step running now logged since (`applyOutput`); `null`
   * while none runs, and left out when it didn't change. Its result
   * replaces it once stored.
   */
  output?: ChatOutputUpdate | null;
  /**
   * The calls the chat's code made since the last update, oldest first;
   * in a watch's first update, every one the chat keeps (the latest
   * {@link chatToolEventsKept}), which a page merges by ID. Left out when
   * there are none.
   */
  tools?: ChatToolEvent[];
  /** Whether the agent is working on a question. */
  running: boolean;
  /** The chat's provenance: in the first update, and whenever it changes. */
  provenance?: ChatProvenance;
  /**
   * Why the last question stopped before the agent answered, when it
   * wasn't the model (the person left). Kept
   * until the next question starts (then `null`), and not over a restart.
   */
  stopped: string | null;
  /**
   * Changes whenever something of the chat waits for the person, or no
   * longer does: a write its agent had held for them to confirm, or a
   * connection or packages it asked for (`connectionRequests`,
   * `packageRequests`). Read them again then.
   * Only a count, from when the object last started; never what waits.
   */
  held: number;
  /**
   * Changes whenever the chat's agent writes or drops a draft: read the
   * drafts again then, and preview the latest. Only a count, from when
   * the object last started.
   */
  drafts: number;
  /**
   * Whether the turn checks the drafts it wrote now, past its answer
   * (core's agent-builds.ts, `turnCheck`): the chat takes no question
   * until it ends. Left out by an earlier release.
   */
  checking?: boolean;
}

/**
 * A connection the chat's agent asked to use in this chat alone, waiting
 * for a decision: the person's own personal connection, which they grant
 * or deny themselves (`decidedBy: "you"`), or a shared one, which only an
 * admin grants (`"admin"`) and they may still withdraw. Everything but
 * the connection's name is the request as stored: granting it grants
 * exactly this.
 */
export interface ChatConnectionRequest {
  /** The permission it would be. */
  id: string;
  connectionId: string;
  /** The connection's provider and account, while connect lists it. */
  provider: string | null;
  accountName: string | null;
  resource: string | null;
  actions: string[];
  /** The name the agent's code would call it by. */
  binding: string;
  /** Why the agent asked, in its words. */
  reason: string | null;
  /** ISO 8601. */
  requestedAt: string;
  decidedBy: "you" | "admin";
}

/** A question for the chat's agent, and the model to answer it with. */
export interface ChatQuestion {
  text: string;
  /** One of `ChatsApi.models()`. */
  model: string;
  /**
   * How hard the model thinks before it answers: one of the levels
   * `ChatsApi.efforts()` lists for `model`; without one, its default
   * there. A level the model doesn't take becomes the next one up that it
   * does, or its highest when it has none above; a model that doesn't
   * think ignores it.
   */
  effort?: ModelEffort;
  /**
   * The chat's files the question carries (`ChatsApi.attachFile`), at
   * most {@link chatFilesPerQuestionMax}: each one attached and not yet
   * carried by another question.
   */
  files?: string[];
}

/**
 * A hold on a chat's updates (`watch`), until it's released: then core
 * sends no more, and the slot it took is free again.
 */
export interface ChatSubscriptionApi {
  release: () => Promise<void>;
}

/** The signed-in person's chats with the organization's agent. */
export interface ChatsApi {
  /** The models a question may name, the default first. */
  models: () => Promise<string[]>;
  /**
   * The efforts a question may name with each of `models()`, and the one
   * it gets naming none: no levels for a model that doesn't think, so
   * none is offered for it.
   */
  efforts: () => Promise<Record<string, ModelEfforts>>;
  /** The person's chats, the most recently active first. */
  list: () => Promise<ChatSummary[]>;
  /**
   * The person's own chats that hold every word of `query` in their title
   * or what was said in them, the most recently active first: at most a
   * page's worth. Never anyone else's.
   */
  search: (query: string) => Promise<ChatSearchHit[]>;
  /**
   * One of the person's chats, as `list` gives it, however long ago it was
   * active: for a chat past the end of the list. Not theirs, or not there,
   * is `agent.chat_not_found`.
   */
  summary: (chatId: string) => Promise<ChatSummary>;
  /** Makes a chat. */
  create: (title: string) => Promise<ChatSummary>;
  /**
   * The person's chat for App `app`, where its agent changes the App with
   * them: the one they last used, or a new one named after the App. Only
   * for someone who builds the App, and not while it is archived.
   */
  forApp: (app: string) => Promise<ChatSummary>;
  /**
   * A new App (`apps.create`'s input), owned by the person, with its own
   * chat (`forApp`), made together. Like every App, it stays until a
   * person removes it. Refused before anything is made when the person
   * has no room for another chat. Only for a builder.
   */
  newApp: (input: {
    name: string;
    description: string;
  }) => Promise<ChatSummary & { appId: string }>;
  /** Renames one of the person's chats. */
  rename: (chatId: string, title: string) => Promise<void>;
  /**
   * Deletes the chat and its messages, rejecting every write its agent
   * holds; refused while its agent works.
   */
  remove: (chatId: string) => Promise<void>;
  /**
   * Attaches a file to the chat, for its next question to carry: a file
   * of one of {@link chatFileTypes} of at most {@link chatFileMaxBytes},
   * up to {@link chatFilesMax} a chat. Resolves once its text is read,
   * and is refused with why when it can't be. Audited.
   */
  attachFile: (chatId: string, file: ChatFileInput) => Promise<ChatFile>;
  /**
   * Removes a file attached to the chat that no question carries yet,
   * freeing its place among the chat's {@link chatFilesMax}. A file a
   * question carried stays: refused as `agent.file_not_found`. Refused as
   * `agent.busy` while the chat's agent works, as a starting question may
   * carry it. Audited.
   */
  removeFile: (chatId: string, fileId: string) => Promise<void>;
  /**
   * Asks the chat's agent a question. Resolves once the agent has taken
   * it; the answer streams to `watch`, and goes on without anyone
   * watching.
   */
  send: (chatId: string, question: ChatQuestion) => Promise<void>;
  /**
   * The Apps the chat's agent changes in the chat's drafts, those whose
   * changes are proposed or discarded too, most recently written first.
   */
  drafts: (chatId: string) => Promise<ChatDraft[]>;
  /**
   * The documents the chat's answer `messageId` cites, in the order it
   * first links to them, each only while the chat's agent may still read
   * it for the person; none for a message that isn't an answer.
   */
  cited: (chatId: string, messageId: number) => Promise<ChatCitedDocument[]>;
  /**
   * Every version of the chat's draft of `app`, newest first: for the
   * person while they build the App.
   */
  draftVersions: (chatId: string, app: string) => Promise<ChatDraftVersion[]>;
  /**
   * Every file of the chat's draft of `app` as it is now, as its agent
   * reads them: its changes over the version it is over, or the App's
   * latest version while it changes nothing. For the App's code view,
   * read-only: for the person while they build the App.
   */
  draftFiles: (chatId: string, app: string) => Promise<AppFiles>;
  /**
   * Makes version `version` of the chat's draft of `app` the draft again,
   * as a new version: for the person while they build the App.
   */
  restoreDraftVersion: (
    chatId: string,
    app: string,
    version: number
  ) => Promise<ChatDraftVersion>;
  /**
   * Discards the chat's draft of `app`: its changes go, and the agent's
   * next write starts over from the App's latest version; its versions
   * stay, to restore one. For the person while they build the App.
   */
  discardDraft: (chatId: string, app: string) => Promise<void>;
  /**
   * Proposes the chat's draft of `app` as the App's next version, up for
   * review, by the person themselves, with `message`: checked first, as
   * when the chat's agent proposes it, and refused with
   * `app.draft_failed` when the check fails. Resolves with the version.
   * For the person while they build the App, and not from a chat that
   * read restricted data.
   */
  proposeDraft: (
    chatId: string,
    app: string,
    message: string
  ) => Promise<number>;
  /**
   * The data model of the chat's draft of `app`, from its definition,
   * and what publishing the draft does to the App's records: for the
   * person while they build the App.
   */
  dataModel: (chatId: string, app: string) => Promise<DraftDataModel>;
  /**
   * Changes the definition of the chat's draft of `app` by `operation`
   * (an operation of `@grasp-os/sdk/definition`, as the chat's agent's
   * definition tools make them, or a few made as one: a field renamed and
   * retyped), by the person themselves: the model after it, the plan, and
   * what this change alone does (`change`), or the problem, which changed
   * nothing. With
   * `preview`, nothing is saved: what it would do, to show first. For the
   * person while they build the App, unless it is archived.
   */
  defineDraft: (
    chatId: string,
    app: string,
    operation: unknown,
    preview?: boolean
  ) => Promise<DataModelChange>;
  /**
   * The pages of the chat's draft of `app`, built, to preview: for the
   * person while they build the App, from a chat that changes it or is its
   * own
   * (`app.not_in_chat` otherwise). A draft that changes nothing previews
   * the App's latest version, at the draft's revision, so its next write
   * comes into the frame; one whose changes leave no page that builds
   * opens on that version too (`PreviewBundle.fallback`). With `version`,
   * of that version of the draft, read-only: at `readOnlyRevision`, so its
   * calls are all refused.
   */
  preview: (
    chatId: string,
    app: string,
    version?: number
  ) => Promise<PreviewBundle>;
  /**
   * What an open frame of the chat's preview of `app`, showing `shown`,
   * takes at `revision`, the newest the preview knows of
   * (`PreviewUpdate`): a build of the draft is built and its modules
   * staged for the frame to import and swap in with React Fast Refresh,
   * one build per revision, shared by every preview that asks for it, and
   * `app.preview_outdated` once the draft moved past `revision`. No frame
   * is staged and nothing sealed, and the build's type check and lint
   * don't hold it up. For the person while they build the App.
   */
  previewUpdate: (
    chatId: string,
    app: string,
    revision: number,
    shown: PreviewShown
  ) => Promise<PreviewUpdate>;
  /**
   * Tells the chat's agent of `problem`, one the preview of the draft at
   * `at` ran into at the route `path` (an uncaught error, an unhandled
   * rejection or a `console.error`). Its next check of the draft reads them. A
   * report of a revision the draft moved past, or of a version of the
   * App, is dropped.
   */
  previewReport: (
    chatId: string,
    app: string,
    at: PreviewAt,
    path: string,
    problem: PageProblem
  ) => Promise<void>;
  /** Stops the agent's work on the chat; `false` when there was none. */
  cancel: (chatId: string) => Promise<boolean>;
  /** The npm packages the chat's agent asked for that wait, oldest first. */
  packageRequests: (chatId: string) => Promise<DependencyRequest[]>;
  /** The connections the chat's agent asked for that wait, oldest first. */
  connectionRequests: (chatId: string) => Promise<ChatConnectionRequest[]>;
  /**
   * Grants the chat's request `id` as it was asked for, in this chat
   * alone: only for the person's own personal connection, while it is
   * connected and offered. Audited; the agent is told.
   */
  grantConnection: (chatId: string, id: string) => Promise<void>;
  /**
   * Denies (or, for a shared connection, withdraws) the chat's request
   * `id`. Audited; the agent is told.
   */
  denyConnection: (chatId: string, id: string) => Promise<void>;
  /**
   * Follows the chat: `onUpdate` gets the messages after the one with ID
   * `after` (all of them for `null`) and what the agent is writing, then
   * every change. Watching again with the last message seen resumes after
   * a lost connection; with `null`, after a reload.
   */
  watch: (
    chatId: string,
    after: number | null,
    onUpdate: (update: ChatUpdate) => void
  ) => Promise<ChatSubscriptionApi>;
}
