import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatch } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "../grasp/badge/index.ts";
import {
  Brain as BrainMark,
  Chart,
  Company,
  Folder as FolderMark,
  Inbox,
  Note as NoteMark,
  People,
  Rocket,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type { SidebarRow, SidebarSection } from "../grasp/sidebar/index.ts";
import { Tree } from "../grasp/tree/index.ts";
import type { TreeNode } from "../grasp/tree/index.ts";
import { atlasOf, TEAM_FOLDER } from "./brain-atlas.ts";
import type { AtlasRegion, RegionId } from "./brain-atlas.ts";
import { findFolder } from "./brain-sections.ts";
import { folderTree } from "./brain.ts";
import type { Folder, Note } from "./brain.ts";

// The Brain as the sidebar's section while the person is in it, as Settings
// and an agent are (grasp/frame/grasp-sidebar.tsx): its name first, a press
// of its own that opens the Brain's overview, then Back to the page they
// came from, the Brain's own pages, and each part of the brain as the
// library's Tree, what it holds a branch under it. The library's Sidebar
// draws it, in place of a second column of the Brain's own. An admin
// renames a part and moves a team on the map. What it shows is what the
// brain's layout read: no read of its own.

/** The last page outside the Brain, to go back to. */
interface Outside {
  pathname: string;
  search: Record<string, unknown>;
}

/** Each part's icon: the board's goals, the teams in a lobe, and what came in. */
const partIcon = (id: RegionId): IconData => {
  if (id === "frontal") {
    return Rocket;
  }
  return id === "stem" ? Inbox : People;
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

/** The Brain's pages and parts, as the sidebar's section; undefined outside the Brain. */
export const useBrainSection = (): SidebarSection | undefined => {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const match = useMatch({ from: "/_shell/brain", shouldThrow: false });
  const loaded = match?.loaderData;
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  const [outside, setOutside] = useState<Outside>();
  // By the address, not the route's match: the match comes after the address
  // as the Brain loads, and the Brain itself was then kept as the page to go
  // back to, so Back led nowhere.
  const inBrain = pathname === "/brain" || pathname.startsWith("/brain/");
  if (!inBrain && outside?.pathname !== pathname) {
    setOutside({ pathname, search });
  }
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
    to: "/brain/activity" | "/brain/memory" | "/brain/sources"
  ): SidebarRow => ({
    label,
    icon,
    render: <Link to={to} />,
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
    icon: BrainMark,
    // Its name opens the Brain's overview: no Overview row of its own.
    home: <Link to="/brain" />,
    homeCurrent: overview,
    back: {
      label: t`Back`,
      render:
        outside === undefined ? (
          <Link to="/" />
        ) : (
          <Link search={outside.search} to={outside.pathname} />
        ),
    },
    groups: [
      {
        rows: [
          ...(company === undefined
            ? []
            : [
                {
                  label: company.title,
                  icon: Company,
                  render: (
                    <Link params={{ noteId: company.id }} to="/brain/$noteId" />
                  ),
                  current: noteId === company.id,
                },
              ]),
          page(
            t({ message: "Activity", context: "the brain's log" }),
            Chart,
            "/brain/activity"
          ),
          page(t`Memory`, NoteMark, "/brain/memory"),
          page(
            t({ message: "Sources", context: "the Brain's sources page" }),
            FolderMark,
            "/brain/sources"
          ),
        ],
      },
      {
        label: t`In the brain`,
        rows: [],
        content: (
          <Tree
            current={noteId ?? regionShown ?? null}
            defaultExpanded={parts.map((part) => part.value)}
            expandOnPress={false}
            aria-label={t`In the brain`}
            items={parts}
          />
        ),
      },
    ],
    storageKey: "grasp.sidebar.brain",
    navLabel: t`The Brain's pages`,
  };
};
