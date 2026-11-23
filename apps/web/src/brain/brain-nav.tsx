import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { TreeView } from "@grasp-os/ui/components/tree-view";
import type { TreeNode } from "@grasp-os/ui/components/tree-view";
import {
  BrainIcon,
  BuildingIcon,
  ChartColumnIcon,
  FolderIcon,
  InboxIcon,
  RocketIcon,
  SparklesIcon,
  StickyNoteIcon,
  UsersIcon,
  WandSparklesIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useLocation } from "@tanstack/react-router";

import { TEAM_FOLDER } from "./brain-atlas.ts";
import type { Atlas, AtlasRegion, RegionId } from "./brain-atlas.ts";
import { findFolder } from "./brain-sections.ts";
import { folderTree } from "./brain.ts";
import type { Brain, Folder, Note } from "./brain.ts";

// The Brain's own navigation, as the prototype's section of the sidebar has
// it: the Brain's overview, its own pages, and each part of the brain as a
// tree, what it holds a branch under it, on Damsko's TreeView. It stands as
// a column of its own beside the Brain's pages from a tablet's width, as the
// old one did, until the app's sidebar takes it as its level, as it takes
// Settings. What it shows is what the brain's layout read: no read of its own.

const styles = stylex.create({
  nav: {
    display: { default: "none", [media.md]: "flex" },
    flexDirection: "column",
    gap: space["2"],
    flexShrink: 0,
    boxSizing: "border-box",
    width: size.sidebarWidth,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: space["2"],
    paddingInline: space["2"],
    backgroundColor: colors.sidebar,
    borderInlineEndWidth: size.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: colors.sidebarBorder,
  },
  // The parts' label, as a sidebar group's.
  label: {
    margin: 0,
    paddingBlockStart: space["2"],
    paddingBlockEnd: space["1"],
    paddingInline: space["2"],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.sidebarSecondaryForeground,
  },
});

/** Each part's icon: the board's goals, the teams in a lobe, and what came in. */
const partIcon = (id: RegionId): IconData => {
  if (id === "frontal") {
    return RocketIcon;
  }
  return id === "stem" ? InboxIcon : UsersIcon;
};

/** A note as an item under its part: it opens the note's page. */
const noteItem = (note: Note): TreeNode => ({
  value: note.id,
  label: note.title,
  render: (
    <Link
      activeOptions={{ exact: true }}
      params={{ noteId: note.id }}
      to="/brain/$noteId"
    />
  ),
});

/**
 * What a part holds, as its items: in front, the vision and the goals; in a
 * lobe, each team; at the stem, the folders of what came in, each opening
 * its own page where it has one.
 */
const partItems = (region: AtlasRegion, tree: Folder): TreeNode[] => {
  if (region.id === "stem") {
    const folders = findFolder(tree, "Sources")?.folders ?? [];
    return folders.flatMap((folder) =>
      folder.note === undefined ? [] : [noteItem(folder.note)]
    );
  }
  const shown = region.notes.filter(
    (note) => note.kind === "team" || note.path[0] !== TEAM_FOLDER
  );
  return shown.map((note) => noteItem(note));
};

/** The Brain's own pages, each an item of the navigation, by its address. */
type BrainPage =
  | "/brain/activity"
  | "/brain/memories"
  | "/brain/opportunities"
  | "/brain/skills"
  | "/brain/sources";

const pageItem = (to: BrainPage, label: string, icon: IconData): TreeNode => ({
  value: to,
  label,
  icon,
  render: <Link activeOptions={{ exact: true }} to={to} />,
});

/** The overview's item: the brain as an atlas. */
const overview = "overview";

/**
 * The Brain's pages and parts. Opportunities are an admin's (GRA-1750):
 * nobody else gets the item.
 */
export const BrainNav = ({
  atlas,
  brain,
  identity,
}: {
  atlas: Atlas;
  brain: Brain;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const tree = folderTree(brain.notes);
  const company = brain.notes.find((note) => note.kind === "company");
  const pages: TreeNode[] = [
    // The overview stands first, by the Brain's own name.
    {
      value: overview,
      label: t`Brain`,
      icon: BrainIcon,
      render: (
        <Link
          activeOptions={{ exact: true, includeSearch: true }}
          to="/brain"
        />
      ),
    },
    ...(company === undefined
      ? []
      : [{ ...noteItem(company), icon: BuildingIcon }]),
    pageItem(
      "/brain/activity",
      t({ message: "Activity", context: "the brain's log" }),
      ChartColumnIcon
    ),
    pageItem(
      "/brain/sources",
      t({ message: "Sources", context: "the Brain's sources page" }),
      FolderIcon
    ),
    pageItem(
      "/brain/memories",
      t({ message: "Memories", context: "the Brain's memories page" }),
      StickyNoteIcon
    ),
    pageItem(
      "/brain/skills",
      t({ message: "Skills", context: "the Brain's skills page" }),
      WandSparklesIcon
    ),
    ...(isMemberAdmin(identity)
      ? [
          pageItem(
            "/brain/opportunities",
            t({
              message: "Opportunities",
              context: "the Brain's opportunities page",
            }),
            SparklesIcon
          ),
        ]
      : []),
  ];
  const parts: TreeNode[] = atlas.regions
    .filter((region) => region.notes.length > 0 || region.id === "stem")
    .map((region) => {
      const open = region.open.length;
      return {
        value: region.id,
        label: region.name,
        icon: partIcon(region.id),
        render: (
          <Link
            activeOptions={{ exact: true, includeSearch: true }}
            search={{ region: region.id }}
            to="/brain"
          />
        ),
        ...(open > 0
          ? {
              badge: (
                <Badge aria-label={t`${open} still open`} size="sm">
                  {open}
                </Badge>
              ),
            }
          : {}),
        children: partItems(region, tree),
      };
    });
  // Where the person is: the overview or a part of it, a page, or a note.
  let current: string | null = null;
  if (pathname === "/brain") {
    current = typeof search.region === "string" ? search.region : overview;
  } else if (pages.some((page) => page.value === pathname)) {
    current = pathname;
  } else if (pathname.startsWith("/brain/")) {
    current = decodeURIComponent(pathname.slice("/brain/".length));
  }
  return (
    <aside aria-label={t`The brain`} {...stylex.props(styles.nav)}>
      <TreeView
        aria-label={t`The Brain's pages`}
        current={current}
        items={pages}
        selectionMode="none"
      />
      <p aria-hidden="true" {...stylex.props(styles.label)}>
        {t`In the brain`}
      </p>
      <TreeView
        aria-label={t`In the brain`}
        current={current}
        defaultExpandedValue={parts.map((part) => part.value)}
        expandOnPress={false}
        items={parts}
        selectionMode="none"
        showIndentGuides
      />
    </aside>
  );
};
