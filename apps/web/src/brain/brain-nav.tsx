import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { usePageSidebarFold } from "../frame/page-sidebar.tsx";
import { Button } from "../grasp/button/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import {
  Brain as BrainMark,
  Chart,
  ChevronDown,
  ChevronRight,
  Company,
  Folder as FolderMark,
  Icon,
  Inbox,
  Note as NoteMark,
  People,
  Rocket,
  SidebarToggle,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../grasp/tooltip/index.ts";
import { LOBES, TEAM_FOLDER } from "./brain-atlas.ts";
import type { Atlas, AtlasRegion, RegionId } from "./brain-atlas.ts";
import { findFolder } from "./brain-sections.ts";
import { countNotes, folderTree, groupOf } from "./brain.ts";
import type { Brain, Folder, Group as NoteGroup, Note } from "./brain.ts";
import { RegionMenu, RegionRename, TeamMenu } from "./region-edit.tsx";

// The brain's navigation, as the prototype has it (`components/brain-nav.tsx`):
// the brain's regions, not the Playbook's six parts, which keep their own
// pages (/brain/sections) for whoever links to them.

/** Where the parts and folders the reader opened are kept, so a reload shows them as they were. */
const opened = "grasp.brain.open";

// The folder keys the reader left open, or none where there are none yet or storage is refused.
const readOpened = (): Set<string> => {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(opened) ?? "[]");
    return new Set(
      Array.isArray(kept)
        ? kept.filter((key): key is string => typeof key === "string")
        : []
    );
  } catch {
    return new Set();
  }
};

const saveOpened = (open: Set<string>): void => {
  try {
    localStorage.setItem(opened, JSON.stringify([...open]));
  } catch {
    // See `readOpened`.
  }
};

/** The set with the key added when it was missing, removed when it was there. */
const flip = (previous: Set<string>, key: string): Set<string> => {
  const next = new Set(previous);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};

/** The folder keys on the way to a note, so its section and sub-folders can open. */
const pathKeys = (note: Note): string[] =>
  note.path.map((_, depth) => note.path.slice(0, depth + 1).join("/"));

const PHONE = media.belowTablet;
const HOVER = media.hover;
const REDUCED = media.reduced;

// The room between the rows of a list.
const ROW_GAP = `calc(${grasp.space1} / 2)`;

/**
 * Each kind of note's dot, in the brain's own hue for its group, the same as the atlas and a
 * note's page draw it (brain-colors.ts): those hues are the brain's, not the theme's.
 */
const dots = stylex.create({
  company: { backgroundColor: grasp.ink },
  vision: { backgroundColor: "var(--graph-vision)" },
  teams: { backgroundColor: "var(--graph-teams)" },
  tools: { backgroundColor: "var(--graph-tools)" },
  statements: { backgroundColor: "var(--graph-statements)" },
  candidates: { backgroundColor: "var(--graph-candidates)" },
  // A gap is hollow, and so is an application nobody named.
  gaps: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: "var(--graph-gaps)",
  },
  app: {
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: "var(--graph-tools)",
  },
  sources: { backgroundColor: "var(--graph-sources)" },
});

const dotOf = (note: Note): keyof typeof dots =>
  note.kind === "app" ? "app" : (groupOf[note.kind] satisfies NoteGroup);

const styles = stylex.create({
  // The column beside the page: open, or folded to a rail of icons. On a phone neither shows.
  aside: {
    display: { default: "flex", [PHONE]: "none" },
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.sidebarWidth,
    minHeight: 0,
    overflow: "hidden",
    borderInlineEndWidth: grasp.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: grasp.line,
    transitionProperty: { default: "width", [REDUCED]: "none" },
    transitionDuration: grasp.durationUi,
    transitionTimingFunction: grasp.ease,
  },
  folded: { width: grasp.sidebarRail },
  rail: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: grasp.space1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: grasp.space3,
  },
  railLine: { width: grasp.space6, marginBlock: grasp.space1 },
  // The home, with the way to fold the navigation beside it.
  top: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.space3,
    paddingTop: grasp.space3,
  },
  topFirst: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  // What the open navigation holds under its top row; it scrolls on its own.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: ROW_GAP,
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: grasp.space3,
    paddingTop: ROW_GAP,
    paddingBottom: grasp.space3,
  },
  line: { marginBlock: grasp.space2 },
  // A row of the list: an icon or a dot, the name, what it counts and its controls.
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: grasp.treeRow,
    minWidth: 0,
    paddingInline: grasp.treeRowInset,
    borderRadius: grasp.treeRowCorner,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.treeFillHover },
    },
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // A note: in the quieter ink, its group's in full colour.
  note: { color: grasp.muted },
  // The page that is open.
  current: {
    backgroundColor: grasp.treeFillCurrent,
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
  },
  // A row whose name is a link of its own, with its controls beside it.
  holder: { paddingInlineEnd: 0 },
  // The name, as a link or a button that takes the row's room.
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexGrow: 1,
    minWidth: 0,
    minHeight: grasp.treeRow,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
    textAlign: "start",
    textDecoration: "none",
    cursor: "pointer",
  },
  nameCurrent: { fontWeight: grasp.weightMedium },
  words: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  mark: { display: "flex", flexShrink: 0, color: grasp.muted },
  markCurrent: { color: grasp.ink },
  // The dot of a note, in a box as wide as the space a mark takes.
  dotBox: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.space3,
    height: grasp.space3,
  },
  dot: {
    boxSizing: "border-box",
    width: grasp.frameDot,
    height: grasp.frameDot,
    borderRadius: grasp.cornerCircle,
  },
  count: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: ROW_GAP,
    paddingTop: grasp.space1,
  },
  region: { display: "flex", flexDirection: "column" },
  // What a region holds, along its one guide line.
  guide: {
    display: "flex",
    flexDirection: "column",
    gap: ROW_GAP,
    marginBlock: grasp.space1,
    marginInlineStart: grasp.space4,
    paddingInlineStart: grasp.space2,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
});

/** An icon in a row: quiet, and in ink on the page that is open. */
const RowMark = ({ icon, current }: { icon: IconData; current: boolean }) => (
  <span {...stylex.props(styles.mark, current && styles.markCurrent)}>
    <Icon icon={icon} />
  </span>
);

/** The words of a row, on one line, cut where the row ends. */
const RowWords = ({ children }: { children: ReactNode }) => (
  <span {...stylex.props(styles.words)}>{children}</span>
);

/** What a row counts, small and quiet. */
const RowCount = ({ value }: { value: number }) => (
  <span {...stylex.props(styles.count)}>
    <Text element="span" size="xs" tone="quiet">
      {value}
    </Text>
  </span>
);

/** The arrow that opens and closes what a row holds. */
const RowToggle = ({
  expanded,
  name,
  onToggle,
}: {
  expanded: boolean;
  name: string;
  onToggle: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-expanded={expanded}
      aria-label={expanded ? t`Close ${name}` : t`Open ${name}`}
      icon={expanded ? ChevronDown : ChevronRight}
      onClick={onToggle}
      size="xs"
      variant="ghost"
    />
  );
};

/** Whether a note's own page is the one open. */
const useNoteOpen = (noteId: string | undefined): boolean => {
  const matchRoute = useMatchRoute();
  return (
    noteId !== undefined &&
    Boolean(matchRoute({ to: "/brain/$noteId", params: { noteId } }))
  );
};

const NoteItem = ({ note }: { note: Note }) => {
  const current = useNoteOpen(note.id);
  return (
    <Link
      params={{ noteId: note.id }}
      // A piece of work opens on what Grasp knows about it.
      search={note.kind === "candidate" ? { knowledge: true } : {}}
      title={note.title}
      to="/brain/$noteId"
      {...stylex.props(
        styles.row,
        styles.note,
        current && styles.current,
        focus.ring
      )}
    >
      <span aria-hidden="true" {...stylex.props(styles.dotBox)}>
        <span {...stylex.props(styles.dot, dots[dotOf(note)])} />
      </span>
      <RowWords>{note.title}</RowWords>
      {/* A source shows how many statements were tagged in it, since statements live there. */}
      {note.kind === "source" && note.statementIds.length > 0 ? (
        <RowCount value={note.statementIds.length} />
      ) : null}
    </Link>
  );
};

interface Opening {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

/** A group in a part, as a heading with its count; what it holds, while open, under it. */
const Group = ({
  folder,
  opening,
  children,
}: {
  folder: Folder;
  opening: Opening;
  children: ReactNode;
}) => {
  const expanded = opening.isOpen(folder.key);
  const page = folder.note;
  const name = page?.title ?? folder.name;
  const current = useNoteOpen(page?.id);
  return (
    <div {...stylex.props(styles.group)}>
      <div
        {...stylex.props(styles.row, styles.holder, current && styles.current)}
      >
        {page ? (
          // A group with its own page, such as a source folder, opens it from its name; the arrow folds it.
          <Link
            params={{ noteId: page.id }}
            to="/brain/$noteId"
            {...stylex.props(styles.name, focus.words)}
          >
            <RowWords>{name}</RowWords>
          </Link>
        ) : (
          <button
            aria-expanded={expanded}
            onClick={() => {
              opening.toggle(folder.key);
            }}
            type="button"
            {...stylex.props(styles.name, focus.words)}
          >
            <RowWords>{name}</RowWords>
          </button>
        )}
        <RowCount value={countNotes(folder) - (page ? 1 : 0)} />
        {/* A team's own menu, for an admin: move it to another region. */}
        {folder.key.startsWith("team:") ? (
          <TeamMenu teamId={folder.key.slice("team:".length)} />
        ) : null}
        <RowToggle
          expanded={expanded}
          name={name}
          onToggle={() => {
            opening.toggle(folder.key);
          }}
        />
      </div>
      {children}
    </div>
  );
};

/**
 * What a part holds, along its one guide line: its notes, and its groups as headings over theirs.
 * There is one kind of heading and one level of it, so the list reads in two styles only: a group
 * in full colour and a note in the quieter one, all in the same size. A group that only holds other
 * groups, such as Conversations, steps aside for them. Nothing indents further, so every title
 * starts in the same place.
 */
const Entries = ({ folder, opening }: { folder: Folder; opening: Opening }) => (
  <>
    {folder.notes.map((note) => (
      <NoteItem key={note.id} note={note} />
    ))}
    {folder.folders.map((child) =>
      child.notes.length === 0 && child.folders.length > 0 ? (
        <Entries folder={child} key={child.key} opening={opening} />
      ) : (
        <Group folder={child} key={child.key} opening={opening}>
          {opening.isOpen(child.key) ? (
            <Entries folder={child} opening={opening} />
          ) : null}
        </Group>
      )
    )}
  </>
);

/** The home and the web, above the parts: an icon and a name. Without a note it is the web. */
const TopLink = ({
  to,
  icon,
  label,
  current,
}: {
  to?: string;
  icon: IconData;
  label: string;
  current: boolean;
}) => {
  const look = stylex.props(styles.row, current && styles.current, focus.ring);
  const content = (
    <>
      <RowMark current={current} icon={icon} />
      <RowWords>{label}</RowWords>
    </>
  );
  return to === undefined ? (
    <Link activeOptions={{ exact: true }} to="/brain" {...look}>
      {content}
    </Link>
  ) : (
    <Link params={{ noteId: to }} to="/brain/$noteId" {...look}>
      {content}
    </Link>
  );
};

/** One of the brain's own pages: its log, its memory, its sources. */
const PageLink = ({
  to,
  icon,
  label,
  current,
}: {
  to: "/brain/activity" | "/brain/memory" | "/brain/sources";
  icon: IconData;
  label: string;
  current: boolean;
}) => (
  <Link
    to={to}
    {...stylex.props(styles.row, current && styles.current, focus.ring)}
  >
    <RowMark current={current} icon={icon} />
    <RowWords>{label}</RowWords>
  </Link>
);

/** The way to open the navigation again, at the top of the folded rail. */
const RailButton = ({
  icon,
  label,
  onPress,
}: {
  icon: IconData;
  label: string;
  onPress: () => void;
}) => (
  <Tooltip>
    <TooltipTrigger
      aria-label={label}
      icon={icon}
      onClick={onPress}
      variant="ghost"
    />
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

/**
 * A place in the folded rail: an icon, named by its tooltip, that is the router's link there, so
 * it opens in a new tab as any link does.
 */
const RailLink = ({
  icon,
  label,
  current = false,
  link,
}: {
  icon: IconData;
  label: string;
  current?: boolean;
  link: ReactElement<Record<string, unknown>>;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-current={current ? "page" : undefined}
          aria-label={label}
          icon={icon}
          render={link}
          variant={current ? "quiet" : "ghost"}
        />
      }
    />
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

/** The key a region is opened by in the navigation. */
const regionKey = (id: RegionId): string => `region:${id}`;

/** Each region's icon: the board's goals, the teams in a lobe, and what came in. */
const regionIcon = (id: RegionId): IconData => {
  if (id === "frontal") {
    return Rocket;
  }
  return id === "stem" ? Inbox : People;
};

/**
 * What a region holds, as the navigation lists it. In front, the vision and the goals; in a lobe,
 * each team as a group that opens its page from its name, its work under it; at the stem, the
 * folders of what came in.
 */
const regionFolder = (region: AtlasRegion, tree: Folder): Folder => {
  const key = regionKey(region.id);
  if (region.id === "stem") {
    return {
      key,
      name: region.name,
      folders: findFolder(tree, "Sources")?.folders ?? [],
      notes: [],
    };
  }
  if (region.id === "frontal") {
    return { key, name: region.name, folders: [], notes: region.notes };
  }
  const teams = region.notes.filter((each) => each.kind === "team");
  const workOf = (team: Note) =>
    region.notes.filter(
      (each) =>
        each.kind !== "team" &&
        each.path[0] === TEAM_FOLDER &&
        each.path[1] === team.id
    );
  const [only] = teams;
  // A group of one team named after it: the team's page first, then its work, said once.
  if (teams.length === 1 && only?.title === region.name) {
    return {
      key,
      name: region.name,
      folders: [],
      notes: [only, ...workOf(only)],
    };
  }
  return {
    key,
    name: region.name,
    notes: [],
    folders: teams.map((team) => ({
      key: `team:${team.id}`,
      name: team.title,
      note: team,
      folders: [],
      notes: workOf(team),
    })),
  };
};

/** The keys on the way to a note in the navigation: its region, the team whose work it is, and the folders of what came in. */
const wayTo = (note: Note, atlas: Atlas): string[] => {
  const home = atlas.home.get(note.id);
  if (home === undefined) {
    return [];
  }
  const shown = atlas.regions
    .find((each) => each.id === home)
    ?.notes.find((each) => each.id === note.id);
  const team =
    shown?.path[0] === TEAM_FOLDER ? [`team:${shown.path[1] ?? ""}`] : [];
  const folders = home === "stem" ? pathKeys(note) : [];
  return [regionKey(home), ...team, ...folders];
};

/**
 * The brain's navigation, as the prototype has it: the home and the brain itself, its log, then
 * the brain's regions: the board, each of the company's groups of teams, and what came in. A
 * region opens in place along a thin guide line: a group's teams, each opening to its work. It
 * folds to a rail of icons to give the page more room: by itself on a window too narrow to hold
 * it open beside the brain, and whenever you fold it. It stays folded or open as the reader left
 * it, and so do the regions and teams opened in it.
 */
export const BrainNav = ({
  brain,
  atlas,
  note,
  region: shownRegion,
}: {
  brain: Brain;
  atlas: Atlas;
  note?: Note | undefined;
  region?: RegionId | undefined;
}) => {
  const { t } = useLingui();
  const [collapsed, setCollapsed] = usePageSidebarFold("brain");
  const [open, setOpen] = useState(readOpened);
  // What is open is kept for the next visit, as the folding is.
  useEffect(() => {
    saveOpened(open);
  }, [open]);
  const [revealed, setRevealed] = useState<string | undefined>();
  // The region whose name is a field now, by its group's id.
  const [renaming, setRenaming] = useState<string>();
  const company = brain.notes.find((candidate) => candidate.kind === "company");
  const activityLabel = t({ message: "Activity", context: "the brain's log" });
  // Which of the brain's own pages is open, for the rail and the rows alike.
  const matchRoute = useMatchRoute();
  const onActivity = Boolean(matchRoute({ to: "/brain/activity" }));
  const onMemory = Boolean(matchRoute({ to: "/brain/memory" }));
  const onSources = Boolean(matchRoute({ to: "/brain/sources" }));
  const sourcesLabel = t({
    message: "Sources",
    context: "the Brain's sources page",
  });
  const onBrain = Boolean(matchRoute({ to: "/brain" }));
  const onCompany = company !== undefined && note?.id === company.id;
  let here = new Set<string>();
  if (note) {
    here = new Set(wayTo(note, atlas));
  } else if (shownRegion) {
    here = new Set([regionKey(shownRegion)]);
  }

  // Opening a note opens the way to it once, so you can see where you are. After that it closes
  // like anything else. A region open in the brain opens here too, once.
  const reveal =
    note?.id ??
    (shownRegion === undefined ? undefined : regionKey(shownRegion));
  if (reveal !== undefined && revealed !== reveal) {
    setRevealed(reveal);
    setOpen((previous) => new Set([...previous, ...here]));
  }

  const tree = folderTree(brain.notes);
  const opening: Opening = {
    isOpen: (key) => open.has(key),
    toggle: (key) => {
      setOpen((previous) => flip(previous, key));
    },
  };
  // The board first, then the company's groups in its own order, then what came in.
  const order: RegionId[] = ["frontal", ...LOBES, "stem"];
  const regions = order.flatMap((id) =>
    atlas.regions
      .filter(
        (each) => each.id === id && each.name !== "" && each.notes.length > 0
      )
      .map((each) => ({
        region: each,
        folder: regionFolder(each, tree),
        icon: regionIcon(each.id),
      }))
  );

  if (collapsed) {
    return (
      <aside
        aria-label={t`The brain`}
        {...stylex.props(styles.aside, styles.folded)}
      >
        <div {...stylex.props(styles.rail)}>
          <RailButton
            icon={SidebarToggle}
            label={t`Expand the navigation`}
            onPress={() => {
              setCollapsed(false);
            }}
          />
          <Separator decorative layout={styles.railLine} />
          {company ? (
            <RailLink
              current={onCompany}
              icon={Company}
              label={company.title}
              link={
                <Link params={{ noteId: company.id }} to="/brain/$noteId" />
              }
            />
          ) : null}
          <RailLink
            current={onBrain && shownRegion === undefined}
            icon={BrainMark}
            label={t`Brain`}
            link={<Link to="/brain" />}
          />
          <RailLink
            current={onActivity}
            icon={Chart}
            label={activityLabel}
            link={<Link to="/brain/activity" />}
          />
          <RailLink
            current={onMemory}
            icon={NoteMark}
            label={t`Memory`}
            link={<Link to="/brain/memory" />}
          />
          <RailLink
            current={onSources}
            icon={FolderMark}
            label={sourcesLabel}
            link={<Link to="/brain/sources" />}
          />
          {regions.map(({ region, icon }) => (
            <RailLink
              current={here.has(regionKey(region.id))}
              icon={icon}
              key={region.id}
              label={region.name}
              link={<Link search={{ region: region.id }} to="/brain" />}
            />
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside aria-label={t`The brain`} {...stylex.props(styles.aside)}>
      {/* The home, with the way to fold the navigation beside it: out of the way, where the panel begins. */}
      <div {...stylex.props(styles.top)}>
        <div {...stylex.props(styles.topFirst)}>
          {company ? (
            <TopLink
              current={onCompany}
              icon={Company}
              label={company.title}
              to={company.id}
            />
          ) : (
            <TopLink
              current={onBrain && shownRegion === undefined}
              icon={BrainMark}
              label={t`Brain`}
            />
          )}
        </div>
        <RailButton
          icon={SidebarToggle}
          label={t`Fold the navigation`}
          onPress={() => {
            setCollapsed(true);
          }}
        />
      </div>
      <div {...stylex.props(styles.body)}>
        {company ? (
          <TopLink
            current={onBrain && shownRegion === undefined}
            icon={BrainMark}
            label={t`Brain`}
          />
        ) : null}
        <PageLink
          current={onActivity}
          icon={Chart}
          label={activityLabel}
          to="/brain/activity"
        />
        <PageLink
          current={onMemory}
          icon={NoteMark}
          label={t`Memory`}
          to="/brain/memory"
        />
        <PageLink
          current={onSources}
          icon={FolderMark}
          label={sourcesLabel}
          to="/brain/sources"
        />
        <Separator decorative layout={styles.line} />

        {regions.map(({ region, folder, icon }) => {
          const key = regionKey(region.id);
          const expanded = opening.isOpen(key);
          const current = here.has(key);
          const shown = onBrain && shownRegion === region.id;
          const { name, group } = region;
          return (
            <div key={key} {...stylex.props(styles.region)}>
              <div
                {...stylex.props(
                  styles.row,
                  styles.holder,
                  shown && styles.current
                )}
              >
                {/* The region's name goes to it in the brain; the arrow opens what it holds here. An admin renames it in place. */}
                {group !== undefined && renaming === group.id ? (
                  <RegionRename
                    name={name}
                    onDone={() => {
                      setRenaming(undefined);
                    }}
                    regionId={group.id}
                  />
                ) : (
                  <Link
                    activeOptions={{ includeSearch: true }}
                    search={{ region: region.id }}
                    to="/brain"
                    {...stylex.props(
                      styles.name,
                      current && styles.nameCurrent,
                      focus.words
                    )}
                  >
                    <RowMark current={current || shown} icon={icon} />
                    <RowWords>{name}</RowWords>
                  </Link>
                )}
                {group === undefined ? null : (
                  <RegionMenu
                    name={name}
                    onRename={() => {
                      setRenaming(group.id);
                    }}
                    regionId={group.id}
                  />
                )}
                <RowToggle
                  expanded={expanded}
                  name={name}
                  onToggle={() => {
                    opening.toggle(key);
                  }}
                />
              </div>
              {expanded ? (
                <div {...stylex.props(styles.guide)}>
                  <Entries folder={folder} opening={opening} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </aside>
  );
};
