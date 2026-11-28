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
}

/** One of a chat's files: a file's text, or how many parts a picture's bytes are in. */
export interface ExportedFile {
  id: string;
  messageId: number | null;
  name: string;
  type: ChatFileType | ChatPictureType;
  createdAt: number;
  /** A file's text; `null` for a picture, whose bytes are in parts. */
  text: string | null;
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

/** What a chat read and ran: its sources, its runs' sources and records, its calls, its trace. */
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
}
