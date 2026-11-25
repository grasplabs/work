import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
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
  ZapIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatch } from "@tanstack/react-router";

import type {
  LinkLook,
  SidebarRow,
  SidebarSection,
} from "../frame/sidebar.tsx";
import { WayOut } from "../frame/way-out.tsx";
import type { Outside } from "../frame/way-out.tsx";
import { atlasOf, TEAM_FOLDER } from "./brain-atlas.ts";
import type { AtlasRegion, RegionId } from "./brain-atlas.ts";
import { findFolder } from "./brain-sections.ts";
import { BrainTree } from "./brain-tree.tsx";
import type { TreeNode } from "./brain-tree.tsx";
import { folderTree } from "./brain.ts";
import type { Folder, Note } from "./brain.ts";

// The Brain as the sidebar's section while the person is in it, as Settings
// and an agent are (frame/app-sidebar.tsx): its name first, a press
// of its own that opens the Brain's overview, then Back to the page they
// came from, the Brain's own pages, and each part of the brain as the
// reference's sidebar tree (brain-tree.tsx), what it holds a branch under it. The sidebar
// draws it, in place of a second column of the Brain's own. An admin
// renames a part and moves a team on the map. What it shows is what the
// brain's layout read: no read of its own.

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
  render: <Link params={{ noteId: note.id }} to="/brain/$noteId" />,
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

/**
 * The Brain's pages and parts, as the sidebar's section; undefined outside
 * the Brain. Opportunities are an admin's (GRA-1750): nobody else gets
 * the row.
 */
export const useBrainSection = (
  identity: Identity,
  outside: Outside | undefined
): SidebarSection | undefined => {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const match = useMatch({ from: "/_shell/brain", shouldThrow: false });
  const loaded = match?.loaderData;
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  if (read === undefined) {
    return undefined;
  }
  const { workspace, brain } = read;
  const atlas = atlasOf(workspace, brain);
  const tree = folderTree(brain.notes);
  const noteId = pathname.startsWith("/brain/")
    ? decodeURIComponent(pathname.slice("/brain/".length))
    : undefined;
  const company = brain.notes.find((note) => note.kind === "company");
  const page = (
    label: string,
    icon: IconData,
    to:
      | "/brain/activity"
      | "/brain/memories"
      | "/brain/opportunities"
      | "/brain/skills"
      | "/brain/sources"
  ): SidebarRow => ({
    id: to,
    label,
    icon,
    render: (look) => <Link {...look} to={to} />,
    current: pathname === to,
  });
  const parts: TreeNode[] = atlas.regions
    .filter((region) => region.notes.length > 0 || region.id === "stem")
    .map((region) => {
      const open = region.open.length;
      return {
        value: region.id,
        label: region.name,
        icon: partIcon(region.id),
        render: <Link search={{ region: region.id }} to="/brain" />,
        ...(open > 0
          ? {
              end: (
                <Badge aria-label={t`${open} still open`} size="sm">
                  {open}
                </Badge>
              ),
            }
          : {}),
        children: partItems(region, tree),
      };
    });
  const regionShown =
    pathname === "/brain" && typeof search.region === "string"
      ? search.region
      : undefined;
  const overview = pathname === "/brain" && regionShown === undefined;
  return {
    id: "brain",
    title: t`Brain`,
    icon: BrainIcon,
    // Its name opens the Brain's overview: no Overview row of its own.
    home: (look) => <Link {...look} to="/brain" />,
    homeCurrent: overview,
    back: {
      label: t`Back`,
      render: (look) => <WayOut {...look} outside={outside} />,
    },
    groups: [
      {
        rows: [
          ...(company === undefined
            ? []
            : [
                {
                  label: company.title,
                  id: company.id,
                  icon: BuildingIcon,
                  render: (look: LinkLook) => (
                    <Link
                      {...look}
                      params={{ noteId: company.id }}
                      to="/brain/$noteId"
                    />
                  ),
                  current: noteId === company.id,
                },
              ]),
          page(
            t({ message: "Activity", context: "the brain's log" }),
            ChartColumnIcon,
            "/brain/activity"
          ),
          page(
            t({ message: "Sources", context: "the Brain's sources page" }),
            FolderIcon,
            "/brain/sources"
          ),
          page(
            t({ message: "Memories", context: "the Brain's memories page" }),
            StickyNoteIcon,
            "/brain/memories"
          ),
          page(
            t({ message: "Skills", context: "the Brain's skills page" }),
            ZapIcon,
            "/brain/skills"
          ),
          ...(isMemberAdmin(identity)
            ? [
                page(
                  t({
                    message: "Opportunities",
                    context: "the Brain's opportunities page",
                  }),
                  SparklesIcon,
                  "/brain/opportunities"
                ),
              ]
            : []),
        ],
      },
      {
        label: t`In the brain`,
        rows: [],
        content: (
          <BrainTree
            aria-label={t`In the brain`}
            current={noteId ?? regionShown ?? null}
            defaultExpanded={parts.map((part) => part.value)}
            items={parts}
          />
        ),
      },
    ],
    navLabel: t`The Brain's pages`,
  };
};
