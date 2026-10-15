import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural, select, t } from "@lingui/core/macro";

import { formatDay, formatList, formatNumber } from "../format.ts";
import { changes, latest } from "./history.ts";
import type {
  AiKind,
  Answer,
  Candidate,
  Gap,
  Goal,
  LandscapeApp,
  PolicyDocument,
  ProcessId,
  Role,
  SeenThrough,
  Source,
  Stakeholder,
  Statement,
  StatementKind,
  Step,
  Team,
  TeamCount,
  Tool,
  Workflow,
  WorkflowStatus,
  Workspace,
} from "./workspace.ts";

/**
 * The company brain: everything steps 1 and 2 collected, as notes in folders with links between
 * them, like a vault in Obsidian. Nothing here is typed by hand: folders, tags, links, summaries,
 * timelines and patterns all follow from the records, so they stay true when the records change.
 *
 * The brain processes and shows information; it never ranks or scores. Choosing what to work on
 * first happens later in the platform, steered by our consultants.
 *
 * Workflows are not notes. From step 3 on they live on the Workflows page; notes point there, and
 * a workflow points back at the candidate it came from.
 *
 * The brain's own words (kinds, labels, summaries, timelines, patterns) are in the reader's
 * language, read when the brain is built, never at module load; the client's data stays as
 * written. Ids, tags and the folder ids in `Note.path` stay English, so links, open folders and
 * exports work the same in every language.
 */

export type NoteKind =
  | "company"
  | "vision"
  | "goal"
  | "channel"
  | "team"
  | "tool"
  | "app"
  | "statement"
  | "candidate"
  | "gap"
  | "source";

/** The colour groups of the graph. One per top-level idea, not per kind. */
export type Group =
  | "company"
  | "vision"
  | "teams"
  | "tools"
  | "statements"
  | "candidates"
  | "gaps"
  | "sources";

/** The Playbook step that wrote a note. 0 is the company itself. */
export type NoteStep = 0 | 1 | 2;

/** Something a note refers to: another note, a workflow on the Workflows page, or plain words. */
export interface NoteRef {
  label: string;
  /** The note it points to. */
  to?: string;
  /** The workflow it points to, outside the brain on the Workflows page. */
  workflowId?: string;
  /** The policy it points to, outside the brain in the policy manager. */
  policyId?: string;
  /** The statement it points at, highlighted in the source `to`. */
  statement?: string;
}

/** One short point at the top of a note: a label and what it says. */
export interface NotePoint {
  label: string;
  refs: NoteRef[];
}

/** A statement quoted on a timeline. */
export interface NoteQuote {
  statementId: string;
  /** The source the statement was said in, where it is highlighted. */
  sourceId: string;
  text: string;
  /** The statement this note is. */
  own: boolean;
}

/** Something that happened to what a note is about, on the day it happened. */
export interface NoteEvent {
  /** ISO date. */
  date: string;
  title: string;
  detail?: string;
  to?: string;
  workflowId?: string;
  quotes: NoteQuote[];
  /** This note itself came in here. */
  own: boolean;
}

/** A group in the side panel. */
export interface NoteLinks {
  title: string;
  refs: NoteRef[];
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  /**
   * Folders from the vault root down, as English ids, e.g. ["2 Inventory", "Statements", "Blockers"].
   * `folderName` gives each its name in the reader's language.
   */
  path: string[];
  step: NoteStep;
  /** Plain English ids such as "time-sink" or "not-interviewed", for search and the export. */
  tags: string[];
  /** One sentence that says what this is. */
  summary: string;
  /** A few short points under the summary. */
  points: NotePoint[];
  /** Dated events, oldest first: when each fact about this note came in. */
  timeline: NoteEvent[];
  /** What has not happened yet, in order. */
  open: string[];
  /** Written text, for a source that carries it: an interview written up as an article. */
  article?: string[];
  /** The side panel: sources first, then the notes and workflows it connects to. */
  linked: NoteLinks[];
  /** Statements that name this note in their words but are not about it, each where it was said. */
  mentions: NoteQuote[];
  /** Notes this note points to. */
  links: string[];
  /** Notes that point here. */
  backlinks: string[];
  /** A tool's or application's logo as a full path: the Landscape table's, else its connector's. */
  logoSrc?: string;
  /** The standard business processes of the workflows this note leads to, in list order. */
  processIds: ProcessId[];
  /**
   * The statements about this note, oldest source first: said by its team, naming its tool, about
   * its process, said in it as a source, or asked about in it as a gap. Statements are not notes;
   * each is a highlight in the source it was said in.
   */
  statementIds: string[];
}

export interface Brain {
  notes: Note[];
  /** Each connection once, as [from, to]. */
  edges: [string, string][];
}

/** What each kind of note is called. Render with `i18n._(...)`. */
export const kindLabel: Record<NoteKind, MessageDescriptor> = {
  company: msg`Company`,
  vision: msg`Vision`,
  goal: msg`Goal`,
  channel: msg({
    message: "Way of collecting",
    comment:
      "A folder of sources: conversations, Pulse, documents or connections",
  }),
  team: msg`Team`,
  tool: msg`Tool`,
  app: msg`Application`,
  statement: msg`Statement`,
  candidate: msg({
    message: "Workflow",
    context: "a kind of note in the brain: work worth turning into a workflow",
  }),
  gap: msg`Gap`,
  source: msg`Source`,
};

export const groupOf: Record<NoteKind, Group> = {
  company: "company",
  vision: "vision",
  goal: "vision",
  channel: "sources",
  team: "teams",
  tool: "tools",
  app: "tools",
  statement: "statements",
  candidate: "candidates",
  gap: "gaps",
  source: "sources",
};

/** What each group of the graph is called. Render with `i18n._(...)`. */
export const groupLabel: Record<Group, MessageDescriptor> = {
  company: msg`Company`,
  vision: msg`Vision`,
  teams: msg`Teams`,
  tools: msg`Tools`,
  statements: msg`Statements`,
  candidates: msg({
    message: "Workflows",
    context: "a group of notes in the brain: work worth turning into workflows",
  }),
  gaps: msg`Gaps`,
  sources: msg`Sources`,
};

/** What each kind of statement is called. Render with `i18n._(...)`. */
export const statementKindLabel: Record<StatementKind, MessageDescriptor> = {
  goal: msg`Goal`,
  blocker: msg`Blocker`,
  timeSink: msg`Time waster`,
  handover: msg`Handover`,
  tool: msg`Tool`,
  rule: msg`Rule`,
  wish: msg`Wish`,
};

/** A workflow's status, on a note's timeline. */
const statusLabel: Record<WorkflowStatus, MessageDescriptor> = {
  drawn: msg({ message: "Drawn", context: "workflow status" }),
  designed: msg({ message: "Designed", context: "workflow status" }),
  testing: msg({ message: "Testing", context: "workflow status" }),
  running: msg({ message: "Running", context: "workflow status" }),
};

/**
 * Whether an optional text says something: given and not empty. The
 * prototype tested these by truthiness; this keeps that, empty included.
 */
export const given = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

/** The order in which a count lists the kinds that were said equally often. */
const saidOrder: StatementKind[] = [
  "blocker",
  "timeSink",
  "handover",
  "tool",
  "rule",
  "wish",
  "goal",
];

/** How many of one kind were said, in words: "3 time wasters". */
const saidCount = (kind: StatementKind, count: number): string => {
  switch (kind) {
    case "blocker": {
      return plural(count, { one: "# blocker", other: "# blockers" });
    }
    case "timeSink": {
      return plural(count, { one: "# time waster", other: "# time wasters" });
    }
    case "handover": {
      return plural(count, { one: "# handover", other: "# handovers" });
    }
    case "tool": {
      return plural(count, {
        one: "# remark on tools",
        other: "# remarks on tools",
      });
    }
    case "rule": {
      return plural(count, { one: "# rule", other: "# rules" });
    }
    case "wish": {
      return plural(count, { one: "# wish", other: "# wishes" });
    }
    case "goal": {
      return plural(count, { one: "# goal", other: "# goals" });
    }
    default: {
      return kind satisfies never;
    }
  }
};

/**
 * The folders under Sources, one per way we collect, in this order: conversations (the vision
 * talk and every interview, by voice or chat), Pulse, the documents the client uploads, and the
 * connections (the directory, sign-in). As English ids.
 */
const sourceFolders = [
  "Conversations",
  "Pulse",
  "Documents",
  "Connections",
  "Run logs",
] as const;

type SourceFolder = (typeof sourceFolders)[number];

/** The source folders that are a page of their own: all but the run logs. */
type ChannelFolder = Exclude<SourceFolder, "Run logs">;

const isChannelFolder = (folder: SourceFolder): folder is ChannelFolder =>
  folder !== "Run logs";

/**
 * Within Conversations every conversation sits in a folder, so none hides below an open one: the
 * board, a team's stakeholder and the other employees (they get different questions), and chats
 * with a Grasp agent.
 */
const conversationFolder = (source: Source): string[] => {
  if (source.interviewee === "stakeholder") {
    return ["Stakeholder interviews"];
  }
  if (source.interviewee === "employee") {
    return ["Employee interviews"];
  }
  if (source.kind === "chat") {
    return ["Chats with Grasp"];
  }
  if (source.kind === "interview") {
    return ["With the board"];
  }
  return [];
};

/** Where a source is filed: Pulse as its own folder, the rest by what kind of source it is. */
const sourceFolderOf = (source: Source): SourceFolder => {
  if (source.connection === "pulse") {
    return "Pulse";
  }
  switch (source.kind) {
    case "interview":
    case "chat": {
      return "Conversations";
    }
    case "document": {
      return "Documents";
    }
    case "import": {
      return "Connections";
    }
    case "runLog": {
      return "Run logs";
    }
    default: {
      return source.kind satisfies never;
    }
  }
};

/**
 * Folder names in the reader's language. `Note.path` keeps the English names as ids, so folder
 * keys and the folders that open at the start stay the same in every language.
 */
const folderLabel: Record<string, MessageDescriptor> = {
  "1 Vision": msg`1 Vision`,
  Goals: msg`Goals`,
  "2 Inventory": msg`2 Inventory`,
  Teams: msg`Teams`,
  Tools: msg`Tools`,
  Mentioned: msg({
    message: "Mentioned",
    context: "folder of the tools named in interviews",
  }),
  "Seen, never mentioned": msg({
    message: "Seen, never mentioned",
    comment: "Folder of the applications seen in use that no team named",
  }),
  Statements: msg`Statements`,
  Blockers: msg`Blockers`,
  "Time sinks": msg`Time wasters`,
  Handovers: msg`Handovers`,
  "About tools": msg({
    message: "About tools",
    comment: "Folder of the statements about tools",
  }),
  Rules: msg`Rules`,
  Wishes: msg`Wishes`,
  Candidates: msg({
    message: "Workflows",
    context: "a group of notes in the brain: work worth turning into workflows",
  }),
  Gaps: msg`Gaps`,
  Sources: msg`Sources`,
  Conversations: msg({
    message: "Conversations",
    comment:
      "Folder of the sources that are conversations: the vision talk and the interviews by voice or chat",
  }),
  Pulse: msg({ message: "Pulse", comment: "Product name: keep it as it is" }),
  "With the board": msg({
    message: "With the board",
    comment:
      "Folder of the conversations with the board: the vision conversation and its check-ins",
  }),
  "Stakeholder interviews": msg`Stakeholder interviews`,
  "Employee interviews": msg`Employee interviews`,
  "Chats with Grasp": msg({
    message: "Chats with Grasp",
    comment: "Folder of the chats people had with a Grasp agent",
  }),
  Documents: msg`Documents`,
  Connections: msg`Connections`,
  "Run logs": msg`Run logs`,
};

/** A folder's name in the reader's language, from its id in `Note.path`. */
export const folderName = (id: string): string => {
  const label = Object.hasOwn(folderLabel, id) ? folderLabel[id] : undefined;
  return label ? i18n._(label) : id;
};

/** The page of a source folder, like the Vision page is the 1 Vision folder. */
const channelId = (folder: string): string => `sources-${folder.toLowerCase()}`;

/** What each way of collecting adds, one sentence at the top of its page. */
const channelSummary: Record<ChannelFolder, MessageDescriptor> = {
  Conversations: msg`The vision conversation, the interviews with stakeholders and employees by voice or chat, and chats with a Grasp agent. Adds how each team works, in their own words.`,
  Pulse: msg`Pulse on company devices. Adds which applications, MCP servers and skills are actually used, AI tools and shadow IT included.`,
  Documents: msg`What the client shares, and our own desk research. Adds policies, procedures and process examples.`,
  Connections: msg`The directory and sign-in through Microsoft or Google. Adds teams and roles, and the applications people sign in to with their permissions.`,
};

/** "Head of compliance" as "head of compliance"; "CFO" stays "CFO". */
const startsAsWord = /^[A-Z][a-z]/u;
const lowerFirst = (text: string): string =>
  startsAsWord.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** "Finance, Compliance and Service desk", joined the way the reader's language joins a list. */
const joinNames = (names: string[]): string => formatList(names);

const special = /[.*+?^${}()|[\]\\]/gu;
const escape = (text: string): string =>
  text.replaceAll(special, String.raw`\$&`);

/** Whether a tool has AI, and who says so: "An AI tool, as Grasp sees it". */
const aiText = (ai: AiKind | undefined, seenByGrasp: boolean): string => {
  if (!ai) {
    return t({ message: "Unknown", context: "whether a tool has AI" });
  }
  return seenByGrasp
    ? select(ai, {
        tool: "An AI tool, as Grasp sees it",
        builtIn: "AI built in, as Grasp sees it",
        other: "No AI, as Grasp sees it",
      })
    : select(ai, {
        tool: "An AI tool, as the team said it",
        builtIn: "AI built in, as the team said it",
        other: "No AI, as the team said it",
      });
};

/** "14 people", or that the size is unknown. */
const sizeText = (count: TeamCount | undefined): string => {
  const people = count?.people;
  return people === null || people === undefined
    ? t`Team size unknown`
    : plural(people, { one: "# person", other: "# people" });
};

/** "8 people, 6 interviewed: the controller and 5 employees.", or "8 people." when nobody was interviewed yet. */
const sizeAndInterviewed = (
  people: number,
  { stakeholder, employees }: { stakeholder?: string; employees: number }
): string => {
  const team = plural(people, { one: "# person", other: "# people" });
  const total = (given(stakeholder) ? 1 : 0) + employees;
  if (total === 0) {
    return `${team}.`;
  }
  const staff = plural(employees, { one: "# employee", other: "# employees" });
  if (!given(stakeholder)) {
    const who = staff;
    return t`${team}, ${total} interviewed: ${who}.`;
  }
  const role = lowerFirst(stakeholder);
  const who = employees > 0 ? t`the ${role} and ${staff}` : t`the ${role}`;
  return t`${team}, ${total} interviewed: ${who}.`;
};

/**
 * "8 people, 6 interviewed: the controller and 5 employees. Heard in 7 conversations."
 * Who was interviewed says how the people and the conversations meet: a team is heard in more
 * conversations than it had interviews when its people spoke to Grasp later, or other teams named it.
 * The statements are left out; the team's page counts them right under it.
 */
const teamSummary = (
  count: TeamCount | undefined,
  interviewed: { stakeholder?: string; employees: number },
  conversations: number
): string => {
  const people = count?.people;
  const size =
    people === null || people === undefined
      ? t`Team size unknown.`
      : sizeAndInterviewed(people, interviewed);
  return `${size} ${plural(conversations, { one: "Heard in # conversation.", other: "Heard in # conversations." })}`;
};

/** "Service desk (14)", or "(unknown)" when the import did not count it. */
const roleText = (role: string, people: number | null): string =>
  people === null ? t`${role} (unknown)` : `${role} (${formatNumber(people)})`;

/** "Retail banking, 180 people." */
const companySummary = (sector: string, people: number): string =>
  plural(people, {
    one: `${sector}, # person.`,
    other: `${sector}, # people.`,
  });

/** The home's article, kept short so the blocks below show: what the brain holds, and its six parts. */
const howTheBrainWorks = (company: string): string[] => [
  t`Everything Grasp learned about ${company}, each fact traceable to the conversation, document or connection it came from.`,
  t`Vision holds the board’s goals, Teams how each team works, Workflows the time-consuming work that could be automated, Tools the apps in use, Gaps what is still unknown, and Sources every conversation and document, word for word.`,
];

/** What the brain holds: "5 teams, 40 statements, 6 workflows". */
const inTheBrain = (
  teams: number,
  statements: number,
  candidates: number
): string =>
  t`${plural(teams, { one: "# team", other: "# teams" })}, ${plural(statements, { one: "# statement", other: "# statements" })}, ${plural(candidates, { one: "# workflow", other: "# workflows" })}`;

/** "4 of 5 invited teams". */
const interviewedOf = (done: number, invited: number): string => {
  const interviewed = formatNumber(done);
  return plural(invited, {
    one: `Stakeholders of ${interviewed} of # invited team`,
    other: `Stakeholders of ${interviewed} of # invited teams`,
  });
};

/** "4 rules in use". */
const rulesInUse = (count: number): string =>
  plural(count, { one: "# rule in use", other: "# rules in use" });

/** "33 employees interviewed", besides the teams' stakeholders. */
const employeesInterviewed = (count: number): string =>
  plural(count, {
    one: "# employee interviewed",
    other: "# employees interviewed",
  });

/** "2 gaps". */
const stillOpen = (gaps: number): string =>
  plural(gaps, { one: "# gap", other: "# gaps" });

/** A tool Grasp has seen in use, named by some teams. */
const toolSeen = (teams: number, people: number, channels: string): string =>
  t`Named by ${plural(teams, { one: "# team", other: "# teams" })}, and seen in use by ${plural(people, { one: "# person", other: "# people" })} through ${channels}.`;

/** A tool only the teams have named. */
const toolReported = (teams: number): string =>
  plural(teams, {
    one: "Named by # team. Not seen in use yet, so its use is reported, not observed.",
    other:
      "Named by # teams. Not seen in use yet, so its use is reported, not observed.",
  });

/** An application Grasp saw in use that no team has named. */
const appUnnamed = (people: number, channels: string): string =>
  plural(people, {
    one: `# person uses it, seen through ${channels}. No team has named it yet.`,
    other: `# people use it, seen through ${channels}. No team has named it yet.`,
  });

/** How many people Grasp saw using an application. */
const peopleText = (people: number): string =>
  plural(people, { one: "# person", other: "# people" });

/** How many people Grasp saw using a tool, and under which name: "38 people, as Microsoft 365". */
const peopleAs = (people: number, app: string): string =>
  plural(people, {
    one: `# person, as ${app}`,
    other: `# people, as ${app}`,
  });

/** A candidate process and where it came from. */
const candidateSummary = (sources: number, teams: string): string =>
  teams
    ? plural(sources, {
        one: `Time-consuming work that could be automated, raised in # source by ${teams}.`,
        other: `Time-consuming work that could be automated, raised in # sources by ${teams}.`,
      })
    : plural(sources, {
        one: "Time-consuming work that could be automated, raised in # source, by no team yet.",
        other:
          "Time-consuming work that could be automated, raised in # sources, by no team yet.",
      });

/** What a source added: "9 statements: 4 time wasters, 3 blockers". */
const addedText = (statements: number, breakdown: string): string =>
  plural(statements, {
    one: `# statement: ${breakdown}`,
    other: `# statements: ${breakdown}`,
  });

/** The stakeholder of an interviewed team: "Head of compliance, interviewed 29 Aug 2026 (voice agent)". */
const interviewedOn = (
  role: string,
  date: string,
  how: string | undefined
): string =>
  given(how)
    ? t`${role}, interviewed ${date} (${how})`
    : t`${role}, interviewed ${date}`;

/** The stakeholder of a team not interviewed yet, and whether they are invited. */
const notInterviewed = (role: string, date: string | undefined): string =>
  given(date)
    ? t`${role}, invited ${date}, not interviewed yet`
    : t`${role}, not invited yet, not interviewed yet`;

/** How Grasp saw an application in use, in a list: "Microsoft sign-in". */
const seenLabel: Record<SeenThrough, MessageDescriptor> = {
  microsoftSso: msg`Microsoft sign-in`,
  googleSso: msg`Google sign-in`,
  pulse: msg({ message: "Pulse", comment: "Product name: keep it as it is" }),
};

/** When Grasp saw an application in use, on the timeline. */
const seenInUse = (seen: SeenThrough): string =>
  select(seen, {
    microsoftSso: "Seen in use through Microsoft sign-in",
    googleSso: "Seen in use through Google sign-in",
    other: "Seen in use through Pulse",
  });

/** The import that showed an application in use. */
const seenSource: Record<SeenThrough, string> = {
  microsoftSso: "src-sso",
  googleSso: "src-sso",
  pulse: "src-pulse",
};

/** Linked notes in the side panel, grouped under these titles, in this order. */
const linkedTitle: [NoteKind, MessageDescriptor][] = [
  ["vision", msg`Vision`],
  ["goal", msg`Goals`],
  ["team", msg`Teams`],
  ["channel", msg`Ways of collecting`],
  [
    "candidate",
    msg({
      message: "Workflows",
      context:
        "a group of notes in the brain: work worth turning into workflows",
    }),
  ],
  ["tool", msg`Tools`],
  ["app", msg`Applications`],
  ["gap", msg`Gaps`],
];

// Short sentences on notes, each with its value named for the translators. A role is the client's
// own words, such as "head of compliance".
const setIn = (source: string): string => t`Set in ${source}`;
const foundIn = (source: string): string => t`Found in ${source}`;
const namedIn = (source: string): string => t`Named in ${source}`;
const talkedAboutIn = (source: string): string => t`Talked about in ${source}`;
const cameUpIn = (source: string): string => t`Came up in ${source}`;
const noticedIn = (source: string): string => t`Noticed in ${source}`;
const was = (before: string): string => t`Was: ${before}`;
const wasThe = (role: string): string => t`Was the ${role}`;
const byThe = (role: string): string => t`By the ${role}`;
const confirmedByThe = (role: string): string => t`Confirmed by the ${role}`;
const askThe = (role: string): string => t`Ask the ${role}`;
const canAnswer = (role: string): string => t`${role} can answer it`;
const addedAsQuestion = (): string => t`Added as an open question`;
const versionText = (version: number): string => t`Version ${version}`;
const teamInterviewed = (team: string): string => t`${team} interviewed`;
const interviewedThe = (role: string): string => t`Interviewed: the ${role}`;
const stakeholderNamed = (role: string): string =>
  t`Stakeholder named: the ${role}`;
const stakeholderChanged = (role: string): string =>
  t`Stakeholder changed to the ${role}`;
const goalAdjusted = (goal: string): string => t`Adjusted: ${goal}`;
const questionAnswered = (question: string): string => t`Answered: ${question}`;
const answerChangedTo = (question: string): string =>
  t`Changed the answer to: ${question}`;
const gapNoticed = (question: string): string => t`Gap noticed: ${question}`;
const answeredOn = (date: string): string => t`Answered on ${date}.`;
const openSince = (date: string): string =>
  t`Open since ${date}. Until it is answered, this stays unknown, never zero.`;

/** How the board would notice a goal is met, as they said it. */
const howTheyNotice = (said: string | undefined): string => {
  if (!given(said)) {
    return t`How they would notice: not said yet.`;
  }
  const notice = lowerFirst(said);
  return t`How they would notice: ${notice}.`;
};

/** A team's size as a new import found it. */
const sizeChanged = (count: number | null): string => {
  if (count === null) {
    return t`Size changed to unknown`;
  }
  const people = formatNumber(count);
  return t`Size changed to ${people}`;
};

/** A team's size before a new import. */
const sizeWas = (count: number | null): string => {
  if (count === null) {
    return t`Was unknown`;
  }
  const people = formatNumber(count);
  return t`Was ${people}`;
};

/** What an application is, from the Landscape: "Chat assistant by OpenAI". */
const appWhat = (
  category: string,
  vendor: string,
  aiBuiltIn: boolean
): string =>
  aiBuiltIn
    ? t`${category} by ${vendor}, with AI built in`
    : t`${category} by ${vendor}`;

/** "Answered: Monthly budget for AI", or "Changed the answer to: …" when it replaced one. */
const answerTitle = (question: string, changed: boolean): string =>
  changed ? answerChangedTo(question) : questionAnswered(question);

/** Something that has not happened yet, on a timeline: an answer to a gap. */
const answeredLater = (): string =>
  t({
    message: "Answered",
    comment: "Something that has not happened yet, on a timeline",
  });

const VISION = "vision";
const COMPANY = "company";

/** Who gave a source and how, for a timeline: "Controller · Live, 45 minutes". */
const whoAndHow = (source: Pick<Source, "who" | "how">): string =>
  [source.who, source.how].filter(given).join(" · ");

/** How many of each kind were said, most first: "3 time wasters, 1 handover". */
const saidText = (statements: Statement[]): string =>
  saidOrder
    .map(
      (kind) =>
        [
          kind,
          statements.filter((statement) => statement.kind === kind).length,
        ] as const
    )
    .filter(([, count]) => count > 0)
    .toSorted((a, b) => b[1] - a[1])
    .map(([kind, count]) => saidCount(kind, count))
    .join(", ");

/** The landscape application a tool name means ("Outlook" is Microsoft 365), if Grasp has seen it. */
const appFor = (ws: Workspace, tool: Tool): LandscapeApp | undefined => {
  const name = tool.name.toLowerCase();
  return ws.landscape.find(
    (app) =>
      app.name.toLowerCase() === name ||
      app.matches.some((match) => match.toLowerCase() === name)
  );
};

/** Applications Grasp saw in use that no interview or statement mentioned. */
export const unmentionedApps = (ws: Workspace): LandscapeApp[] => {
  const mentioned = new Set(
    ws.tools.map((tool) => appFor(ws, tool)?.id).filter(given)
  );
  return ws.landscape.filter((app) => !mentioned.has(app.id));
};

/** One team as an import listed it: its size and roles then, and the size before when this import changed it. */
export interface TeamRow {
  teamId: string;
  people: number | null;
  before?: number | null;
  roles: Role[];
}

/** One application as sign-in or Pulse showed it, with its note: the tool a team named, or the application nobody did. */
export interface AppRow {
  app: LandscapeApp;
  noteId: string;
  named: boolean;
}

/** What an import brought in, row by row. */
export type SourceContents =
  | { kind: "teams"; rows: TeamRow[] }
  | { kind: "apps"; signIn: boolean; rows: AppRow[] };

/** Every team as a directory listed it on that day. A refresh stores only what changed, so the rest carries over. */
const directoryRows = (
  ws: Workspace,
  source: Source,
  sourceId: string
): TeamRow[] =>
  ws.teams.flatMap((team): TeamRow[] => {
    const known = team.counts.filter((count) => count.date <= source.date);
    const count = known.at(-1);
    if (!count) {
      return [];
    }
    const own = team.counts.findIndex((each) => each.sourceId === sourceId);
    const previous = own > 0 ? team.counts[own - 1] : undefined;
    return [
      {
        teamId: team.id,
        people: count.people,
        before:
          previous && previous.people !== count.people
            ? previous.people
            : undefined,
        roles: count.roles ?? [],
      },
    ];
  });

/**
 * What an import brought in, so its source holds the context the other notes are drawn from: the
 * teams and roles from a directory, or the applications seen through sign-in or Pulse, by name.
 * Nothing for a conversation or a document, which have their own text.
 */
export const sourceContents = (
  ws: Workspace,
  sourceId: string
): SourceContents | undefined => {
  const source = ws.sources.find((candidate) => candidate.id === sourceId);
  if (!source?.connection) {
    return undefined;
  }
  if (source.connection === "directory") {
    return { kind: "teams", rows: directoryRows(ws, source, sourceId) };
  }
  const ways: SeenThrough[] =
    source.connection === "pulse" ? ["pulse"] : ["microsoftSso", "googleSso"];
  // The first tool that means an application is its note; several names can mean one ("Outlook" and "Excel").
  const toolOf = new Map<string, string>();
  for (const tool of ws.tools) {
    const app = appFor(ws, tool);
    if (app && !toolOf.has(app.id)) {
      toolOf.set(app.id, tool.id);
    }
  }
  const rows = ws.landscape
    .filter((app) => app.seenThrough.some((way) => ways.includes(way)))
    .map((app) => ({
      app,
      noteId: toolOf.get(app.id) ?? `app-${app.id}`,
      named: toolOf.has(app.id),
    }))
    .toSorted((a, b) => a.app.name.localeCompare(b.app.name));
  return { kind: "apps", signIn: source.connection === "signIn", rows };
};

/** What an import added, in a few words: "6 teams, with their roles". */
const importedText = (contents: SourceContents): string => {
  const count = contents.rows.length;
  return contents.kind === "teams"
    ? plural(count, {
        one: "# team, with its roles",
        other: "# teams, with their roles",
      })
    : plural(count, { one: "# application", other: "# applications" });
};

/** Every step, in drawing order, wherever it sits. */
const everyStep = (steps: Step[]): Step[] =>
  steps.flatMap((step) => [
    step,
    ...(step.split?.paths.flatMap((path) => everyStep(path.steps)) ?? []),
  ]);

/** Workflows whose steps use any of these tool names, today or in the target design. */
const workflowsUsing = (ws: Workspace, names: string[]): Workflow[] => {
  const wanted = names.map((name) => name.toLowerCase());
  const uses = (step: Step) =>
    (step.tool ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .some((name) => wanted.some((want) => name.includes(want)));
  return ws.workflows.filter((workflow) =>
    [
      ...everyStep(workflow.baseline.steps),
      ...everyStep(workflow.target?.steps ?? []),
    ].some(uses)
  );
};

/** The connector for a system, found by its name or any name a workflow step uses for it. */
const connectionFor = (ws: Workspace, names: string[]) => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return ws.connections.find(
    (candidate) =>
      wanted.has(candidate.name.toLowerCase()) ||
      candidate.matches.some((match) => wanted.has(match.toLowerCase()))
  );
};

/** A system's logo as a full path: the one the Landscape table shows, else its connector's, else none. */
const logoOf = (
  ws: Workspace,
  app: LandscapeApp | undefined,
  names: string[]
): string | undefined => {
  // The Landscape records keep an empty path for an application without a logo.
  if (given(app?.logoSrc)) {
    return app.logoSrc;
  }
  const file = app?.logo ?? connectionFor(ws, names)?.logo;
  return given(file) ? `/logos/${file}` : undefined;
};

/** Whether Grasp can reach a system, in a few words. */
const accessText = (ws: Workspace, names: string[]): string => {
  const connection = connectionFor(ws, names);
  if (!connection) {
    return t`No connector yet`;
  }
  const direct = connection.via === "direct";
  if (connection.status === "connected") {
    return direct ? t`Connected, direct` : t`Connected, via Composio`;
  }
  return direct ? t`Available, direct` : t`Available, via Composio`;
};

/**
 * What people said or decided belongs in the brain, whenever it came in: an interview, a chat with
 * an agent, a document. Exports and run logs from step 3 on only back workflow numbers, and live on
 * the Workflows page.
 */
const inBrain = (source: Source): boolean =>
  (source.step ?? 2) <= 2 ||
  (source.kind !== "import" && source.kind !== "runLog");

/** Whether a source speaks for a team. */
const speaksFor = (source: Source, teamId: string): boolean =>
  source.teamIds?.includes(teamId) === true;

/**
 * The teams actually interviewed: a step 1 or 2 source speaks for them. A team that another team
 * mentions has been heard of, not interviewed.
 */
export const interviewsFor = (ws: Workspace, team: Team): Source[] =>
  ws.sources.filter(
    (source) =>
      inBrain(source) &&
      source.interviewee !== "employee" &&
      speaksFor(source, team.id)
  );

/** The brain has two steps; anything that came in later adds to the inventory of step 2. */
const brainStep = (source: Source): NoteStep => (source.step === 1 ? 1 : 2);

/** The dated moments in a workflow's life, for the notes that lead to it. */
const workflowEvents = (flow: Workflow): NoteEvent[] => {
  const events: NoteEvent[] = [];
  const at = { workflowId: flow.id, quotes: [], own: false };
  const workflow = flow.name;
  if (given(flow.baseline.confirmedAt)) {
    const person = flow.baseline.confirmedBy ?? "";
    events.push({
      ...at,
      date: flow.baseline.confirmedAt,
      title: t`Drawn as a workflow: ${workflow}`,
      detail: t`Confirmed by ${person}`,
    });
  }
  if (given(flow.target?.confirmedAt)) {
    const person = flow.target.confirmedBy ?? "";
    events.push({
      ...at,
      date: flow.target.confirmedAt,
      title: t`Target design agreed`,
      detail: t`With ${person}`,
    });
  }
  const live = flow.results?.[0]?.period.from;
  if (given(live)) {
    events.push({
      ...at,
      date: live,
      title: t`Live, being measured`,
      detail: i18n._(statusLabel[flow.status]),
    });
  }
  return events;
};

/** A workflow in a point: its name and status, or only its status when the name is already there. */
const workflowRef = (flow: Workflow, nameShown = false): NoteRef => {
  const { status } = flow;
  const workflow = flow.name;
  return {
    label: nameShown
      ? select(status, {
          drawn: "Drawn as a workflow",
          designed: "Designed as a workflow",
          testing: "Testing as a workflow",
          other: "Running as a workflow",
        })
      : select(status, {
          drawn: `${workflow} (drawn)`,
          designed: `${workflow} (designed)`,
          testing: `${workflow} (testing)`,
          other: `${workflow} (running)`,
        }),
    workflowId: flow.id,
  };
};

const quote = (statement: Statement, ownId = ""): NoteQuote => ({
  statementId: statement.id,
  sourceId: statement.sourceId,
  text: statement.text,
  own: statement.id === ownId,
});

const event = (
  date: string,
  title: string,
  rest: Partial<NoteEvent> = {}
): NoteEvent => ({ date, title, quotes: [], own: false, ...rest });

/** A point at the top of a note, or nothing when there is nothing to say. */
const point = (
  label: string,
  value: NoteRef[] | string
): NotePoint | undefined => {
  let refs: NoteRef[] = [];
  if (typeof value !== "string") {
    refs = value;
  } else if (value) {
    refs = [{ label: value }];
  }
  return refs.length > 0 ? { label, refs } : undefined;
};

const points = (...list: (NotePoint | undefined)[]): NotePoint[] =>
  list.filter((entry): entry is NotePoint => Boolean(entry));

/** A statement in the reader's quotation marks: “…” in English, „…“ in German. */
export const quoted = (text: string): string =>
  t({
    message: `“${text}”`,
    comment: "A statement, quoted. Use the quotation marks of your language.",
  });

type Draft = Omit<
  Note,
  "backlinks" | "linked" | "mentions" | "processIds" | "statementIds"
> & {
  /** Sources behind this note, for the side panel. */
  sourceIds: string[];
  /** Workflows it leads to, for the side panel. */
  workflowIds: string[];
  /** Words that mean this note when a statement uses them. */
  terms: string[];
};

/** What a workflow still lacks, on the notes that lead to it. */
const notMeasured = (workflows: Workflow[]): string[] =>
  workflows.some((workflow) => workflow.status === "running")
    ? []
    : [t`Result: not measured yet`];

/** What a candidate still waits for: being drawn, then a measured result. */
const candidateOpen = (workflow: Workflow | undefined): string[] =>
  workflow ? notMeasured([workflow]) : [t`Drawn as a workflow`];

/** A team's interview, as its page's first point says it. */
const interviewRef = (
  stakeholder: Stakeholder | undefined,
  interview: Source | undefined
): NoteRef => {
  if (!stakeholder) {
    return { label: t`No stakeholder named yet` };
  }
  if (interview) {
    return {
      label: interviewedOn(
        stakeholder.role,
        formatDay(interview.date),
        given(interview.how) ? lowerFirst(interview.how) : undefined
      ),
      to: interview.id,
    };
  }
  return {
    label: notInterviewed(
      stakeholder.role,
      given(stakeholder.invitedAt)
        ? formatDay(stakeholder.invitedAt)
        : undefined
    ),
  };
};

/** The tags of an application nobody named. */
const appTags = (app: LandscapeApp): string[] => {
  let ai: string[] = [];
  if (app.ai === "tool") {
    ai = ["ai-tool"];
  } else if (app.ai === "builtIn") {
    ai = ["ai"];
  }
  return [
    "tool",
    "never-mentioned",
    ...ai,
    ...(given(app.owner ?? undefined) ? [] : ["no-owner"]),
  ];
};

/** A question the board answers on the Vision page, with its answers so far. */
interface BoardQuestion {
  question: string;
  answers: Answer[];
  open: string;
}

/** One answer the board gave, with the question and the answer it replaced. */
interface BoardAnswer {
  question: string;
  value: Answer;
  previous?: Answer;
}

/** What every part of the brain is built from: the records, and lookups shared by every note. */
interface Context {
  ws: Workspace;
  sourceById: Map<string, Source>;
  workflowById: Map<string, Workflow>;
  brainSources: Source[];
  employeeSources: Source[];
  drafts: Draft[];
  boardQuestions: BoardQuestion[];
  boardAnswers: BoardAnswer[];
}

const teamNameIn = (ws: Workspace, id: string): string =>
  ws.teams.find((team) => team.id === id)?.name ?? id;

const dateIn = (cx: Context, sourceId: string): string =>
  cx.sourceById.get(sourceId)?.date ?? "";

const titleIn = (cx: Context, sourceId: string): string =>
  cx.sourceById.get(sourceId)?.title ?? t`Unknown source`;

/** Notes by id, each with the title it has: a draft's, else the team's name. */
const refsIn = (cx: Context, ids: string[]): NoteRef[] =>
  ids.map((id) => ({
    label:
      cx.drafts.find((draft) => draft.id === id)?.title ??
      teamNameIn(cx.ws, id),
    to: id,
  }));

/** One event per source, with what it said: the backbone of most timelines. */
const perSource = (
  cx: Context,
  statements: Statement[],
  title: (source: Source) => string,
  ownId = ""
): NoteEvent[] =>
  unique(statements.map((statement) => statement.sourceId)).flatMap(
    (sourceId) => {
      const source = cx.sourceById.get(sourceId);
      if (!source) {
        return [];
      }
      const said = statements.filter(
        (statement) => statement.sourceId === sourceId
      );
      return [
        event(source.date, title(source), {
          detail: whoAndHow(source),
          to: sourceId,
          quotes: said.map((statement) => quote(statement, ownId)),
        }),
      ];
    }
  );

/** The company: the root of the vault. */
const companyDraft = (cx: Context): Draft => {
  const { ws, brainSources, employeeSources } = cx;
  const openGaps = ws.gaps.filter((gap) => !given(gap.closedAt));
  const invited = ws.teams.filter((team) =>
    ws.vision.inviteTeamIds.includes(team.id)
  );
  const interviewed = invited.flatMap((team) => {
    const [first] = interviewsFor(ws, team).toSorted((a, b) =>
      a.date.localeCompare(b.date)
    );
    return first ? [{ team, first }] : [];
  });
  const allInterviewed =
    invited.length > 0 && interviewed.length === invited.length;
  return {
    id: COMPANY,
    kind: "company",
    title: ws.company.name,
    path: [],
    step: 0,
    tags: ["company", "hub"],
    summary: companySummary(ws.company.sector, ws.company.people),
    points: points(
      point(
        t`In the brain`,
        inTheBrain(ws.teams.length, ws.statements.length, ws.candidates.length)
      ),
      point(t`Interviews`, [
        { label: interviewedOf(interviewed.length, invited.length) },
        ...(employeeSources.length > 0
          ? [{ label: employeesInterviewed(employeeSources.length) }]
          : []),
      ]),
      point(t`Still open`, stillOpen(openGaps.length))
    ),
    // The home of the brain says what the brain is and how to read it, so a first visit knows where to look.
    article: howTheBrainWorks(ws.company.name),
    // Milestones only, so the root stays short however many sources come in. Each source keeps its own note.
    timeline: [
      ...brainSources
        .filter((source) => source.step === 1 && source.kind === "interview")
        .map((source) =>
          event(source.date, source.title, {
            detail: source.who,
            to: source.id,
          })
        ),
      ...(given(ws.vision.confirmedAt)
        ? [
            event(ws.vision.confirmedAt, t`Vision page confirmed`, {
              detail: byThe(ws.vision.confirmedBy ?? ""),
              to: VISION,
            }),
          ]
        : []),
      ...interviewed.map(({ team, first }) =>
        event(first.date, teamInterviewed(team.name), {
          detail: first.how,
          to: team.id,
        })
      ),
      ...(allInterviewed
        ? [
            event(
              interviewed
                .map(({ first }) => first.date)
                .toSorted()
                .at(-1) ?? "",
              t`Every invited team interviewed`,
              { own: true }
            ),
          ]
        : []),
    ],
    open:
      interviewed.length < invited.length
        ? [t`Every invited team interviewed`]
        : [],
    links: [VISION, ...ws.teams.map((team) => team.id)],
    sourceIds: [],
    workflowIds: [],
    terms: [],
  };
};

/** Step 1: the Vision page. Its points are filled once goals and teams are notes, so their titles are known. */
const visionDraft = (cx: Context): Draft => {
  const { vision } = cx.ws;
  const stepOne = cx.brainSources.filter((source) => source.step === 1);
  return {
    id: VISION,
    kind: "vision",
    title: t`Vision page`,
    path: ["1 Vision"],
    step: 1,
    tags: ["vision", given(vision.confirmedAt) ? "confirmed" : "draft"],
    summary: vision.ambition,
    points: [],
    timeline: [
      ...stepOne.map((source) =>
        event(source.date, source.title, {
          detail: whoAndHow(source),
          to: source.id,
        })
      ),
      ...(given(vision.confirmedAt)
        ? [
            event(
              vision.confirmedAt,
              confirmedByThe(vision.confirmedBy ?? ""),
              { detail: versionText(vision.version), own: true }
            ),
          ]
        : []),
      ...cx.boardAnswers.map(({ question, value, previous }) =>
        event(value.date, answerTitle(question, Boolean(previous)), {
          detail: previous ? was(previous.text) : value.text,
          to: value.sourceId,
          own: true,
        })
      ),
    ],
    open: [
      ...(given(vision.confirmedAt) ? [] : [t`Confirmed by the board`]),
      ...cx.boardQuestions
        .filter(({ answers }) => answers.length === 0)
        .map(({ open }) => open),
    ],
    links: [
      ...cx.ws.goals.map((goal) => goal.id),
      ...vision.inviteTeamIds,
      vision.sourceId,
      ...cx.boardAnswers.map(({ value }) => value.sourceId),
    ],
    sourceIds: stepOne.map((source) => source.id),
    workflowIds: [],
    terms: [],
  };
};

/** A board goal, with every wording it had. */
const goalDraft = (cx: Context, goal: Goal): Draft => {
  const serving = cx.ws.workflows.filter(
    (workflow) => workflow.goalId === goal.id
  );
  const history = changes(goal.versions);
  const set = history[0]?.value;
  const now = history.at(-1)?.value;
  const before = history.at(-1)?.previous;
  const sources = goal.versions.map((version) => version.sourceId);
  return {
    id: goal.id,
    kind: "goal",
    title: now?.title ?? goal.id,
    path: ["1 Vision", "Goals"],
    step: 1,
    tags: ["goal", "board", ...(history.length > 1 ? ["changed"] : [])],
    summary: howTheyNotice(now?.howWeNotice),
    points: points(
      set
        ? point(t({ message: "Set in", context: "note property" }), [
            {
              label: `${titleIn(cx, set.sourceId)}, ${formatDay(set.date)}`,
              to: set.sourceId,
            },
          ])
        : undefined,
      now && before
        ? point(t({ message: "Adjusted in", context: "note property" }), [
            {
              label: `${titleIn(cx, now.sourceId)}, ${formatDay(now.date)}`,
              to: now.sourceId,
            },
          ])
        : undefined,
      before
        ? point(
            t({ message: "Before", context: "note property" }),
            before.title
          )
        : undefined,
      point(
        t`Served by`,
        serving.length > 0
          ? serving.map((workflow) => workflowRef(workflow))
          : t`No workflow yet`
      )
    ),
    timeline: [
      ...history.map(({ value, previous }) =>
        previous
          ? event(value.date, goalAdjusted(value.title), {
              detail: was(previous.title),
              to: value.sourceId,
              own: true,
            })
          : event(value.date, setIn(titleIn(cx, value.sourceId)), {
              detail: cx.sourceById.get(value.sourceId)?.who,
              to: value.sourceId,
              own: true,
            })
      ),
      ...serving.flatMap(workflowEvents),
    ],
    open: notMeasured(serving),
    links: sources,
    sourceIds: sources,
    workflowIds: serving.map((workflow) => workflow.id),
    terms: [],
  };
};

/** A team's size and stakeholders as they changed, oldest first. */
const teamHistory = (cx: Context, team: Team): NoteEvent[] => [
  ...changes(team.counts).map(({ value, previous }) =>
    previous
      ? event(value.date, sizeChanged(value.people), {
          detail: [sizeWas(previous.people), titleIn(cx, value.sourceId)].join(
            " · "
          ),
          to: value.sourceId,
        })
      : event(value.date, foundIn(titleIn(cx, value.sourceId)), {
          detail: sizeText(value),
          to: value.sourceId,
        })
  ),
  ...changes(team.stakeholders).flatMap(({ value, previous }) => [
    previous
      ? event(value.date, stakeholderChanged(lowerFirst(value.role)), {
          detail: wasThe(lowerFirst(previous.role)),
          to: value.sourceId,
        })
      : event(value.date, stakeholderNamed(lowerFirst(value.role)), {
          detail: titleIn(cx, value.sourceId),
          to: value.sourceId,
        }),
    ...(given(value.invitedAt)
      ? [
          event(value.invitedAt, t`Stakeholder invited into Grasp`, {
            detail: value.role,
          }),
        ]
      : []),
  ]),
];

/** What an invited team still waits for: its stakeholder invited, then interviewed. */
const teamStillToCome = (stakeholder: Stakeholder | undefined): string[] => [
  ...(given(stakeholder?.invitedAt) ? [] : [t`Stakeholder invited into Grasp`]),
  stakeholder
    ? interviewedThe(lowerFirst(stakeholder.role))
    : t({
        message: "Interviewed",
        comment: "Something that has not happened yet, on a timeline",
      }),
];

/** Step 2: a team. Its points are filled once tools and candidates are notes. */
const teamDraft = (cx: Context, team: Team): Draft => {
  const { ws } = cx;
  const said = ws.statements.filter((statement) =>
    statement.teamIds.includes(team.id)
  );
  const heardIn = unique(said.map((statement) => statement.sourceId));
  const interviews = interviewsFor(ws, team);
  const isInvited = ws.vision.inviteTeamIds.includes(team.id);
  const workflows = ws.workflows.filter(
    (workflow) => workflow.teamId === team.id
  );
  const stakeholder = latest(team.stakeholders);
  return {
    id: team.id,
    kind: "team",
    title: team.name,
    path: ["2 Inventory", "Teams"],
    step: 2,
    tags: [
      "team",
      ...(isInvited ? ["invited"] : []),
      interviews.length > 0 ? "interviewed" : "not-interviewed",
    ],
    summary: teamSummary(
      latest(team.counts),
      {
        stakeholder: interviews.length > 0 ? stakeholder?.role : undefined,
        employees: cx.employeeSources.filter((source) =>
          speaksFor(source, team.id)
        ).length,
      },
      heardIn.length
    ),
    points: [],
    timeline: [
      ...teamHistory(cx, team),
      ...interviews
        .filter((source) => !heardIn.includes(source.id))
        .map((source) =>
          event(source.date, source.title, {
            detail: whoAndHow(source),
            to: source.id,
          })
        ),
      ...perSource(cx, said, (source) => source.title),
      ...workflows.flatMap(workflowEvents),
    ],
    open:
      interviews.length > 0 || !isInvited ? [] : teamStillToCome(stakeholder),
    links: [
      team.sourceId,
      ...team.counts.map((entry) => entry.sourceId),
      ...interviews.map((source) => source.id),
    ],
    sourceIds: [
      team.sourceId,
      ...team.counts.map((entry) => entry.sourceId),
      ...interviews.map((source) => source.id),
      ...heardIn,
    ],
    workflowIds: workflows.map((workflow) => workflow.id),
    terms: [team.name],
  };
};

/** The ways Grasp saw an application in use, in a list: "Microsoft sign-in and Pulse". */
const seenThroughText = (app: LandscapeApp): string =>
  joinNames(app.seenThrough.map((seen) => i18n._(seenLabel[seen])));

/** A tool a team named. */
const toolDraft = (cx: Context, tool: Tool): Draft => {
  const { ws } = cx;
  const app = appFor(ws, tool);
  const about = ws.statements.filter((statement) =>
    statement.toolIds.includes(tool.id)
  );
  const workflows = workflowsUsing(ws, [tool.name]);
  const names = [tool.name, ...(app ? [app.name, ...app.matches] : [])];
  const firstSaid = about.filter(
    (statement) => statement.sourceId === tool.sourceId
  );
  const processes = unique(
    about.map((statement) => statement.candidateId).filter(given)
  );
  // One list of workflows: each the brain holds as a note, then any drawn workflow it holds no note for.
  const noted = new Set(
    ws.candidates
      .filter((candidate) => processes.includes(candidate.id))
      .map((candidate) => candidate.workflowId)
  );
  const toolWorkflows: NoteRef[] = [
    ...processes.map((id) => ({
      label: ws.candidates.find((candidate) => candidate.id === id)?.name ?? id,
      to: id,
    })),
    ...workflows
      .filter((workflow) => !noted.has(workflow.id))
      .map((workflow) => ({ label: workflow.name, workflowId: workflow.id })),
  ];
  const ai = app?.ai ?? tool.ai;
  // Every team that names it counts, including the ones that did so in a later conversation.
  const namedBy = unique([
    ...tool.teamIds,
    ...about.flatMap((statement) => statement.teamIds),
  ]);
  const seenThrough = app?.seenThrough ?? [];
  return {
    id: tool.id,
    kind: "tool",
    title: tool.name,
    logoSrc: logoOf(ws, app, names),
    path: ["2 Inventory", "Tools", "Mentioned"],
    step: 2,
    tags: [
      "tool",
      app ? "observed" : "reported",
      ...(namedBy.length > 1 ? ["shared"] : []),
      ...(ai !== undefined && ai !== "none" ? ["ai"] : []),
    ],
    summary: app
      ? toolSeen(namedBy.length, app.people, seenThroughText(app))
      : toolReported(namedBy.length),
    points: points(
      point(t`Named by`, refsIn(cx, namedBy)),
      point(
        t({
          message: "Workflows",
          context: "note property: the workflows a tool or team is part of",
        }),
        toolWorkflows.length === 0 ? t`None yet` : toolWorkflows
      ),
      point(t`Grasp access`, accessText(ws, names)),
      point(t`AI`, aiText(ai, Boolean(app)))
    ),
    timeline: [
      event(dateIn(cx, tool.sourceId), namedIn(titleIn(cx, tool.sourceId)), {
        detail: cx.sourceById.get(tool.sourceId)?.who,
        to: tool.sourceId,
        quotes: firstSaid.map((statement) => quote(statement)),
      }),
      ...(app
        ? seenThrough.map((seen) =>
            event(dateIn(cx, seenSource[seen]), seenInUse(seen), {
              detail: peopleAs(app.people, app.name),
              to: seenSource[seen],
            })
          )
        : []),
      ...perSource(
        cx,
        about.filter((statement) => statement.sourceId !== tool.sourceId),
        (source) => talkedAboutIn(source.title)
      ),
    ],
    open: app
      ? []
      : [t`Seen in use: not observed through sign-in or Pulse yet`],
    links: [
      ...namedBy,
      tool.sourceId,
      ...processes,
      ...(seenThrough.includes("pulse") ? ["src-pulse"] : []),
    ],
    sourceIds: unique([
      tool.sourceId,
      ...seenThrough.map((seen) => seenSource[seen]),
      ...about.map((statement) => statement.sourceId),
    ]),
    workflowIds: workflows.map((workflow) => workflow.id),
    terms: names,
  };
};

/** An application Grasp saw in use that no team named. */
const appDraft = (cx: Context, app: LandscapeApp): Draft => {
  const { ws } = cx;
  const id = `app-${app.id}`;
  const ownerTeam = ws.teams.find((team) => team.name === app.owner);
  const questions = ws.gaps.filter((gap) => gap.about.includes(id));
  const seenSources = unique(app.seenThrough.map((seen) => seenSource[seen]));
  return {
    id,
    kind: "app",
    title: app.name,
    logoSrc: logoOf(ws, app, [app.name, ...app.matches]),
    path: ["2 Inventory", "Tools", "Seen, never mentioned"],
    step: 2,
    tags: appTags(app),
    summary: appUnnamed(app.people, seenThroughText(app)),
    points: points(
      point(
        t`What it is`,
        appWhat(app.category, app.vendor, app.ai === "builtIn")
      ),
      point(
        t({
          message: "Owner",
          context: "note property: the team that owns an application",
        }),
        app.owner ?? t`Nobody`
      ),
      point(t`Grasp access`, accessText(ws, [app.name, ...app.matches])),
      point(
        t`Open question`,
        questions.map((gap) => ({ label: gap.question, to: gap.id }))
      )
    ),
    timeline: [
      ...app.seenThrough.map((seen) =>
        event(dateIn(cx, seenSource[seen]), seenInUse(seen), {
          detail: peopleText(app.people),
          to: seenSource[seen],
        })
      ),
      ...questions.map((gap) =>
        event(dateIn(cx, gap.sourceId), addedAsQuestion(), {
          detail: canAnswer(gap.owner),
          to: gap.id,
        })
      ),
    ],
    open: [t`Named by a team`, t`Used in a workflow`],
    links: [...seenSources, ...(ownerTeam ? [ownerTeam.id] : [])],
    sourceIds: seenSources,
    workflowIds: [],
    terms: [app.name, ...app.matches],
  };
};

/** Time-consuming work that came up in what people said, and could become a workflow. */
const candidateDraft = (cx: Context, candidate: Candidate): Draft => {
  const { ws } = cx;
  const said = ws.statements.filter(
    (statement) => statement.candidateId === candidate.id
  );
  const teams = unique(said.flatMap((statement) => statement.teamIds));
  const sources = unique(said.map((statement) => statement.sourceId));
  const workflow = given(candidate.workflowId)
    ? cx.workflowById.get(candidate.workflowId)
    : undefined;
  return {
    id: candidate.id,
    kind: "candidate",
    title: candidate.name,
    path: ["2 Inventory", "Candidates"],
    step: 2,
    tags: ["candidate", workflow ? "drawn" : "not-drawn"],
    summary: candidateSummary(
      sources.length,
      joinNames(teams.map((id) => teamNameIn(ws, id)))
    ),
    points: points(
      point(t`What was said`, saidText(said)),
      point(
        t`Teams`,
        teams.map((id) => ({ label: teamNameIn(ws, id), to: id }))
      ),
      point(
        t`Tools`,
        unique(said.flatMap((statement) => statement.toolIds)).map((id) => ({
          label: ws.tools.find((tool) => tool.id === id)?.name ?? id,
          to: id,
        }))
      ),
      point(
        t({
          message: "In Workflows",
          context:
            "note property: the drawn version of this workflow on the Workflows page",
        }),
        workflow ? [workflowRef(workflow, true)] : t`Not drawn yet`
      )
    ),
    timeline: [
      ...perSource(cx, said, (source) => cameUpIn(source.title)),
      ...(workflow ? workflowEvents(workflow) : []),
    ],
    open: candidateOpen(workflow),
    links: teams,
    sourceIds: sources,
    workflowIds: workflow ? [workflow.id] : [],
    terms: [candidate.name],
  };
};

/** Something not known yet. Its points are filled once the notes it is about exist. */
const gapDraft = (cx: Context, gap: Gap): Draft => {
  const closed = given(gap.closedAt) ? gap.closedAt : undefined;
  return {
    id: gap.id,
    kind: "gap",
    title: gap.question,
    path: ["2 Inventory", "Gaps"],
    step: 2,
    tags: ["gap", closed === undefined ? "open" : "closed"],
    summary:
      closed === undefined
        ? openSince(formatDay(dateIn(cx, gap.sourceId)))
        : answeredOn(formatDay(closed)),
    points: [],
    timeline: [
      event(dateIn(cx, gap.sourceId), noticedIn(titleIn(cx, gap.sourceId)), {
        detail: cx.sourceById.get(gap.sourceId)?.who,
        to: gap.sourceId,
        quotes: cx.ws.statements
          .filter((statement) => gap.about.includes(statement.id))
          .map((statement) => quote(statement)),
      }),
      ...(closed === undefined
        ? []
        : [event(closed, answeredLater(), { detail: gap.answeredBy })]),
    ],
    open:
      closed === undefined
        ? [askThe(lowerFirst(gap.owner)), answeredLater()]
        : [],
    links: [gap.sourceId, ...gap.about],
    sourceIds: [gap.sourceId],
    workflowIds: gap.about.filter((id) => cx.workflowById.has(id)),
    terms: [],
  };
};

/** The policies the client uploaded to the policy manager are documents in the brain as well; their rules stay in Policies. */
const policyDocumentsIn = (ws: Workspace): PolicyDocument[] =>
  ws.policies.filter(
    (policy) => policy.status === "published" || policy.status === "review"
  );

/** Each source folder is a page, like the Vision page: what this way of collecting adds, and what came in. */
const channelDraft = (
  cx: Context,
  folder: ChannelFolder,
  folderOf: Map<string, SourceFolder>
): Draft => {
  const filed: Pick<Source, "id" | "title" | "date" | "who" | "how">[] = [
    ...cx.brainSources.filter((source) => folderOf.get(source.id) === folder),
    ...(folder === "Documents"
      ? policyDocumentsIn(cx.ws).map((policy) => ({
          id: policy.id,
          title: policy.title,
          date: policy.uploadedAt.slice(0, 10),
          how: t`Uploaded to Policies`,
        }))
      : []),
  ];
  return {
    id: channelId(folder),
    kind: "channel",
    title: folderName(folder),
    path: ["Sources", folder],
    step: 2,
    tags: ["channel"],
    summary: i18n._(channelSummary[folder]),
    points: [],
    timeline: filed.map((source) =>
      event(source.date, source.title, {
        detail: whoAndHow(source),
        to: source.id,
      })
    ),
    open: [],
    links: filed.map((source) => source.id),
    sourceIds: [],
    workflowIds: [],
    terms: [],
  };
};

/** A source's points: the policy it became, what it added, and the teams and workflows it spoke about. */
const sourcePoints = (
  cx: Context,
  source: Source,
  said: Statement[]
): NotePoint[] => {
  const { ws } = cx;
  const contents = sourceContents(ws, source.id);
  const added =
    contents && said.length === 0
      ? importedText(contents)
      : addedText(said.length, saidText(said));
  const policyId = given(source.policyId) ? source.policyId : undefined;
  return points(
    policyId === undefined
      ? undefined
      : point(t`Became`, [
          {
            label:
              ws.policies.find((policy) => policy.id === policyId)?.title ??
              policyId,
            to: policyId,
          },
        ]),
    said.length > 0 || contents
      ? point(
          t({
            message: "Added",
            context: "note property: what a source added",
          }),
          added
        )
      : undefined,
    point(
      t`About teams`,
      unique([
        ...(source.teamIds ?? []),
        ...said.flatMap((statement) => statement.teamIds),
      ]).map((id) => ({ label: teamNameIn(ws, id), to: id }))
    ),
    point(
      t({
        message: "Workflows",
        context: "note property: the workflows a source spoke about",
      }),
      unique(said.map((statement) => statement.candidateId).filter(given)).map(
        (id) => ({
          label:
            ws.candidates.find((candidate) => candidate.id === id)?.name ?? id,
          to: id,
        })
      )
    )
  );
};

/** A source: an interview, a chat, a document or an import. */
const sourceDraft = (
  cx: Context,
  source: Source,
  folderOf: Map<string, SourceFolder>
): Draft => {
  const said = cx.ws.statements.filter(
    (statement) => statement.sourceId === source.id
  );
  return {
    id: source.id,
    kind: "source",
    title: source.title,
    path: [
      "Sources",
      folderOf.get(source.id) ?? "Connections",
      ...conversationFolder(source),
    ],
    step: brainStep(source),
    tags: [
      "source",
      source.kind === "runLog" ? "run-log" : source.kind,
      ...(source.article ? ["article"] : []),
    ],
    summary: `${[source.who, source.how, formatDay(source.date)].filter(given).join(" · ")}.`,
    points: sourcePoints(cx, source, said),
    // Only what this source itself brought in, so it stays short however many other sources arrive.
    timeline: [
      event(source.date, t`Came in`, {
        detail: whoAndHow(source),
        quotes: said.map((statement) => quote(statement)),
        own: true,
      }),
      ...cx.boardAnswers
        .filter(({ value }) => value.sourceId === source.id)
        .map(({ question, value, previous }) =>
          event(value.date, answerTitle(question, Boolean(previous)), {
            detail: value.text,
            to: VISION,
          })
        ),
      ...cx.ws.gaps
        .filter((gap) => gap.sourceId === source.id)
        .map((gap) =>
          event(source.date, gapNoticed(gap.question), {
            detail: canAnswer(gap.owner),
            to: gap.id,
          })
        ),
    ],
    open: [],
    article: source.article,
    // A source links straight to what its statements are about.
    links: [
      ...(given(source.policyId) ? [source.policyId] : []),
      ...(source.teamIds ?? []),
      ...said.flatMap((statement) => [
        ...statement.teamIds,
        ...statement.toolIds,
        ...(given(statement.candidateId) ? [statement.candidateId] : []),
      ]),
    ],
    sourceIds: [],
    workflowIds: [],
    terms: [],
  };
};

/** A policy uploaded to the policy manager, as a document in the brain. */
const policyDraft = (cx: Context, policy: PolicyDocument): Draft => {
  const date = policy.uploadedAt.slice(0, 10);
  const rules = policy.proposals.filter(
    (proposal) => proposal.decision === "accepted"
  ).length;
  const earlier = cx.brainSources.filter(
    (source) => source.policyId === policy.id
  );
  return {
    id: policy.id,
    kind: "source",
    title: policy.title,
    path: ["Sources", "Documents"],
    step: 2,
    tags: ["source", "document", "policy"],
    summary: `${t`Uploaded to Policies`} · ${formatDay(date)}.`,
    points: points(
      point(t`In Policies`, [
        {
          label:
            policy.status === "published"
              ? rulesInUse(rules)
              : t`Rules waiting for a decision`,
          policyId: policy.id,
        },
      ]),
      earlier.length > 0
        ? point(
            t`Draft`,
            earlier.map((source) => ({ label: source.title, to: source.id }))
          )
        : undefined
    ),
    timeline: [
      event(date, t`Uploaded to Policies`, { own: true }),
      ...(given(policy.publishedAt)
        ? [
            event(policy.publishedAt.slice(0, 10), t`Rules published`, {
              detail: rulesInUse(rules),
            }),
          ]
        : []),
    ],
    open: [],
    // What the policy says, in its own words: its summary and the passages its rules come from.
    article: [
      ...(given(policy.summary) ? [policy.summary] : []),
      ...unique([
        ...policy.proposals.map((proposal) => proposal.excerpt),
        ...policy.unchecked.map((each) => each.excerpt),
      ]),
    ],
    links: earlier.map((source) => source.id),
    sourceIds: [],
    workflowIds: [],
    terms: [],
  };
};

/** The sources, filed per folder in a fixed order, oldest first within each, so the tree lists them the same way every time. */
const sourceDrafts = (cx: Context): Draft[] => {
  const folderOf = new Map(
    cx.brainSources.map((source) => [source.id, sourceFolderOf(source)])
  );
  const rank = (source: Source) => {
    const folder = folderOf.get(source.id);
    return folder === undefined ? -1 : sourceFolders.indexOf(folder);
  };
  return [
    ...sourceFolders
      .filter(isChannelFolder)
      .map((folder) => channelDraft(cx, folder, folderOf)),
    ...cx.brainSources
      .toSorted((a, b) => rank(a) - rank(b) || a.date.localeCompare(b.date))
      .map((source) => sourceDraft(cx, source, folderOf)),
    ...policyDocumentsIn(cx.ws).map((policy) => policyDraft(cx, policy)),
  ];
};

/** The Vision page's points, now that its goals and teams are notes. */
const visionPoints = (cx: Context): NotePoint[] =>
  points(
    point(t`Why now`, cx.ws.vision.whyNow),
    point(
      t`Goals`,
      refsIn(
        cx,
        cx.ws.goals.map((goal) => goal.id)
      )
    ),
    ...cx.boardQuestions.map(({ question, answers }) =>
      point(
        question,
        latest(answers)?.text ??
          t({
            message: "Not answered yet",
            context: "a question to the board without an answer",
          })
      )
    ),
    point(t`Invited for step 2`, refsIn(cx, cx.ws.vision.inviteTeamIds))
  );

/** A team's points, now that its tools and candidates are notes. */
const teamPoints = (cx: Context, team: Team): NotePoint[] => {
  const { ws } = cx;
  const said = ws.statements.filter((statement) =>
    statement.teamIds.includes(team.id)
  );
  const [interview] = interviewsFor(ws, team);
  return points(
    point(t`Interviewed`, [interviewRef(latest(team.stakeholders), interview)]),
    point(t`They told us`, said.length > 0 ? saidText(said) : t`Nothing yet`),
    point(
      t`They use`,
      refsIn(
        cx,
        ws.tools
          .filter((tool) => tool.teamIds.includes(team.id))
          .map((tool) => tool.id)
      )
    ),
    point(
      t({
        message: "Workflows",
        context: "note property: the workflows a tool or team is part of",
      }),
      refsIn(
        cx,
        ws.candidates
          .filter((candidate) =>
            said.some((statement) => statement.candidateId === candidate.id)
          )
          .map((candidate) => candidate.id)
      )
    ),
    point(
      t`Roles`,
      (latest(team.counts)?.roles ?? [])
        .map((role) => roleText(role.name, role.people))
        .join(", ")
    )
  );
};

/** A gap's points, now that the notes it is about exist. */
const gapPoints = (cx: Context, gap: Gap): NotePoint[] =>
  points(
    // An answer given in Grasp, in the words of who gave it.
    point(t`Answer`, gap.answer ?? ""),
    point(t`Answered by`, gap.answeredBy ?? ""),
    point(t`Who can answer`, gap.owner),
    point(
      t({ message: "About", context: "note property: what a note is about" }),
      gap.about.map((id): NoteRef => {
        const workflow = cx.workflowById.get(id);
        if (workflow) {
          return workflowRef(workflow, true);
        }
        // A statement is pointed at where it was said.
        const statement = cx.ws.statements.find(
          (candidate) => candidate.id === id
        );
        return statement
          ? {
              label: quoted(statement.text),
              to: statement.sourceId,
              statement: id,
            }
          : {
              label: cx.drafts.find((entry) => entry.id === id)?.title ?? id,
              to: id,
            };
      })
    ),
    point(t({ message: "Noticed in", context: "note property" }), [
      { label: titleIn(cx, gap.sourceId), to: gap.sourceId },
    ])
  );

/** Whether a statement is about a note: said by its team, naming its tool, about its process, said in it, or asked about in it. */
const isAbout = (
  ws: Workspace,
  note: Pick<Note, "id" | "kind">,
  statement: Statement
): boolean => {
  switch (note.kind) {
    case "team": {
      return statement.teamIds.includes(note.id);
    }
    case "tool": {
      return statement.toolIds.includes(note.id);
    }
    case "candidate": {
      return statement.candidateId === note.id;
    }
    case "source": {
      return statement.sourceId === note.id;
    }
    case "gap": {
      return ws.gaps.some(
        (gap) => gap.id === note.id && gap.about.includes(statement.id)
      );
    }
    case "company":
    case "vision":
    case "goal":
    case "channel":
    case "app":
    case "statement": {
      return false;
    }
    default: {
      return note.kind satisfies never;
    }
  }
};

/** Links between notes that exist, each connection once, and timelines oldest first. */
const linkUp = (cx: Context, ids: Set<string>): [string, string][] => {
  // A link to a statement is a link to the source it was said in.
  const saidIn = new Map(
    cx.ws.statements.map((statement) => [statement.id, statement.sourceId])
  );
  const edges = new Map<string, [string, string]>();
  for (const note of cx.drafts) {
    note.links = unique(note.links.map((id) => saidIn.get(id) ?? id)).filter(
      (id) => ids.has(id) && id !== note.id
    );
    note.timeline = note.timeline
      .filter((entry) => given(entry.date))
      .toSorted((a, b) => a.date.localeCompare(b.date));
    for (const target of note.links) {
      const key = [note.id, target].toSorted().join("|");
      if (!edges.has(key)) {
        edges.set(key, [note.id, target]);
      }
    }
  }
  return [...edges.values()];
};

/** A draft as the note it is: its side panel, mentions, statements and processes, from what links to it. */
const finished = (
  cx: Context,
  ids: Set<string>,
  backlinks: Map<string, string[]>,
  { sourceIds, workflowIds, terms, ...note }: Draft
): Note => {
  const { ws } = cx;
  const draft = (id: string) => cx.drafts.find((entry) => entry.id === id);
  const back = backlinks.get(note.id) ?? [];
  const neighbours = unique([...note.links, ...back]);
  const linked: NoteLinks[] = [
    {
      title: t`Sources`,
      refs: unique(sourceIds)
        .filter((id) => ids.has(id))
        .map((id) => ({ label: titleIn(cx, id), to: id })),
    },
    ...linkedTitle.map(([kind, title]) => ({
      title: i18n._(title),
      refs: neighbours
        .filter((id) => draft(id)?.kind === kind)
        .map((id) => ({ label: draft(id)?.title ?? id, to: id })),
    })),
    {
      title: t({
        message: "On the Workflows page",
        context: "links: drawn workflows, opened on the Workflows page",
      }),
      refs: unique(workflowIds).map((id) => ({
        label: cx.workflowById.get(id)?.name ?? id,
        workflowId: id,
      })),
    },
  ].filter((group) => group.refs.length > 0);
  const names = unique(
    terms.map((term) => term.toLowerCase()).filter((term) => term.length > 2)
  ).map((term) => new RegExp(String.raw`\b${escape(term)}\b`, "iu"));
  const sourceDate = (statement: Statement) =>
    cx.sourceById.get(statement.sourceId)?.date ?? "";
  const statementIds = ws.statements
    .filter((statement) => isAbout(ws, note, statement))
    .toSorted((a, b) => sourceDate(a).localeCompare(sourceDate(b)))
    .map((statement) => statement.id);
  const mentions = ws.statements
    .filter(
      (statement) =>
        !statementIds.includes(statement.id) &&
        statement.sourceId !== note.id &&
        names.some((name) => name.test(statement.text))
    )
    .map((statement) => quote(statement));
  const processIds = unique(
    workflowIds
      .map((id) => cx.workflowById.get(id)?.processId)
      .filter((id): id is ProcessId => id !== undefined)
  );
  return {
    ...note,
    backlinks: back,
    linked,
    mentions,
    processIds,
    statementIds,
  };
};

export const buildBrain = (ws: Workspace): Brain => {
  const brainSources = ws.sources.filter(inBrain);
  // How the board steers the sprint: the budget for AI and who approves a new tool, each with its history.
  const boardQuestions: BoardQuestion[] = [
    {
      question: t`Monthly budget for AI`,
      answers: ws.vision.budget,
      open: t`Budget for AI set`,
    },
    {
      question: t`Who approves a new tool`,
      answers: ws.vision.toolApproval,
      open: t`Approver for new tools named`,
    },
  ];
  const cx: Context = {
    ws,
    sourceById: new Map(ws.sources.map((source) => [source.id, source])),
    workflowById: new Map(
      ws.workflows.map((workflow) => [workflow.id, workflow])
    ),
    brainSources,
    // Interviews with employees other than a team's stakeholder, one conversation each.
    employeeSources: brainSources.filter(
      (source) => source.interviewee === "employee"
    ),
    drafts: [],
    boardQuestions,
    boardAnswers: boardQuestions.flatMap(({ question, answers }) =>
      changes(answers).map((change) => ({ question, ...change }))
    ),
  };
  const { drafts } = cx;

  drafts.push(
    companyDraft(cx),
    visionDraft(cx),
    ...ws.goals.map((goal) => goalDraft(cx, goal)),
    // Step 2: teams, tools, statements, candidates and gaps. What the client agreed to sits on the source folders' pages.
    ...ws.teams.map((team) => teamDraft(cx, team)),
    ...ws.tools.map((tool) => toolDraft(cx, tool)),
    ...unmentionedApps(ws).map((app) => appDraft(cx, app)),
    // Statements are not notes: each is a highlight in the source it was said in (see transcript.ts).
    ...ws.candidates.map((candidate) => candidateDraft(cx, candidate)),
    ...ws.gaps.map((gap) => gapDraft(cx, gap)),
    ...sourceDrafts(cx)
  );

  // Points that name other notes, now that every note exists.
  const byId = (id: string) => drafts.find((entry) => entry.id === id);
  const vision = byId(VISION);
  if (vision) {
    vision.points = visionPoints(cx);
  }
  for (const team of ws.teams) {
    const draft = byId(team.id);
    if (draft) {
      draft.points = teamPoints(cx, team);
    }
  }
  for (const gap of ws.gaps) {
    const draft = byId(gap.id);
    if (draft) {
      draft.points = gapPoints(cx, gap);
    }
  }

  const ids = new Set(drafts.map((note) => note.id));
  const edges = linkUp(cx, ids);
  const backlinks = new Map<string, string[]>();
  for (const note of drafts) {
    for (const target of note.links) {
      backlinks.set(target, [...(backlinks.get(target) ?? []), note.id]);
    }
  }
  const notes = drafts.map((draft) => finished(cx, ids, backlinks, draft));
  return { notes, edges };
};

/** How many of the latest events a timeline shows in full. */
const RECENT_EVENTS = 5;

/** Older events of one month, folded away on a long timeline. */
export interface TimelineMonth {
  /** ISO month, e.g. "2026-08". */
  month: string;
  events: NoteEvent[];
}

/**
 * A timeline split so a note stays short however much comes in: the latest events in full, the
 * ones before folded by month. A short timeline stays whole, since folding one or two events saves
 * nothing.
 */
export const splitTimeline = (
  events: NoteEvent[],
  recent = RECENT_EVENTS
): { earlier: TimelineMonth[]; recent: NoteEvent[] } => {
  if (events.length <= recent + 2) {
    return { earlier: [], recent: events };
  }
  const cut = events.length - recent;
  const earlier: TimelineMonth[] = [];
  for (const entry of events.slice(0, cut)) {
    const month = entry.date.slice(0, 7);
    const last = earlier.at(-1);
    if (last?.month === month) {
      last.events.push(entry);
    } else {
      earlier.push({ month, events: [entry] });
    }
  }
  return { earlier, recent: events.slice(cut) };
};

/** A folder in the vault: sub-folders first, then notes, like a file explorer. */
export interface Folder {
  /** Its name in the reader's language. */
  name: string;
  /** The folder ids from `Note.path` joined with "/", unique in the vault and the same in every language. */
  key: string;
  /** The note that is the folder itself, like a folder note in Obsidian: 1 Vision is the Vision page. */
  note?: Note;
  folders: Folder[];
  notes: Note[];
}

/** Notes that are their folder rather than a note inside it. */
const folderNoteKinds = new Set<NoteKind>(["vision", "channel"]);

/** The vault as a folder tree. Folders keep the order in which the brain first fills them. */
export const folderTree = (notes: Note[]): Folder => {
  const root: Folder = { name: "", key: "", folders: [], notes: [] };
  for (const note of notes) {
    let folder = root;
    for (const [depth, id] of note.path.entries()) {
      const key = note.path.slice(0, depth + 1).join("/");
      let next = folder.folders.find((candidate) => candidate.key === key);
      if (!next) {
        next = { name: folderName(id), key, folders: [], notes: [] };
        folder.folders.push(next);
      }
      folder = next;
    }
    if (folderNoteKinds.has(note.kind) && folder !== root && !folder.note) {
      folder.note = note;
    } else {
      folder.notes.push(note);
    }
  }
  return root;
};

/** How many notes a folder holds, including its sub-folders and the folder's own note. */
export const countNotes = (folder: Folder): number =>
  (folder.note ? 1 : 0) +
  folder.notes.length +
  folder.folders.reduce((sum, child) => sum + countNotes(child), 0);

/** The brain limited to some notes, with only the edges between them. */
export const subBrain = (
  brain: Brain,
  keep: (note: Note) => boolean
): Brain => {
  const notes = brain.notes.filter(keep);
  const ids = new Set(notes.map((note) => note.id));
  return {
    notes,
    edges: brain.edges.filter(([a, b]) => ids.has(a) && ids.has(b)),
  };
};

/** A run of text, or a note named in it with the words the text used. */
export type MentionPart = string | { id: string; label: string };

/**
 * Splits text where it names one of the given notes, so a page can show those names as links.
 * Matching ignores case and whole words only, prefers the longest title, and links each note the
 * first time it is named: a name repeated in every sentence would read as noise.
 */
export const mentionParts = (
  text: string,
  notes: Pick<Note, "id" | "title">[]
): MentionPart[] => {
  const named = notes
    .filter((note) => note.title.length > 2)
    .toSorted((a, b) => b.title.length - a.title.length);
  if (named.length === 0) {
    return [text];
  }
  const byTitle = new Map(
    named.map((note) => [note.title.toLowerCase(), note.id])
  );
  const pattern = new RegExp(
    String.raw`\b(${named.map((note) => escape(note.title)).join("|")})\b`,
    "giu"
  );
  const parts: MentionPart[] = [];
  const linked = new Set<string>();
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const [found] = match;
    const id = byTitle.get(found.toLowerCase());
    if (id === undefined || linked.has(id)) {
      continue;
    }
    linked.add(id);
    if (match.index > from) {
      parts.push(text.slice(from, match.index));
    }
    parts.push({ id, label: found });
    from = match.index + found.length;
  }
  if (from < text.length) {
    parts.push(text.slice(from));
  }
  return parts;
};

/**
 * Connections worth pointing out, found in the records, not guessed. Facts only, never an order.
 * Two teams that name the same handover, each from their own side: two different sources describe it.
 */
export const sameHandover = (ws: Workspace): [string, string] | undefined => {
  const handovers = new Map<string, Set<string>>();
  for (const statement of ws.statements.filter(
    (candidate) =>
      candidate.kind === "handover" && candidate.teamIds.length === 2
  )) {
    const key = statement.teamIds.toSorted().join("|");
    handovers.set(
      key,
      (handovers.get(key) ?? new Set()).add(statement.sourceId)
    );
  }
  const found = [...handovers.entries()].find(
    ([, sources]) => sources.size > 1
  );
  if (!found) {
    return undefined;
  }
  const [one = "", other = ""] = found[0].split("|");
  return [one, other];
};

export const patterns = (ws: Workspace): string[] => {
  const found: string[] = [];

  const [aiNobodyMentioned] = unmentionedApps(ws)
    .filter((app) => app.ai === "tool")
    .toSorted((a, b) => b.people - a.people);
  if (aiNobodyMentioned) {
    const app = aiNobodyMentioned.name;
    const { people } = aiNobodyMentioned;
    found.push(
      given(aiNobodyMentioned.owner ?? undefined)
        ? plural(people, {
            one: `${app} is used by # person, and nobody mentioned it in an interview.`,
            other: `${app} is used by # people, and nobody mentioned it in an interview.`,
          })
        : plural(people, {
            one: `${app} is used by # person, and nobody mentioned it in an interview. No team owns it.`,
            other: `${app} is used by # people, and nobody mentioned it in an interview. No team owns it.`,
          })
    );
  }

  const bothSides = sameHandover(ws);
  if (bothSides) {
    const [one, other] = bothSides;
    const oneTeam = teamNameIn(ws, one);
    const otherTeam = teamNameIn(ws, other);
    found.push(
      t`${oneTeam} and ${otherTeam} both name the same handover, each from their own side.`
    );
  }

  // Step 2 is done when every invited team is interviewed; a team only mentioned by others is not.
  const waiting = ws.teams.filter(
    (team) =>
      ws.vision.inviteTeamIds.includes(team.id) &&
      interviewsFor(ws, team).length === 0
  );
  if (waiting.length > 0) {
    const count = waiting.length;
    const teams = joinNames(waiting.map((team) => team.name));
    found.push(
      plural(count, {
        one: `# invited team not interviewed yet: ${teams}.`,
        other: `# invited teams not interviewed yet: ${teams}.`,
      })
    );
  }

  const open = ws.gaps.filter((gap) => !given(gap.closedAt));
  const [first] = open;
  if (first) {
    const count = open.length;
    const { question } = first;
    found.push(
      plural(count, {
        one: `# gap still open. First: ${question}`,
        other: `# gaps still open. First: ${question}`,
      })
    );
  }

  return found;
};
