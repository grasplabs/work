import type { MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";

import { formatNumber } from "../format.ts";
import {
  given,
  groupLabel,
  interviewsFor,
  sameHandover,
  unmentionedApps,
} from "./brain.ts";
import type { Brain, Note } from "./brain.ts";
import { latest } from "./history.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The brain as an atlas: the same notes as the vault, in the same six parts as its navigation,
 * each in the part of a brain whose job matches what it holds. The vision is the frontal lobe,
 * which plans; the teams the parietal, the body's map of who does what; the gaps the temporal,
 * where memory has its holes; tools and applications the occipital, which sees; the workflows
 * the cerebellum, which runs routines; and the sources (every conversation, document and
 * connection) the brainstem and its spine, through which everything the brain knows came in.
 *
 * Everything here is a fact derived from the records, as in the rest of the brain: what each part
 * holds, what is still waiting (a note whose own state says "not yet"), and what is still open (a
 * question someone can answer). Nothing is ranked or scored; lists keep the vault's order.
 */

export type RegionId =
  | "vision"
  | "teams"
  | "sources"
  | "tools"
  | "workflows"
  | "gaps";

export interface Region {
  id: RegionId;
  /** What the part holds, as the reader knows it. */
  label: MessageDescriptor;
  /** What that part of a brain does, and so why it holds this. */
  does: MessageDescriptor;
}

/** The regions, front to back and top to bottom, as the brain is seen from its side. */
export const REGIONS: Region[] = [
  // The frontal lobe, the parietal, the temporal, the occipital, the cerebellum, and the stem with its spine. Named as the navigation names its parts.
  { id: "vision", label: groupLabel.vision, does: msg`Plans and goals` },
  { id: "teams", label: groupLabel.teams, does: msg`Who does what` },
  { id: "gaps", label: groupLabel.gaps, does: msg`What is still unknown` },
  { id: "tools", label: groupLabel.tools, does: msg`What is seen in use` },
  {
    id: "workflows",
    label: groupLabel.candidates,
    does: msg`Work that could be automated`,
  },
  {
    id: "sources",
    label: groupLabel.sources,
    does: msg`What was heard, written and connected`,
  },
];

export const REGION_IDS: RegionId[] = REGIONS.map((region) => region.id);

export const isRegion = (value: unknown): value is RegionId =>
  typeof value === "string" && REGION_IDS.some((id) => id === value);

/** Something still open that someone can answer, and where it shows. */
export interface OpenItem {
  id: string;
  /** The note to go to: the gap itself, or the team or tool or vision it is about. */
  noteId: string;
  /** The notes it sits beside. */
  subjects: string[];
  regions: RegionId[];
  /** What is missing, in plain words. */
  question: string;
  /** Who can answer it, as a role. */
  who?: string;
  /** Since when, as an ISO date. */
  since?: string;
}

export interface AtlasRegion extends Region {
  notes: Note[];
  /** What is known in it, in a short fact or two. */
  facts: string[];
  /** Notes whose own state says "not yet": seen but never named, invited but not interviewed. */
  waiting: string[];
  /** The waiting, said as a fact, when there is any. */
  waitingLabel?: string;
  open: OpenItem[];
  /** How many links run from this region to each other one. */
  links: Partial<Record<RegionId, number>>;
}

export interface Atlas {
  regions: AtlasRegion[];
  /** Every open item once, in the vault's order: gaps, then teams, then the vision, then tools. */
  open: OpenItem[];
  /** Each note's region; the company has none, as it is the whole brain. */
  home: Map<string, RegionId>;
}

/** The region a note lives in, by its kind. */
const regionOfKind = (note: Note): RegionId | undefined => {
  switch (note.kind) {
    case "vision":
    case "goal": {
      return "vision";
    }
    case "team": {
      return "teams";
    }
    case "tool":
    case "app": {
      return "tools";
    }
    case "candidate": {
      return "workflows";
    }
    case "source":
    case "channel": {
      return "sources";
    }
    case "gap": {
      return "gaps";
    }
    case "company":
    case "statement": {
      return undefined;
    }
    default: {
      return note.kind satisfies never;
    }
  }
};

/** Waiting, from the tags the brain already writes. */
const WAITING_TAGS = ["not-interviewed", "never-mentioned", "reported"];

/** The waiting in a region, said as facts: each kind of "not yet" on its own. */
const waitingLabelOf = (notes: Note[], total: number): string | undefined => {
  const tagged = (tag: string) =>
    notes.filter((note) => note.tags.includes(tag)).length;
  const uninterviewed = tagged("not-interviewed");
  const unnamed = tagged("never-mentioned");
  const unseen = tagged("reported");
  const said = [
    uninterviewed > 0
      ? t`${uninterviewed} of ${total} not interviewed yet`
      : "",
    unnamed > 0 ? t`${unnamed} of ${total} seen in use, never named` : "",
    unseen > 0 ? t`${unseen} of ${total} named, not seen in use` : "",
  ].filter(Boolean);
  return said.length > 0 ? said.join(" · ") : undefined;
};

/** What is known in the sources: conversations, documents and the connections that came in. */
const sourceFacts = (ws: Workspace, notes: Note[]): string[] => {
  const conversations = notes.filter(
    (note) => note.kind === "source" && note.path[1] === "Conversations"
  ).length;
  const documents = notes.filter(
    (note) => note.kind === "source" && note.path[1] === "Documents"
  ).length;
  const has = (connection: "directory" | "signIn" | "pulse") =>
    ws.sources.some(
      (source) =>
        source.connection === connection &&
        notes.some((note) => note.id === source.id)
    );
  const connected = [
    has("directory") ? t`Directory` : "",
    has("signIn") ? t`Sign-in` : "",
    has("pulse") ? t`Pulse` : "",
  ].filter(Boolean);
  return [
    plural(conversations, {
      one: "# conversation",
      other: "# conversations",
    }),
    plural(documents, { one: "# document", other: "# documents" }),
    connected.join(" · "),
  ].filter(Boolean);
};

/** What is known in each part, in a fact or two. What is still waiting is said apart, by `waitingLabelOf`. */
const factsOf = (region: RegionId, ws: Workspace, notes: Note[]): string[] => {
  const having = (kind: Note["kind"]) =>
    notes.filter((note) => note.kind === kind).length;
  switch (region) {
    case "vision": {
      const goals = having("goal");
      return [
        plural(goals, { one: "# goal", other: "# goals" }),
        given(ws.vision.confirmedAt)
          ? t`Confirmed by the board`
          : t`Not confirmed by the board yet`,
      ];
    }
    case "teams": {
      const teams = having("team");
      const interviewed = ws.teams.filter(
        (team) => interviewsFor(ws, team).length > 0
      ).length;
      return [
        plural(teams, { one: "# team", other: "# teams" }),
        interviewed === teams
          ? t`All interviewed`
          : t`${interviewed} of ${teams} interviewed`,
      ];
    }
    case "sources": {
      return sourceFacts(ws, notes);
    }
    case "tools": {
      // The applications nobody named are not known yet: they are what is still waiting.
      const named = having("tool");
      return [
        plural(named, {
          one: "# tool named in the interviews",
          other: "# tools named in the interviews",
        }),
      ];
    }
    case "workflows": {
      const workflows = having("candidate");
      const drawn = notes.filter(
        (note) => note.kind === "candidate" && note.tags.includes("drawn")
      ).length;
      return [
        plural(workflows, { one: "# workflow", other: "# workflows" }),
        t`${drawn} drawn in the builder`,
      ];
    }
    case "gaps": {
      const gaps = notes.filter((note) => note.kind === "gap");
      const open = gaps.filter((note) => note.tags.includes("open")).length;
      const answered = gaps.length - open;
      return [t`${open} still open`, t`${answered} answered`];
    }
    default: {
      return region satisfies never;
    }
  }
};

export const atlasOf = (ws: Workspace, brain: Brain): Atlas => {
  const byId = new Map(brain.notes.map((note) => [note.id, note]));
  const home = new Map<string, RegionId>();
  for (const note of brain.notes) {
    const region = regionOfKind(note);
    if (region) {
      home.set(note.id, region);
    }
  }
  // What a gap is about, among the notes: a quote it points at is not a subject, only where it was said.
  const subjectsOf = (about: string[]) =>
    about.filter((id) => byId.has(id) && byId.get(id)?.kind !== "source");
  const sourceDate = (id: string) =>
    ws.sources.find((source) => source.id === id)?.date;

  const open: OpenItem[] = [];
  const regionsOf = (ids: string[]) => [
    ...new Set(
      ids
        .map((id) => home.get(id))
        .filter((region): region is RegionId => Boolean(region))
    ),
  ];
  for (const gap of ws.gaps.filter(
    (each) => !given(each.closedAt) && byId.has(each.id)
  )) {
    const subjects = subjectsOf(gap.about);
    const where = regionsOf(subjects);
    open.push({
      id: gap.id,
      noteId: gap.id,
      subjects,
      // Among the gaps, beside what it is about, and with the source it was noticed in.
      regions: [
        ...new Set<RegionId>(["gaps", ...where, ...regionsOf([gap.sourceId])]),
      ],
      question: gap.question,
      who: gap.owner,
      since: sourceDate(gap.sourceId),
    });
  }
  for (const team of ws.teams) {
    if (
      !ws.vision.inviteTeamIds.includes(team.id) ||
      interviewsFor(ws, team).length > 0 ||
      !byId.has(team.id)
    ) {
      continue;
    }
    const { name } = team;
    open.push({
      id: `${team.id}:interview`,
      noteId: team.id,
      subjects: [team.id],
      regions: ["teams"],
      question: t`${name} is invited but not interviewed yet.`,
      who: latest(team.stakeholders)?.role,
    });
  }
  // The board's own questions, unless a gap already asks about the vision.
  if (
    !open.some((item) => item.subjects.includes("vision")) &&
    byId.has("vision")
  ) {
    const board = t`The board`;
    if (ws.vision.budget.length === 0) {
      open.push({
        id: "vision:budget",
        noteId: "vision",
        subjects: ["vision"],
        regions: ["vision"],
        question: t`The monthly budget for AI is not set yet.`,
        who: board,
      });
    }
    if (ws.vision.toolApproval.length === 0) {
      open.push({
        id: "vision:approval",
        noteId: "vision",
        subjects: ["vision"],
        regions: ["vision"],
        question: t`Nobody is named yet to approve a new tool.`,
        who: board,
      });
    }
  }
  for (const note of brain.notes.filter(
    (each) => each.kind === "tool" && each.tags.includes("reported")
  )) {
    const name = note.title;
    open.push({
      id: `${note.id}:seen`,
      noteId: note.id,
      subjects: [note.id],
      regions: ["tools"],
      question: t`${name} is named, but not seen in use yet.`,
    });
  }

  const regions = REGIONS.map((region): AtlasRegion => {
    const notes = brain.notes.filter((note) => home.get(note.id) === region.id);
    const waiting = notes
      .filter(
        (note) =>
          WAITING_TAGS.some((tag) => note.tags.includes(tag)) &&
          note.kind !== "gap"
      )
      .map((note) => note.id);
    const counted = notes.filter(
      (note) => note.kind !== "gap" && note.kind !== "channel"
    ).length;
    const links: Partial<Record<RegionId, number>> = {};
    for (const [from, to] of brain.edges) {
      const a = home.get(from);
      const b = home.get(to);
      if (!a || !b || a === b) {
        continue;
      }
      if (a === region.id) {
        links[b] = (links[b] ?? 0) + 1;
      }
      if (b === region.id) {
        links[a] = (links[a] ?? 0) + 1;
      }
    }
    return {
      ...region,
      notes,
      facts: factsOf(region.id, ws, notes),
      waiting,
      waitingLabel: waitingLabelOf(notes, counted),
      open: open.filter((item) => item.regions.includes(region.id)),
      links,
    };
  });
  return { regions, open, home };
};

/**
 * The way each statement runs through the brain, as the regions it passes: from the source that
 * heard it, to the team it is about, the tool it names and the workflow it belongs to. What the
 * brain fires when it is seen whole: every pulse is something somebody said, coming up the spine
 * from the sources in the stem. And between them, what is still unknown: from the gaps to each
 * region they are about.
 */
export const signalPaths = (ws: Workspace, atlas: Atlas): RegionId[][] => {
  const paths: RegionId[][] = [];
  for (const statement of ws.statements) {
    const stops = [
      statement.sourceId,
      ...statement.teamIds,
      ...statement.toolIds,
      statement.candidateId ?? "",
    ];
    const path: RegionId[] = [];
    for (const stop of stops) {
      const region = atlas.home.get(stop);
      if (region && path.at(-1) !== region) {
        path.push(region);
      }
    }
    if (path.length >= 2) {
      paths.push(path);
    }
  }
  const links =
    atlas.regions.find((region) => region.id === "gaps")?.links ?? {};
  const wired = REGION_IDS.filter((id) => (links[id] ?? 0) > 0).map(
    (id): RegionId[] => ["gaps", id]
  );
  if (wired.length === 0) {
    return paths;
  }
  // One of them after every third statement, each in turn.
  return paths.flatMap((path, index) => {
    const gap = wired[Math.floor(index / 3) % wired.length];
    return index % 3 === 2 && gap ? [path, gap] : [path];
  });
};

/** One line of a story, and the notes it lights up. */
export interface StoryLine {
  text: string;
  notes: string[];
}

type Line = (text: string, notes: string[]) => void;
type Ids = (match: (note: Note) => boolean) => string[];

const visionStory = (ws: Workspace, ids: Ids, line: Line): void => {
  const goals = ids((note) => note.kind === "goal");
  const count = goals.length;
  line(
    plural(count, {
      one: "The board set # goal for the sprint.",
      other: "The board set # goals for the sprint.",
    }),
    goals
  );
  const changed = ids(
    (note) => note.kind === "goal" && note.tags.includes("changed")
  );
  const moved = changed.length;
  if (moved > 0) {
    line(
      plural(moved, {
        one: "# of them changed after it was set, at a later talk with the board.",
        other:
          "# of them changed after they were set, at later talks with the board.",
      }),
      changed
    );
  }
  line(
    given(ws.vision.confirmedAt)
      ? t`The board confirmed the vision.`
      : t`The board has not confirmed the vision yet.`,
    ["vision"]
  );
};

const teamsStory = (
  ws: Workspace,
  region: AtlasRegion,
  ids: Ids,
  line: Line
): void => {
  const teams = ids((note) => note.kind === "team");
  const count = teams.length;
  line(
    plural(count, {
      one: "# team is in the brain, from the directory.",
      other: "# teams are in the brain, from the directory.",
    }),
    teams
  );
  const { waiting } = region;
  const left = waiting.length;
  line(
    left === 0
      ? t`Every one of them is interviewed.`
      : plural(left, {
          one: "# of them is not interviewed yet.",
          other: "# of them are not interviewed yet.",
        }),
    left === 0 ? teams : waiting
  );
  const employees = ws.sources.filter(
    (source) => source.interviewee === "employee"
  ).length;
  if (employees > 0) {
    const spoken = teams.filter((id) =>
      ws.sources.some(
        (source) =>
          source.interviewee === "employee" &&
          source.teamIds?.includes(id) === true
      )
    );
    line(
      plural(employees, {
        one: "# employee answered as well, by voice or chat.",
        other: "# employees answered as well, by voice or chat.",
      }),
      spoken.length > 0 ? spoken : teams
    );
  }
  const both = sameHandover(ws);
  if (both) {
    const nameOf = (id: string) =>
      ws.teams.find((team) => team.id === id)?.name ?? id;
    const one = nameOf(both[0]);
    const other = nameOf(both[1]);
    line(
      t`${one} and ${other} both name the same handover, each from their own side.`,
      both
    );
  }
};

const sourcesStory = (
  ws: Workspace,
  region: AtlasRegion,
  ids: Ids,
  line: Line
): void => {
  const conversations = ids(
    (note) => note.kind === "source" && note.path[1] === "Conversations"
  );
  const count = conversations.length;
  line(
    plural(count, {
      one: "# conversation came in: with the board, the teams and their people.",
      other:
        "# conversations came in: with the board, the teams and their people.",
    }),
    conversations
  );
  const statements = ws.statements.length;
  line(
    plural(statements, {
      one: "They brought # statement, each one tagged and kept with its source.",
      other:
        "They brought # statements, each one tagged and kept with its source.",
    }),
    conversations
  );
  const inRegion = (id: string) => region.notes.some((note) => note.id === id);
  const sinks = ws.statements.filter(
    (statement) => statement.kind === "timeSink"
  );
  const sunk = sinks.length;
  if (sunk > 0) {
    line(
      plural(sunk, {
        one: "# of them is a time waster, as the team said it.",
        other: "# of them are time wasters, as the teams said them.",
      }),
      [...new Set(sinks.map((statement) => statement.sourceId))].filter(
        inRegion
      )
    );
  }
  const documents = ids(
    (note) => note.kind === "source" && note.path[1] === "Documents"
  );
  const shared = documents.length;
  if (shared > 0) {
    line(
      plural(shared, {
        one: "# document was shared or found, and read.",
        other: "# documents were shared or found, and read.",
      }),
      documents
    );
  }
  const of = (connection: "directory" | "signIn" | "pulse") =>
    ws.sources
      .filter((source) => source.connection === connection)
      .map((source) => source.id)
      .filter(inRegion);
  const directory = of("directory");
  if (directory.length > 0) {
    line(t`The directory brought in the teams and their roles.`, directory);
  }
  const signIn = of("signIn");
  if (signIn.length > 0) {
    line(t`Sign-in shows the applications people log in to.`, signIn);
  }
  const pulse = of("pulse");
  if (pulse.length > 0) {
    line(t`Pulse shows what runs on the laptops, AI tools included.`, pulse);
  }
};

const toolsStory = (ws: Workspace, ids: Ids, line: Line): void => {
  const tools = ids((note) => note.kind === "tool");
  const named = tools.length;
  line(
    plural(named, {
      one: "# tool was named in the interviews.",
      other: "# tools were named in the interviews.",
    }),
    tools
  );
  const apps = ids((note) => note.kind === "app");
  const unnamed = apps.length;
  if (unnamed > 0) {
    line(
      plural(unnamed, {
        one: "# more application is in use that nobody named.",
        other: "# more applications are in use that nobody named.",
      }),
      apps
    );
  }
  const [biggest] = unmentionedApps(ws)
    .filter((app) => app.ai === "tool")
    .toSorted((a, b) => b.people - a.people);
  if (biggest) {
    const { name } = biggest;
    const people = formatNumber(biggest.people);
    line(
      t`The most used AI tool nobody mentioned is ${name}, used by ${people} people.`,
      [`app-${biggest.id}`]
    );
  }
};

const workflowsStory = (ids: Ids, line: Line): void => {
  const workflows = ids((note) => note.kind === "candidate");
  const count = workflows.length;
  line(
    plural(count, {
      one: "# piece of time-consuming work came up in what people said.",
      other: "# pieces of time-consuming work came up in what people said.",
    }),
    workflows
  );
  const drawn = ids(
    (note) => note.kind === "candidate" && note.tags.includes("drawn")
  );
  const done = drawn.length;
  if (done > 0) {
    line(
      plural(done, {
        one: "# of them is drawn in the builder.",
        other: "# of them are drawn in the builder.",
      }),
      drawn
    );
  }
  const waiting = ids(
    (note) => note.kind === "candidate" && note.tags.includes("not-drawn")
  );
  const left = waiting.length;
  if (left > 0) {
    line(
      plural(left, {
        one: "# is not drawn yet.",
        other: "# are not drawn yet.",
      }),
      waiting
    );
  }
};

const gapsStory = (ids: Ids, line: Line): void => {
  const open = ids((note) => note.kind === "gap" && note.tags.includes("open"));
  const asked = open.length;
  line(
    plural(asked, {
      one: "# question is still open, each with who can answer it.",
      other: "# questions are still open, each with who can answer it.",
    }),
    open
  );
  const answered = ids(
    (note) => note.kind === "gap" && note.tags.includes("closed")
  );
  const done = answered.length;
  if (done > 0) {
    line(
      plural(done, {
        one: "# question is answered, by the person who knew.",
        other: "# questions are answered, by the people who knew.",
      }),
      answered
    );
  }
};

/**
 * What a region tells when you go in: three to five lines, each lighting up the notes it is about,
 * in a fixed order, ending with what is still open.
 */
export const storyOf = (
  regionId: RegionId,
  atlas: Atlas,
  ws: Workspace
): StoryLine[] => {
  const region = atlas.regions.find((each) => each.id === regionId);
  if (!region) {
    return [];
  }
  const ids: Ids = (match) => region.notes.filter(match).map((note) => note.id);
  const lines: StoryLine[] = [];
  const line: Line = (text, notes) => {
    lines.push({ text, notes });
  };
  switch (regionId) {
    case "vision": {
      visionStory(ws, ids, line);
      break;
    }
    case "teams": {
      teamsStory(ws, region, ids, line);
      break;
    }
    case "sources": {
      sourcesStory(ws, region, ids, line);
      break;
    }
    case "tools": {
      toolsStory(ws, ids, line);
      break;
    }
    case "workflows": {
      workflowsStory(ids, line);
      break;
    }
    case "gaps": {
      gapsStory(ids, line);
      break;
    }
    default: {
      regionId satisfies never;
    }
  }
  for (const item of region.open) {
    const { question, who } = item;
    line(
      given(who)
        ? t`Still open: ${question} ${who} can answer it.`
        : t`Still open: ${question}`,
      [item.noteId, ...item.subjects]
    );
  }
  return lines;
};
