import type { TeamGroup, Workspace } from "@grasp-os/shared/brain";
import { msg, plural, t } from "@lingui/core/macro";

import { formatList } from "../format.ts";
import { brainLinks } from "./brain-links.ts";
import type { BrainLink } from "./brain-links.ts";
import { given, interviewsFor } from "./brain.ts";
import type { Brain, Note } from "./brain.ts";
import { latest } from "./history.ts";

/**
 * The brain as an atlas, as the prototype has it (`lib/brain-atlas.ts`): the company in the
 * brain's six regions. Its groups of teams, as the company names them, fill the four lobes, each
 * team with the work it does. The board, with the vision and its goals, is the frontal lobe, which
 * plans. And the brainstem with its spine is what came in: every conversation, document and
 * connection, through which everything the brain knows arrived. Systems, applications and
 * questions have no region of their own: a question sits beside the team or work it is about.
 *
 * Everything here is a fact derived from the records, as in the rest of the brain: what each region
 * holds, what is still waiting (a note whose own state says "not yet"), and what is still open (a
 * question someone can answer). Nothing is ranked or scored; lists keep the company's order.
 */

export type RegionId =
  | "frontal"
  | "parietal"
  | "temporal"
  | "occipital"
  | "cerebellum"
  | "stem";

/** The regions in the order the brain's dots draw them: front to back and top to bottom, as the brain is seen from its side. */
export const REGION_IDS: RegionId[] = [
  "frontal",
  "parietal",
  "temporal",
  "occipital",
  "cerebellum",
  "stem",
];

/** The lobes that hold the company's groups of teams, in the order the groups fill them. */
export const LOBES: RegionId[] = [
  "parietal",
  "occipital",
  "cerebellum",
  "temporal",
];

/** A team's work sits with the team, in a folder of the region named after it: the folder's path starts with this. */
export const TEAM_FOLDER = "@team";

export interface Region {
  id: RegionId;
  /** Its name: the company's own for a group of teams, the board in front, what came in at the stem. */
  name: string;
  /** What it holds, in one line: the teams in it, or what the front and the stem are for. */
  does: string;
}

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
  /** What it shows: in a lobe, each team and its work in the team's own folder (`TEAM_FOLDER`). */
  notes: Note[];
  /** The group of teams it holds; none in front and at the stem. */
  group?: TeamGroup;
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

/** One end-to-end line of a link (`BrainLink`): from its piece of work to a team it joins, or from team to team when the work has no team. */
export interface Nerve {
  a: string;
  b: string;
  link: BrainLink;
}

export interface Atlas {
  regions: AtlasRegion[];
  /** The links drawn as nerves, confirmed or proposed, each as the lines it runs along. */
  nerves: Nerve[];
  /** Every open item once, in the vault's order: gaps, then teams, then the vision, then tools. */
  open: OpenItem[];
  /** Each note's region; the company has none, as it is the whole brain, and neither have tools and gaps, which sit beside the work. */
  home: Map<string, RegionId>;
}

/** What the front and the stem are called, and what the groups beyond the lobes share. */
const boardName = msg`Board`;
const stemName = msg({
  message: "What came in",
  context: "the brainstem: every conversation, document and connection",
});

/**
 * The company's groups of teams, one for each lobe. The groups it keeps (confirmed, or proposed by
 * Grasp), then one of its own for every team in none, named after it, as Grasp would propose it.
 * More groups than lobes: the last lobe holds the rest together.
 */
export const groupsOf = (ws: Workspace): TeamGroup[] => {
  const known = new Set(ws.teams.map((team) => team.id));
  const kept = ws.teamGroups
    .map((group) => ({
      ...group,
      teamIds: group.teamIds.filter((id) => known.has(id)),
    }))
    .filter((group) => group.teamIds.length > 0);
  const placed = new Set(kept.flatMap((group) => group.teamIds));
  const all = [
    ...kept,
    ...ws.teams
      .filter((team) => !placed.has(team.id))
      .map((team): TeamGroup => ({
        id: `group-${team.id}`,
        name: team.name,
        teamIds: [team.id],
        confirmed: false,
      })),
  ];
  if (all.length <= LOBES.length) {
    return all;
  }
  const rest = all.slice(LOBES.length - 1);
  return [
    ...all.slice(0, LOBES.length - 1),
    {
      id: "group-more",
      name: t`More teams`,
      teamIds: rest.flatMap((group) => group.teamIds),
      confirmed: rest.every((group) => group.confirmed),
    },
  ];
};

/** The team a piece of work belongs to: its workflow's main team, else the first team that told of it. */
export const teamOfWork = (ws: Workspace, note: Note): string | undefined => {
  const candidate = ws.candidates.find((each) => each.id === note.id);
  const workflow =
    candidate?.workflowId === undefined
      ? undefined
      : ws.workflows.find((each) => each.id === candidate.workflowId);
  return (
    workflow?.teamId ??
    note.links.find((id) => ws.teams.some((team) => team.id === id))
  );
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

/** What is known in each region, in a fact or two. What is still waiting is said apart, by `waitingLabelOf`. */
const factsOf = (region: RegionId, ws: Workspace, notes: Note[]): string[] => {
  const having = (kind: Note["kind"]) =>
    notes.filter((note) => note.kind === kind).length;
  if (region === "frontal") {
    const goals = having("goal");
    return [
      plural(goals, { one: "# goal", other: "# goals" }),
      given(ws.vision.confirmedAt)
        ? t`Confirmed by the board`
        : t`Not confirmed by the board yet`,
    ];
  }
  if (region === "stem") {
    return sourceFacts(ws, notes);
  }
  const teams = having("team");
  const work = having("candidate");
  return teams === 0
    ? []
    : [
        plural(teams, { one: "# team", other: "# teams" }),
        plural(work, { one: "# piece of work", other: "# pieces of work" }),
      ];
};

/** The region a note lives in, and the team whose folder it sits in when it is in a lobe. */
const placeOf = (
  ws: Workspace,
  note: Note,
  lobeOfTeam: ReadonlyMap<string, RegionId>
): { region?: RegionId; team?: string } => {
  if (note.kind === "vision" || note.kind === "goal") {
    return { region: "frontal" };
  }
  if (note.kind === "source" || note.kind === "channel") {
    return { region: "stem" };
  }
  let team: string | undefined;
  if (note.kind === "team") {
    team = note.id;
  } else if (note.kind === "candidate") {
    team = teamOfWork(ws, note);
  }
  const lobe = team === undefined ? undefined : lobeOfTeam.get(team);
  return lobe === undefined ? {} : { region: lobe, team };
};

/** What a region is called, and what it holds in a line. */
const nameOf = (
  id: RegionId,
  group: TeamGroup | undefined,
  ws: Workspace
): Region => {
  if (id === "frontal") {
    return { id, name: t(boardName), does: t`Plans and goals` };
  }
  if (id === "stem") {
    return {
      id,
      name: t(stemName),
      does: t`What was heard, written and connected`,
    };
  }
  const teams = (group?.teamIds ?? []).map(
    (team) => ws.teams.find((each) => each.id === team)?.name ?? team
  );
  return { id, name: group?.name ?? "", does: formatList(teams) };
};

export const atlasOf = (ws: Workspace, brain: Brain): Atlas => {
  const byId = new Map(brain.notes.map((note) => [note.id, note]));
  const groups = groupsOf(ws);
  const lobeOfTeam = new Map(
    groups.flatMap((group, index) => {
      const lobe = LOBES[index];
      return lobe === undefined
        ? []
        : group.teamIds.map((id) => [id, lobe] as const);
    })
  );
  // Each note's region, and the team whose folder it sits in when it is in a lobe.
  const home = new Map<string, RegionId>();
  const teamOf = new Map<string, string>();
  for (const note of brain.notes) {
    const { region, team } = placeOf(ws, note, lobeOfTeam);
    if (region === undefined) {
      continue;
    }
    home.set(note.id, region);
    if (team !== undefined) {
      teamOf.set(note.id, team);
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
    open.push({
      id: gap.id,
      noteId: gap.id,
      subjects,
      // Beside what it is about, and with the source it was noticed in.
      regions: regionsOf([...subjects, gap.sourceId]),
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
      regions: regionsOf([team.id]),
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
        regions: ["frontal"],
        question: t`The monthly budget for AI is not set yet.`,
        who: board,
      });
    }
    if (ws.vision.toolApproval.length === 0) {
      open.push({
        id: "vision:approval",
        noteId: "vision",
        subjects: ["vision"],
        regions: ["frontal"],
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
      regions: regionsOf(
        ws.tools.find((tool) => tool.id === note.id)?.teamIds ?? []
      ),
      question: t`${name} is named, but not seen in use yet.`,
    });
  }

  const regions = REGION_IDS.map((id): AtlasRegion => {
    const index = LOBES.indexOf(id);
    const group = index === -1 ? undefined : groups[index];
    // In a lobe each team is a folder of its own, its work in it: the team's note names the folder.
    const notes = brain.notes
      .filter((note) => home.get(note.id) === id)
      .map((note) => {
        const team = teamOf.get(note.id);
        return team === undefined
          ? note
          : { ...note, path: [TEAM_FOLDER, team] };
      });
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
      if (a === id) {
        links[b] = (links[b] ?? 0) + 1;
      }
      if (b === id) {
        links[a] = (links[a] ?? 0) + 1;
      }
    }
    return {
      ...nameOf(id, group, ws),
      ...(group === undefined ? {} : { group }),
      notes,
      facts: factsOf(id, ws, notes),
      waiting,
      waitingLabel: waitingLabelOf(notes, counted),
      open: open.filter((item) => item.regions.includes(id)),
      links,
    };
  });
  // A link runs from its piece of work to each other team it joins: the work sits in its own team's folder already.
  const nerves = brainLinks(ws).flatMap((link): Nerve[] => {
    const own = teamOf.get(link.work);
    if (own !== undefined) {
      return link.teams
        .filter((team) => team !== own)
        .map((team) => ({ a: link.work, b: team, link }));
    }
    return link.teams.slice(1).flatMap((team, index) => {
      const from = link.teams[index];
      return from === undefined ? [] : [{ a: from, b: team, link }];
    });
  });
  return { regions, open, home, nerves };
};

/**
 * The way each statement runs through the brain, as the regions it passes: from the source that
 * heard it, up the spine from the stem, to the teams it is about and the work it belongs to. What
 * the brain fires when it is seen whole: every pulse is something somebody said.
 */
export const signalPaths = (ws: Workspace, atlas: Atlas): RegionId[][] => {
  const paths: RegionId[][] = [];
  for (const statement of ws.statements) {
    const stops = [
      statement.sourceId,
      ...statement.teamIds,
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
  return paths;
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

/** A group of teams: who is in it, the work they do, and what is not known yet. */
const groupStory = (
  ws: Workspace,
  region: AtlasRegion,
  ids: Ids,
  line: Line
): void => {
  const teams = ids((note) => note.kind === "team");
  if (teams.length === 0) {
    return;
  }
  const names = formatList(
    region.notes
      .filter((note) => note.kind === "team")
      .map((note) => note.title)
  );
  const work = ids((note) => note.kind === "candidate");
  const count = work.length;
  line(
    count === 0
      ? t`${names} work here. No work of theirs came up yet.`
      : plural(count, {
          one: `${names} work here, on # piece of work that came up in what people said.`,
          other: `${names} work here, on # pieces of work that came up in what people said.`,
        }),
    [...teams, ...work]
  );
  const drawn = ids(
    (note) => note.kind === "candidate" && note.tags.includes("drawn")
  );
  const done = drawn.length;
  if (done > 0) {
    line(
      plural(done, {
        one: "# of them is drawn.",
        other: "# of them are drawn.",
      }),
      drawn
    );
  }
  const waiting = region.waiting.filter((id) => teams.includes(id));
  const left = waiting.length;
  if (left > 0) {
    line(
      plural(left, {
        one: "# team here is not interviewed yet.",
        other: "# teams here are not interviewed yet.",
      }),
      waiting
    );
  }
  // Told from both sides, by the rule the brain's nerves follow (brain-links.ts), so the story never says it while its nerve is still only proposed.
  const both = brainLinks(ws).find(
    (link) => link.kind === "handover" && link.bothSides
  )?.teams;
  if (both?.some((id) => teams.includes(id)) === true) {
    const [one = "", other = ""] = both.map(
      (id) => ws.teams.find((team) => team.id === id)?.name ?? id
    );
    line(
      t`${one} and ${other} both name the same handover, each from their own side.`,
      both.filter((id) => teams.includes(id))
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
  if (regionId === "frontal") {
    visionStory(ws, ids, line);
  } else if (regionId === "stem") {
    sourcesStory(ws, region, ids, line);
  } else {
    groupStory(ws, region, ids, line);
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
