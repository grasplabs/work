import { z } from "zod";

import type { ChatSavedMemory } from "./brain-memories.ts";
import type { DependencyRequest } from "./dependencies.ts";
import type { AppId } from "./ids.ts";
import type { ModelEffort, ModelEfforts, ModelErrorCode } from "./models.ts";
import type { PageBundle } from "./pages.ts";
import type { Role } from "./roles.ts";
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
/** The longest a chat's name may be. */
/**
 * The kinds of thing a question may be about: the page it is asked on
 * (the web's chat-subject.ts), as an App's workspace is about the App and
 * a workflow's page about the workflow.
 */
export const chatSubjectKinds = ["app", "workflow"] as const;
export type ChatSubjectKind = (typeof chatSubjectKinds)[number];

/** What a question is about: one thing of a kind, by its ID. */
export const chatSubjectSchema = z.strictObject({
  kind: z.enum(chatSubjectKinds),
  id: z.string().min(1).max(256),
});
export type ChatSubject = z.infer<typeof chatSubjectSchema>;

/**
 * The kinds of thing a question may mention: what the person picks with
 * `@` in the composer, an App, a workflow or a member of the organization.
 */
export const chatMentionKinds = ["app", "workflow", "person"] as const;
export type ChatMentionKind = (typeof chatMentionKinds)[number];

/** One thing a question mentions: of a kind, by its ID (a person's user ID). */
export const chatMentionSchema = z.strictObject({
  kind: z.enum(chatMentionKinds),
  id: z.string().min(1).max(256),
});
export type ChatMention = z.infer<typeof chatMentionSchema>;

/**
 * A member of the organization a question can mention (`ChatsApi.people`):
 * by name and user ID, and by role for the organization's admins alone,
 * whose member list shows it.
 */
export interface MentionablePerson {
  id: string;
  name: string;
  role?: Role;
}

/** Most things one question mentions. */
export const chatMentionsMax = 20;

/** A question's mentions: at most {@link chatMentionsMax}, each once. */
export const chatMentionsSchema = z
  .array(chatMentionSchema)
  .max(chatMentionsMax)
  .refine(
    (mentions) =>
      new Set(mentions.map(({ kind, id }) => `${kind}:${id}`)).size ===
      mentions.length,
    { message: "Each mention once" }
  );

export const chatTitleMaxLength = 200;
export const chatTitleSchema = z.string().trim().min(1).max(chatTitleMaxLength);

/**
 * One of the company's agents as a person who may talk to it sees it:
 * enough to pick it and to show who answers, never its instructions.
 */
export interface ChatAgent {
  id: string;
  /** What people call it. */
  name: string;
  /** The figure it is drawn with. */
  face: string;
  /** One line on what it is for. */
  job: string;
  /**
   * The model its turns use, whichever the question names: one an admin
   * gave it that the organization still has. Null for an agent that
   * answers with the model its asker picks.
   */
  model: string | null;
}

/** A chat in the person's list. */
export interface ChatSummary {
  id: string;
  title: string;
  /** The agent that answers in it (`ChatsApi.agents`), for good. */
  agentId: string;
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
  /** What "Make something" started it to make, for good; null for any other chat. */
  make: ChatMake | null;
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
 * What a chat's agent worked on (`ChatsApi.worked`): an App whose draft
 * it wrote, when it last did, and in which code step or tool call
 * (`ChatCode.callId`, `ChatToolCall.callId`), where the chat's thread shows
 * it. Shaped to name a workflow too, once workflows have drafts.
 */
export interface ChatWork {
  kind: "app";
  id: string;
  /** When the chat's agent last wrote it (ISO 8601). */
  updatedAt: string;
  callId: string | null;
}

/**
 * The revision a preview of an undo point of an App's draft carries
 * (`AppDraftsApi.preview` with `point`): no draft
 * is ever at it (a draft starts at 0, before its first write), so
 * every call of that preview (function, query, stream) is refused, the
 * latest version's too, and nothing it reports is kept. Read-only by
 * construction.
 */
export const readOnlyRevision = -1;

/**
 * The build a frame of a draft's preview shows, which its reports name and
 * its updates are asked from: the draft at its revision
 * (`readOnlyRevision` for an undo point opened read-only), or a
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
 * A page of an App's draft, ready for a frame, as
 * `PageBundle` is for a running App (`AppDraftsApi.preview`): at the draft's
 * revision instead of a version, with the names of the draft's pages.
 */
export interface PreviewBundle extends Omit<PageBundle, "version" | "lease"> {
  /**
   * The draft's revision it was opened at; `readOnlyRevision` for an
   * undo point or a version opened read-only. A frame that takes updates
   * names what its `refresh` shows (`shownAt`) in its reports.
   */
  revision: number;
  /**
   * Core's lease for the builder on the App's draft, which the frame's
   * calls and live queries carry on the path every page calls on, as a
   * running App's page carries its own: they run on the draft as it is
   * then, as the builder, on the preview's test data, shared by everyone
   * who builds the App, with no resources. Only for the draft as it is
   * now; one opened read-only has none, and calls nothing.
   */
  lease?: string;
  /**
   * The pages' modules, as the frame opened them: what later updates
   * are measured against (`PreviewUpdate`). Only for the draft as it is
   * now; an undo point opened read-only never updates.
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
 * An App's draft's pages at one revision, for the preview's frame to
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
 * What an open frame of a draft's preview shows as it asks for an update
 * (`AppDraftsApi.previewUpdate`): the App's version it shows, when it shows
 * one rather than the draft's changes.
 */
export const previewShownSchema = z.strictObject({
  appVersion: z.int().positive().optional(),
});

/** What an open frame of a draft's preview shows (`previewShownSchema`). */
export type PreviewShown = z.infer<typeof previewShownSchema>;

/**
 * What `AppDraftsApi.previewUpdate` answers an open frame: a build of its
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
 * A problem a preview of a draft reported (`AppDraftsApi.previewReport`), or
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
  "renameTable",
  "setAccess",
  "addIndex",
  "addPermission",
  "removeTable",
  "removeField",
  "removeIndex",
  "removePermission",
  "bindWorkflow",
  "moveField",
  "renameFunction",
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
 * How much the chat's agent may ask at once (`askQuestions`): a few short
 * questions, each with a few options, plain text, one line each. The
 * person can always answer in their own words, which the page offers
 * itself, or type instead.
 */
export const chatAskLimits = {
  questions: 4,
  optionsMin: 2,
  options: 4,
  headerLength: 24,
  questionLength: 300,
  labelLength: 80,
  descriptionLength: 160,
} as const;

/** Text starting and ending with something other than space. */
const unpadded = /^\S(?:.*\S)?$/su;

/**
 * What a question or an option never holds: controls (line breaks among
 * them), invisible formatting (bidi overrides, zero-width characters) and
 * the line and paragraph separators, so it shows as the one line it reads
 * as, and can't pass for something the page itself shows.
 */
const notInAskLine = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * One line of plain text, as everything asked is: taken as written or
 * refused, never trimmed.
 */
const askLine = (max: number) =>
  z
    .string()
    .max(max)
    .regex(unpadded)
    .refine((line) => !notInAskLine.test(line) && line.isWellFormed(), {
      message:
        "One line of well-formed text, with no control or invisible formatting characters",
    });

/** An option to pick: a few words, and a line saying what it means. */
const askOptionSchema = z.strictObject({
  label: askLine(chatAskLimits.labelLength),
  description: askLine(chatAskLimits.descriptionLength).optional(),
});

/**
 * A question with options to pick from: one, or several (`multiple`),
 * the agent's own pick marked (`recommended`, an option's index). A short
 * `header` names what it is about.
 */
const choiceAskSchema = z
  .strictObject({
    kind: z.literal("choice"),
    header: askLine(chatAskLimits.headerLength).optional(),
    question: askLine(chatAskLimits.questionLength),
    options: z
      .array(askOptionSchema)
      .min(chatAskLimits.optionsMin)
      .max(chatAskLimits.options)
      .refine(
        (options) =>
          new Set(options.map(({ label }) => label)).size === options.length,
        { message: "A question's options all have different labels" }
      ),
    multiple: z.boolean().optional(),
    recommended: z.int().min(0).optional(),
  })
  .refine(
    ({ options, recommended }) =>
      recommended === undefined || recommended < options.length,
    { message: "`recommended` is the index of one of the options" }
  );

/**
 * One thing the agent asks, by its `kind`: so far a question with options.
 * Another kind (a yes or no, a few words) is a variant here and a way to
 * answer it on the page (asked-questions.tsx), nothing else.
 */
const askSchema = z.discriminatedUnion("kind", [choiceAskSchema]);
export type ChatAskItem = z.infer<typeof askSchema>;

/** What the agent asks the person at once, as it calls `askQuestions`. */
export const chatAskSchema = z.strictObject({
  questions: z.array(askSchema).min(1).max(chatAskLimits.questions),
});
export type ChatAsk = z.infer<typeof chatAskSchema>;

/**
 * Making something, in any chat: when the person asks for something new
 * (from "Make something", which starts a chat with what to make,
 * `ChatMake`, or in their own words anywhere), the agent asks at most
 * {@link chatMakeLimits.questions} questions with answers to tap, only
 * when the answer changes what gets made, then proposes a plan
 * (`proposePlan`): a page the team opens (an App), something that runs on
 * its own (a workflow), or both, each with a name and one plain sentence,
 * the connections each needs, and who gets it. Nothing new is made until
 * the person says Build it (`ChatsApi.build`).
 */
export const chatMakeLimits = {
  questions: 2,
  nameLength: 100,
  sentenceLength: 300,
  whoLength: 100,
  needs: 4,
  needNameLength: 60,
  providerLength: 100,
  blueprintLength: 256,
} as const;

/** What a plan makes: a page the team opens (an App), or what runs on its own (a workflow). */
export const chatPlanKinds = ["app", "workflow"] as const;
export type ChatPlanKind = (typeof chatPlanKinds)[number];

/**
 * What "Make something" started a chat to make, which the chat keeps
 * (`ChatsApi.create`): an App or a workflow, and the project what Build it
 * makes goes in, shared with everyone in it.
 */
export const chatMakeSchema = z.strictObject({
  kind: z.enum(chatPlanKinds),
  project: z.string().min(1).max(256).optional(),
});
export type ChatMake = z.infer<typeof chatMakeSchema>;

/**
 * A connection a part of a plan needs to do what it says (sending mail
 * through Outlook, say), as the integrations name it: who carries it out
 * (`native` connect, or `composio`), its provider (`microsoft`, a
 * toolkit's slug) and the name the person knows it by.
 */
const planNeedSchema = z.strictObject({
  source: z.enum(["native", "composio"]),
  provider: askLine(chatMakeLimits.providerLength),
  name: askLine(chatMakeLimits.needNameLength),
});
export type ChatPlanNeed = z.infer<typeof planNeedSchema>;

/**
 * One thing a plan makes: its kind, its name, one plain sentence of what
 * it does, the connections it needs, and, for an App, the blueprint it
 * starts from (`apps.blueprints.list`), if any.
 */
const planPartSchema = z
  .strictObject({
    kind: z.enum(chatPlanKinds),
    name: askLine(chatMakeLimits.nameLength),
    does: askLine(chatMakeLimits.sentenceLength),
    needs: z.array(planNeedSchema).max(chatMakeLimits.needs).optional(),
    blueprint: z.string().min(1).max(chatMakeLimits.blueprintLength).optional(),
  })
  .refine(({ kind, blueprint }) => blueprint === undefined || kind === "app", {
    message: "Only an App starts from a blueprint",
  });
export type ChatPlanPart = z.infer<typeof planPartSchema>;

/**
 * A plan, as the agent proposes it (`proposePlan`): one or two parts, at
 * most one of each kind, and who gets it, in the person's words.
 */
export const chatPlanSchema = z.strictObject({
  parts: z
    .array(planPartSchema)
    .min(1)
    .max(chatPlanKinds.length)
    .refine(
      (parts) => new Set(parts.map(({ kind }) => kind)).size === parts.length,
      { message: "A plan makes at most one App and one workflow" }
    ),
  who: askLine(chatMakeLimits.whoLength),
});
export type ChatPlan = z.infer<typeof chatPlanSchema>;

/** A plan the agent proposed: data, never commands, made only on Build it. */
export interface ChatPlanned extends ChatPlan {
  /** The call that proposed it: what Build it names (`ChatBuild.plan`). */
  callId: string;
}

/**
 * The needs of `plan` none of `connections` meets, each once: a need is
 * met by an active connection of its source and provider the person can
 * use. Build it waits until there are none (`agent.plan_needs_connection`).
 */
export const unmetNeeds = (
  plan: ChatPlan,
  connections: readonly {
    source: string;
    provider: string;
    status: string;
  }[]
): ChatPlanNeed[] => {
  const met = (need: ChatPlanNeed): boolean =>
    connections.some(
      ({ source, provider, status }) =>
        status === "active" &&
        source === need.source &&
        provider === need.provider
    );
  const unmet = new Map<string, ChatPlanNeed>();
  for (const need of plan.parts.flatMap(({ needs = [] }) => needs)) {
    if (!met(need)) {
      unmet.set(`${need.source}:${need.provider}`, need);
    }
  }
  return [...unmet.values()];
};

/** Build it, for a chat's plan (`ChatsApi.build`). */
export interface ChatBuild {
  /** The plan, by the call that proposed it (`ChatPlanned.callId`). */
  plan: string;
  /** What the person said, in their words: their message in the chat. */
  text: string;
  /** One of `ChatsApi.models()`, as a question names it. */
  model: string;
  effort?: ModelEffort;
}

/** What Build it made, each by its ID and name. */
export interface ChatBuilt {
  app?: { id: string; name: string };
  workflow?: { id: string; name: string };
}

/**
 * Questions the agent asked the person: data, never commands. An option
 * only says what the person may answer; their answer is their own next
 * message, and anything the agent then changes still waits for them to
 * confirm it in Grasp.
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
      /**
       * For the person's Build it (`ChatsApi.build`): the plan it built,
       * by its call, and what that made, which the thread shows being
       * built from here on.
       */
      built?: ChatBuilt & { plan: string };
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
      /**
       * The plan it proposed, if it ended its response proposing one
       * (`proposePlan`): shown as a card with Build it.
       */
      planned?: ChatPlanned;
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
      /**
       * A memory the agent saved for the person (`remember`, see
       * `ChatSavedMemory`), for the result of a call that saved one; none
       * for any other.
       */
      saved?: ChatSavedMemory;
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
   * Changes whenever the chat's agent writes an App's draft: read what it
   * worked on again then (`ChatsApi.worked`). Only a count, from when the
   * object last started.
   */
  worked: number;
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
  /**
   * What it is about: the page it was asked on, as an App's workspace is
   * about the App. Core tells the agent, by name, with the question, so
   * "this" and "it" mean that; only one the person may change.
   */
  subject?: ChatSubject;
  /**
   * What the person picked with `@` as they wrote it, at most
   * {@link chatMentionsMax}, each once: core tells the agent each by name
   * and ID with the question, so it knows which one they mean rather than
   * guessing from a name. Each must be one the person may see: an App or
   * workflow they have a role in, a member of the organization.
   */
  mentions?: ChatMention[];
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
  /**
   * The company's agents the person may talk to here, the first one
   * first: the ones that are on and have them in their audience. An agent
   * outside it is never listed.
   */
  agents: () => Promise<ChatAgent[]>;
  /**
   * Makes a chat with the agent `agentId`, one of `agents()`, or with
   * the company's first agent when none is named. An agent the person may
   * not talk to is `agent.unknown`, as one the company doesn't have. From
   * "Make something", with what to make (`make`), which it keeps.
   */
  create: (
    title: string,
    agentId?: string,
    make?: ChatMake
  ) => Promise<ChatSummary>;
  /**
   * The person's chat for App `app`, where its agent changes the App with
   * them: the one they last used, or a new one named after the App. Only
   * for someone who builds the App, and not while it is archived.
   */
  forApp: (app: string) => Promise<ChatSummary>;
  /**
   * The organization's members, by name, that a question can mention
   * (`ChatQuestion.mentions`): whoever asks needn't be an admin.
   */
  people: () => Promise<MentionablePerson[]>;
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
   * Build it: makes what the chat's plan `build.plan` lists (an App, a
   * workflow, or both), owned by the person, in the project the chat was
   * started with (`ChatSummary.make`, shared with everyone in it), each
   * once; then asks the chat's agent, in the person's words
   * (`build.text`), to build them. Only for a builder; a plan the chat
   * doesn't hold, or built already, is refused (`agent.plan_not_found`),
   * and one whose connections aren't all there yet (`unmetNeeds`) is
   * refused (`agent.plan_needs_connection`), with nothing made.
   */
  build: (chatId: string, build: ChatBuild) => Promise<ChatBuilt>;
  /**
   * What the chat's agent worked on, the most recently written first: each
   * App whose draft it wrote (`ChatWork`).
   */
  worked: (chatId: string) => Promise<ChatWork[]>;
  /**
   * The documents the chat's answer `messageId` cites, in the order it
   * first links to them, each only while the chat's agent may still read
   * it for the person; none for a message that isn't an answer.
   */
  cited: (chatId: string, messageId: number) => Promise<ChatCitedDocument[]>;
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
