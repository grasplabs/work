import type {
  ChatChannel,
  ChatFileType,
  ChatPictureType,
} from "@grasp-os/shared/chat";

import type { CodeRunStatus } from "./code-run-statuses.ts";
import type { OutsideTextNote } from "./outside-text.ts";

// What a person's Workspace hands a chat's own object (`ChatSession`) for
// it to take the chat over, read only (workspace.ts `export*`): its
// messages a page at a time, what it is, its files, its held App writes,
// and what it read and ran. Times are milliseconds, so each crosses the
// object's RPC as plain data.

/** What a chat is: whose, where it came through, its agent and its marks. */
export interface ExportedChat {
  personId: string;
  via: ChatChannel;
  agentId: string;
  thread: string | null;
  restricted: boolean;
  privateRead: boolean;
}

/** One message of a chat, as its Workspace keeps it. */
export interface ExportedMessage {
  id: number;
  message: string;
  createdAt: number;
  thinkingMs: number | null;
  built: string | null;
  agentId: string | null;
  rating: "up" | "down" | null;
  ratingReason: string | null;
  requestKey: string | null;
}

/** A page of a chat's messages, with what it is and where its copy stands. */
export interface ExportedPage {
  facts: ExportedChat;
  /** The last pi entry its messages hold; `null` for none. */
  through: number | null;
  page: ExportedMessage[];
  /** The ID the next page goes on after; `null` once this page is the last. */
  next: number | null;
}

/** One of a chat's files, its bytes handed over in parts (`exportFilePart`). */
export interface ExportedFile {
  id: string;
  messageId: number | null;
  name: string;
  type: ChatFileType | ChatPictureType;
  createdAt: number;
  /** Its size as it was attached: a file's text, all that is kept of it, may be smaller. */
  bytes: number;
  /** How many parts its bytes are in: a picture's, or one, a file's text. */
  parts: number;
}

/** One App write held in a chat for its person. */
export interface ExportedHeldCall {
  id: string;
  agentId: string;
  personId: string;
  appId: string;
  function: string;
  kind: string;
  request: string | null;
  requestHash: string;
  heldAt: number;
  status: "waiting" | "confirmed" | "declined" | "lapsed";
}

/**
 * What a chat read and ran: its sources, its runs' sources and records,
 * its calls, its trace; and which of its calls a press took.
 */
export interface ExportedTurnState {
  sources: { sourceId: string; createdAt: number }[];
  runSources: { runId: string; sourceId: string; withheldAt: number | null }[];
  codeRuns: {
    id: string;
    toolCallId: string;
    turnId: string | null;
    sourceHash: string;
    sourceChars: number;
    agent: string;
    compatibilityDate: string;
    runtime: "cloudflare" | "workerd";
    cpuLimit: "enforced" | "cpu_limit_unsupported";
    status: "running" | CodeRunStatus;
    startedAt: number;
    endedAt: number | null;
    outsideText: OutsideTextNote[] | null;
  }[];
  toolEvents: {
    id: number;
    callId: string;
    event: string;
    createdAt: number;
  }[];
  trace: string[];
  /**
   * The calls a person's press took (chats-rpc.ts: Build it a plan, Make
   * it a drafted agent, Change it a change), by tool, so none is taken twice.
   */
  taken: Record<"proposePlan" | "draftAgent" | "draftAgentChange", string[]>;
  /** The agent Make it made of a draft whose instructions it couldn't save, by the draft's call. */
  draftMade: Record<string, string>;
}
