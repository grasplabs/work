import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatch } from "@tanstack/react-router";
import { useState } from "react";

import type { MenuEntries } from "../grasp/context-menu/menu-items.tsx";
import {
  Brain as BrainMark,
  Chart,
  Company,
  Folder as FolderMark,
  Inbox,
  Note as NoteMark,
  People,
  Plus,
  Rocket,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type {
  SidebarRow,
  SidebarSection,
  SidebarSubRow,
} from "../grasp/sidebar/index.ts";
import { atlasOf, TEAM_FOLDER } from "./brain-atlas.ts";
import type { AtlasRegion, RegionId } from "./brain-atlas.ts";
import { findFolder } from "./brain-sections.ts";
import { folderTree } from "./brain.ts";
import type { Folder, Note } from "./brain.ts";
import {
  movedTo,
  newRegionId,
  regionsMax,
  useArrangingIn,
} from "./region-edit.tsx";
import type { Arranging } from "./region-edit.tsx";

// The Brain as the sidebar's section while the person is in it, as Settings
// and an agent are (grasp/frame/grasp-sidebar.tsx): Back to the page they
// came from, the Brain's own pages, then each part of the brain with what
// it holds under it. The library's Sidebar draws it, in place of a second
// column of the Brain's own. An admin renames a part and moves a team from
// the rows' own menus, as on the map. What it shows is what the brain's
// layout read: no read of its own.

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

/** A note as a row under its part: it opens the note's page. */
const noteRow = (note: Note, current: string | undefined): SidebarSubRow => ({
  id: note.id,
  label: note.title,
  render: <Link params={{ noteId: note.id }} to="/brain/$noteId" />,
  current: current === note.id,
});

/**
 * What a part holds, as its rows: in front, the vision and the goals; in a
 * lobe, each team; at the stem, the folders of what came in, each opening
 * its own page where it has one.
 */
const partRows = (
  region: AtlasRegion,
  tree: Folder,
  current: string | undefined
): SidebarSubRow[] => {
  if (region.id === "stem") {
    const folders = findFolder(tree, "Sources")?.folders ?? [];
    return folders.flatMap((folder) =>
      folder.note === undefined ? [] : [noteRow(folder.note, current)]
    );
  }
  const shown = region.notes.filter(
    (note) => note.kind === "team" || note.path[0] !== TEAM_FOLDER
  );
  return shown.map((note) => noteRow(note, current));
};

/** The menu of a team's row, for an admin: move it to another part, or to a new one of its own. */
const teamMenu = (
  arranging: Arranging,
  teamId: string,
  words: { moveTo: string; newPart: string }
): MenuEntries | undefined => {
  const { regions } = arranging;
  const here = regions.find((region) => region.teamIds.includes(teamId));
  const others = regions.filter((region) => region !== here);
  const alone = here !== undefined && here.teamIds.length === 1;
  const roomLeft = regions.length < regionsMax;
  const entries: MenuEntries = [];
  if (others.length > 0) {
    entries.push({
      type: "group",
      label: words.moveTo,
      items: others.map((region) => ({
        value: `move:${region.id}`,
        label: region.name,
      })),
    });
  }
  if (!alone && roomLeft) {
    entries.push({ value: "new", label: words.newPart, icon: Plus });
  }
  return entries.length > 0 ? entries : undefined;
};

/** The Brain's pages and parts, as the sidebar's section; undefined outside the Brain. */
export const useBrainSection = (): SidebarSection | undefined => {
  const { t } = useLingui();
  const { pathname, search } = useLocation();
  const match = useMatch({ from: "/_shell/brain", shouldThrow: false });
  const loaded = match?.loaderData;
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  const arranging = useArrangingIn(read?.workspace);
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
  const teams = new Set(workspace.teams.map((team) => team.id));
  const noteId = pathname.startsWith("/brain/")
    ? decodeURIComponent(pathname.slice("/brain/".length))
    : undefined;
  const company = brain.notes.find((note) => note.kind === "company");
  const page = (
    label: string,
    icon: IconData,
    to: "/brain" | "/brain/activity" | "/brain/memory" | "/brain/sources"
  ): SidebarRow => ({
    label,
    icon,
    render: <Link to={to} />,
    current: pathname === to,
  });
  const parts: SidebarRow[] = atlas.regions
    .filter((region) => region.notes.length > 0 || region.id === "stem")
    .map((region) => {
      const { group } = region;
      const rows = partRows(region, tree, noteId).map((row) => {
        const teamId = row.id ?? "";
        const menu =
          arranging === undefined || !teams.has(teamId)
            ? undefined
            : teamMenu(arranging, teamId, {
                moveTo: t`Move to`,
                newPart: t`New region`,
              });
        if (menu === undefined || arranging === undefined) {
          return row;
        }
        const team = row.label;
        return {
          ...row,
          actions: menu,
          actionsLabel: t`Arrange ${team}`,
          onAction: (value: string) => {
            const { regions, save } = arranging;
            if (value === "new") {
              const id = newRegionId();
              void save(
                movedTo(
                  [...regions, { id, name: team, teamIds: [] }],
                  teamId,
                  id
                ),
                t`${team} has a region of its own`
              );
              return;
            }
            const to = regions.find(({ id }) => `move:${id}` === value);
            if (to !== undefined) {
              const { name } = to;
              void save(
                movedTo(regions, teamId, to.id),
                t`${team} moved to ${name}`
              );
            }
          },
        };
      });
      const open = region.open.length;
      return {
        id: region.id,
        label: region.name,
        icon: partIcon(region.id),
        render: <Link search={{ region: region.id }} to="/brain" />,
        current: pathname === "/brain" && search.region === region.id,
        ...(open > 0 ? { count: open, countLabel: t`${open} still open` } : {}),
        rows,
        // An admin renames a part in place, as on the map.
        ...(arranging === undefined || group === undefined
          ? {}
          : {
              onRename: (name: string) => {
                void arranging.save(
                  arranging.regions.map((each) =>
                    each.id === group.id ? { ...each, name } : each
                  ),
                  t`Renamed to ${name}`
                );
              },
            }),
      };
    });
  return {
    id: "brain",
    title: t`Brain`,
    icon: BrainMark,
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
          page(t`Overview`, BrainMark, "/brain"),
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
      { label: t`In the brain`, rows: parts },
    ],
    storageKey: "grasp.sidebar.brain",
    navLabel: t`The Brain's pages`,
  };
};
