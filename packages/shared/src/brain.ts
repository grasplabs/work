/**
 * What the company brain is built from: everything steps 1 and 2 of the
 * Playbook collected, as records. The prototype read these from its mock
 * workspace; here they are what core assembles (`brain.read`, core's
 * brain-rpc.ts) and the web app's brain is built from. Only the fields the
 * brain reads are here, as the prototype named them.
 */

import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { documentIdSchema } from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";
import type { DocumentType } from "./knowledge.ts";

/** The standard business processes a workflow belongs to. */
export type ProcessId = "o2c" | "i2r" | "p2p" | "r2c" | "r2r" | "h2r";

export type WorkflowStatus = "drawn" | "designed" | "testing" | "running";

/**
 * One value of something that changes over time, with where and when it
 * came in. A new value is added, never written over the old one: the newest
 * counts, the older ones are its history.
 */
export interface Dated {
  sourceId: string;
  /** ISO date it came in. */
  date: string;
}

export interface Company {
  name: string;
  sector: string;
  people: number;
}

/** One answer the board gave on the Vision page, from one source. */
export interface Answer extends Dated {
  text: string;
}

/** Step 1: the Vision page, in leadership's own words. */
export interface Vision {
  ambition: string;
  whyNow: string;
  /** The teams to interview in step 2. */
  inviteTeamIds: string[];
  /** The monthly budget for AI, oldest first; empty while nobody answered. */
  budget: Answer[];
  /** Who approves a new tool, oldest first; empty while nobody answered. */
  toolApproval: Answer[];
  sourceId: string;
  version: number;
  confirmedBy?: string;
  confirmedAt?: string;
}

/** One wording of a goal, from one source. */
export interface GoalVersion extends Dated {
  title: string;
  howWeNotice: string;
}

/** A board goal from the vision. Adjusting it adds a version; the newest counts. */
export interface Goal {
  id: string;
  /** Oldest first; the first is where it was set. Never empty. */
  versions: GoalVersion[];
}

/** A role in a team, from the directory: how many people hold it, never who. */
export interface Role {
  name: string;
  people: number | null;
}

/** The one person per team interviewed in step 2, kept as a role. */
export interface Stakeholder extends Dated {
  role: string;
  /** When they were invited into Grasp; empty until they are. */
  invitedAt?: string;
}

/** What one directory import or client list said about a team's size and roles. */
export interface TeamCount extends Dated {
  people: number | null;
  /** Empty when the source lists no roles. */
  roles?: Role[];
}

export interface Team {
  id: string;
  name: string;
  /** Where the team was first found. */
  sourceId: string;
  /** Size and roles per import, oldest first; the newest counts. */
  counts: TeamCount[];
  /** Who is interviewed for this team, oldest first; the newest counts. */
  stakeholders: Stakeholder[];
}

/** Whether a tool is an AI tool or has AI built in. */
export type AiKind = "tool" | "builtIn" | "none";

export interface Tool {
  id: string;
  name: string;
  teamIds: string[];
  sourceId: string;
  /** As the team said it; a sighting in the landscape wins. Empty is unknown. */
  ai?: AiKind;
}

/** One turn, answer or passage in a transcript. */
export interface TranscriptTurn {
  /** Where it is, in the transcript's unit: "12:26", or the answer or passage number. */
  at: string;
  /** Who spoke or answered, as a role, or the section a passage is in. */
  speaker: string;
  text: string;
}

/** A stretch of a transcript about one topic, from where it starts until the next one. */
export interface TranscriptChapter {
  title: string;
  /** Where it starts, in the transcript's unit. */
  at: string;
}

/** A source's own words in order, and the topics it moved through. */
export interface Transcript {
  /** What `at` counts: a minute ("12:26") or a passage ("3"). A minute when left out. */
  unit?: "minute" | "passage";
  turns: TranscriptTurn[];
  chapters: TranscriptChapter[];
}

/** One interview, chat, document or import: where a fact came from. */
export interface Source {
  id: string;
  kind: "interview" | "chat" | "document" | "import" | "runLog";
  title: string;
  /** ISO date. */
  date: string;
  /** Who gave it, as a role. */
  who?: string;
  /** How it was collected: "Live, 45 minutes", "Chat link", "OAuth". */
  how?: string;
  /** The Playbook step that collected it. */
  step?: 1 | 2 | 3 | 4 | 5 | 6;
  /** For an import from a connection: what it read. */
  connection?: "directory" | "signIn" | "pulse";
  /** For an interview: a team's stakeholder, or any other employee. */
  interviewee?: "stakeholder" | "employee";
  /** For a document: the policy it became in the policy manager. */
  policyId?: string;
  /** The teams this source speaks for: what makes a team interviewed. */
  teamIds?: string[];
  /** An interview written up as an article, paragraph by paragraph. */
  article?: string[];
  /** The whole conversation, word for word; its statements are highlights in it. */
  transcript?: Transcript;
}

/** What a statement is about. */
export type StatementKind =
  | "goal"
  | "blocker"
  | "timeSink"
  | "handover"
  | "tool"
  | "rule"
  | "wish";

/** One claim from one source, in the words it was said. */
export interface Statement {
  id: string;
  kind: StatementKind;
  text: string;
  sourceId: string;
  teamIds: string[];
  toolIds: string[];
  /** The candidate process it is about, if any. */
  candidateId?: string;
}

/** A process that might be worth turning into a workflow. */
export interface Candidate {
  id: string;
  name: string;
  /** The drawn workflow, once step 3 has drawn it. */
  workflowId?: string;
}

/** Something not known yet, with who can answer it. */
export interface Gap {
  id: string;
  question: string;
  /** Role that can answer it. */
  owner: string;
  /** Where it was noticed. */
  sourceId: string;
  /** Brain note ids, statement ids or workflow ids this gap is about. */
  about: string[];
  closedAt?: string;
  /** The answer in the words of who gave it, and who that was. */
  answer?: string;
  answeredBy?: string;
}

/** One step of a drawn workflow, as far as the brain reads it. */
export interface Step {
  /** The tools it uses, comma-separated as the client names them. */
  tool?: string;
  /** Not every item goes the same way after this step: the paths, each with its own steps. */
  split?: { paths: { steps: Step[] }[] };
}

/** A version of a workflow: its steps and who confirmed it. */
export interface Version {
  steps: Step[];
  confirmedBy?: string;
  confirmedAt?: string;
}

/** A workflow on the Workflows page, as far as the brain reads it. */
export interface Workflow {
  id: string;
  name: string;
  /** The main team. */
  teamId?: string;
  /** The board goal it serves. */
  goalId?: string;
  processId?: ProcessId;
  status: WorkflowStatus;
  baseline: Version;
  target?: Version;
  /** Measured periods, the first from when it went live. */
  results?: { period: { from: string } }[];
}

/** A connector Grasp has, or could have, for a system. */
export interface Connection {
  name: string;
  /** A file name in /logos, or none. */
  logo?: string;
  status: "connected" | "available";
  via: "direct" | "composio";
  /** Tool names in workflow steps that this connection covers. */
  matches: string[];
}

/** How Grasp knows an application is in use. */
export type SeenThrough = "microsoftSso" | "googleSso" | "pulse";

/** One application in the client's landscape. */
export interface LandscapeApp {
  id: string;
  name: string;
  vendor: string;
  category: string;
  /** A file name in /logos, or none. */
  logo?: string;
  /** Its logo as the Landscape table shows it, as a full path. */
  logoSrc?: string;
  ai: AiKind;
  /** People seen using it in the last 30 days. */
  people: number;
  seenThrough: SeenThrough[];
  /** The team that owns it, or null when nobody does. */
  owner: string | null;
  /** Tool names that mean this application. */
  matches: string[];
  /** The OAuth permissions people granted it, in plain words. Empty when seen only by Pulse. */
  permissions: string[];
}

/** A policy the company uploaded to the policy manager. */
export interface PolicyDocument {
  id: string;
  title: string;
  /** ISO minute. */
  uploadedAt: string;
  status: "reading" | "review" | "published" | "failed";
  /** What the policy covers, in a sentence or two. */
  summary?: string;
  /** The rules proposed from it, each with the passage it comes from. */
  proposals: { excerpt: string; decision: "open" | "accepted" | "rejected" }[];
  /** Requirements no rule can check yet, each with its passage. */
  unchecked: { excerpt: string }[];
  /** ISO minute. */
  publishedAt?: string;
}

/** Everything the brain is built from. */
export interface Workspace {
  company: Company;
  vision: Vision;
  goals: Goal[];
  teams: Team[];
  tools: Tool[];
  sources: Source[];
  statements: Statement[];
  candidates: Candidate[];
  gaps: Gap[];
  workflows: Workflow[];
  connections: Connection[];
  landscape: LandscapeApp[];
  policies: PolicyDocument[];
}

/**
 * The brain's workspace, assembled by core from what it holds: the
 * onboarding, the Playbook's records and the connections. Each part as the
 * person may read it; what core has no source for yet comes back empty.
 */
export interface BrainApi {
  read: () => Promise<Workspace>;
  /**
   * What changed in the brain since a moment (`brain.changes`), newest
   * first, a page at a time, as the person may read it.
   */
  changes: (options: BrainChangesOptions) => Promise<BrainChangePage>;
  /**
   * Every note in the brain with its links (`brain.notes`), a page at a
   * time, as the person may read them.
   */
  notes: (options?: BrainNotesOptions) => Promise<BrainNotePage>;
}

/** Why a brain call was refused. */
export const brainErrors = defineErrorFamily({
  "brain.invalid": "That isn't a valid moment, page or page size.",
});

/**
 * Most changes one page holds: its documents, and as many collections,
 * fit in the audit event that records the read (`auditProvenanceMaxItems`).
 */
export const brainChangesMaxLimit = 50;

/** How far back the changes go, whatever moment is asked about: 90 days. */
export const brainChangesMaxAgeMs = 90 * 24 * 60 * 60 * 1000;

/** What a call for the brain's changes asks for. */
export const brainChangesOptionsSchema = z.strictObject({
  /**
   * Changes after this moment (ISO 8601): at most `brainChangesMaxAgeMs`
   * ago, an earlier one taken as that.
   */
  since: z.iso.datetime({ offset: true }),
  /** Where the page before ended (`BrainChangePage.next`); none for the first. */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.int().min(1).max(brainChangesMaxLimit).default(50),
});
export type BrainChangesOptions = z.input<typeof brainChangesOptionsSchema>;

/**
 * One change in the brain: what core records today. A union on `kind`, so
 * goals, questions and workflow suggestions join it once core keeps them.
 */
export type BrainChange =
  | {
      /** A Knowledge document added or changed: what a listing shows of it, never its text. */
      kind: "document";
      /** ISO 8601: when it was last changed. */
      at: string;
      /** Added after the moment asked about, or only changed since. */
      change: "added" | "changed";
      document: {
        id: DocumentId;
        collectionId: CollectionId;
        path: string;
        title: string;
        type: DocumentType;
      };
    }
  | {
      /**
       * A source the onboarding gave the brain, as `brain.read`'s sources
       * name it (the kickoff, the staff list): for admins, who read them.
       */
      kind: "source";
      /** ISO 8601: when it came in, or was last saved. */
      at: string;
      source: { id: string; title: string };
    };

/** A page of the brain's changes, newest first. */
export interface BrainChangePage {
  changes: BrainChange[];
  /** Where the next page starts; null when this is the last. */
  next: string | null;
}

/**
 * Most notes one page holds: they, and as many collections, fit in the
 * audit event that records the read (`auditProvenanceMaxItems`).
 */
export const brainNotesMaxLimit = 50;

/** What a call for the brain's notes asks for. */
export const brainNotesOptionsSchema = z
  .strictObject({
    /** Where the page before ended (`BrainNotePage.next`); none for the first. */
    cursor: documentIdSchema.optional(),
    limit: z.int().min(1).max(brainNotesMaxLimit).default(brainNotesMaxLimit),
  })
  .default({ limit: brainNotesMaxLimit });
export type BrainNotesOptions = z.input<typeof brainNotesOptionsSchema>;

/** A link in a note, to the path it names in the note's collection. */
export interface BrainNoteLink {
  path: string;
  label: string | null;
  /** The document at that path, when the person may read it; null otherwise. */
  documentId: DocumentId | null;
}

/**
 * One note of the brain: what core records today, a Knowledge document,
 * what a listing shows of it (never its text) and its links. A union on
 * `kind` once core keeps other records.
 */
export interface BrainNote {
  kind: "document";
  id: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  type: DocumentType;
  /** ISO 8601. */
  updatedAt: string;
  links: BrainNoteLink[];
}

/** A page of the brain's notes. */
export interface BrainNotePage {
  notes: BrainNote[];
  /** Where the next page starts; null when this is the last. */
  next: string | null;
}
