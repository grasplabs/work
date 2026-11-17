import type { TeamGroup, Workspace } from "@grasp-os/shared/brain";
import { isMemberAdmin } from "@grasp-os/shared/roles";
// The frame mounts this Toaster (frame/app-frame.tsx), not the library's own yet.
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouteContext, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { Edit, More, Plus } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../use-core.ts";
import { LOBES } from "./brain-atlas.ts";
import { useBrainData } from "./brain-data.ts";

// The brain's regions as an admin arranges them, right on the Brain's map
// (brain-nav.tsx): Grasp arranges the teams into regions by itself and that
// counts at once (core's brain-team-groups.ts); an admin renames a region
// in place, or moves a team to another region or to a new one of its own.
// Each change is saved as it is made, the regions whole, and a toast offers
// to put back the regions as they were. Anyone else sees the regions only.

/** A region as kept: no `confirmed`, which is always so now. */
type Kept = Omit<TeamGroup, "confirmed">;

/**
 * The regions as kept, with the teams the brain still has: a team in none
 * stands under "Other teams" on the map (brain-atlas.ts `groupsOf`), which
 * is no region of its own to rename.
 */
export const keptRegions = (ws: Workspace): Kept[] => {
  const known = new Set(ws.teams.map((team) => team.id));
  return ws.teamGroups
    .map(({ id, name, teamIds }) => ({
      id,
      name,
      teamIds: teamIds.filter((teamId) => known.has(teamId)),
    }))
    .filter((group) => group.teamIds.length > 0);
};

/** The regions the Brain's map has room for: its four lobes (core's `regionsMax`). */
const regionsMax = LOBES.length;

/** `regions` with `teamId` moved into `regionId`; a region left empty goes. */
const movedTo = (
  regions: readonly Kept[],
  teamId: string,
  regionId: string
): Kept[] =>
  regions
    .map((region) => {
      const without = region.teamIds.filter((id) => id !== teamId);
      return {
        ...region,
        teamIds: region.id === regionId ? [...without, teamId] : without,
      };
    })
    .filter((region) => region.teamIds.length > 0);

/** A new region's id: a short random one, as a region's id may be. */
const newRegionId = (): string => `group-${crypto.randomUUID().slice(0, 8)}`;

interface Arranging {
  regions: Kept[];
  /** Each team's name, for the menus' words. */
  teamName: (teamId: string) => string;
  /** Saves `next` as the regions, saying `done` with a way back to how they were. */
  save: (next: Kept[], done: string) => Promise<void>;
}

/** Saves `next` as the regions, and reads the brain again. */
const keepRegions = async (
  core: ReturnType<typeof useCore>,
  router: ReturnType<typeof useRouter>,
  next: readonly Kept[]
): Promise<void> => {
  await core.withSession(
    async ({ brain }) => await brain.saveTeamGroups([...next])
  );
  await router.invalidate();
};

/**
 * Saves `next`, then says `words.done` with a way back to `before`, or
 * `words.failed`. Outside the component, as the React Compiler can't
 * compile `try`.
 */
const saveWithUndo = async (
  keep: (regions: readonly Kept[]) => Promise<void>,
  before: readonly Kept[],
  next: readonly Kept[],
  words: { done: string; failed: string; undo: string }
): Promise<void> => {
  try {
    await keep(next);
  } catch {
    toast.add({ type: "error", title: words.failed });
    return;
  }
  toast.add({
    type: "success",
    title: words.done,
    actionProps: {
      children: words.undo,
      onClick: () => {
        void keep(before);
      },
    },
  });
};

/** What an admin may change on the map, from the brain as read; none for anyone else. */
export const useArranging = (): Arranging | undefined => {
  const { t } = useLingui();
  const { identity } = useRouteContext({ from: "/_shell" });
  const { workspace } = useBrainData();
  const core = useCore();
  const router = useRouter();
  if (!isMemberAdmin(identity)) {
    return undefined;
  }
  const regions = keptRegions(workspace);
  const save = async (next: Kept[], done: string): Promise<void> => {
    await saveWithUndo(
      async (each) => {
        await keepRegions(core, router, each);
      },
      regions,
      next,
      { done, failed: t`The regions could not be saved`, undo: t`Undo` }
    );
  };
  const teamName = (teamId: string): string =>
    workspace.teams.find(({ id }) => id === teamId)?.name ?? teamId;
  return { regions, teamName, save };
};

/**
 * The menu of a team on the map: move it to another region, or to a new
 * region of its own, named after it until it is renamed.
 */
export const TeamMenu = ({ teamId }: { teamId: string }) => {
  const { t } = useLingui();
  const arranging = useArranging();
  if (arranging === undefined) {
    return null;
  }
  const { regions, teamName, save } = arranging;
  const name = teamName(teamId);
  const here = regions.find((region) => region.teamIds.includes(teamId));
  const others = regions.filter((region) => region !== here);
  const alone = here !== undefined && here.teamIds.length === 1;
  // A new region only while the map has a lobe for it.
  const roomLeft = regions.length < regionsMax;
  if (others.length === 0 && (alone || !roomLeft)) {
    return null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Arrange ${name}`}
        icon={More}
        size="xs"
        variant="ghost"
      />
      <DropdownMenuContent align="start">
        {others.length > 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t`Move to`}</DropdownMenuLabel>
            {others.map((region) => (
              <DropdownMenuItem
                key={region.id}
                onSelect={() => {
                  const team = name;
                  const to = region.name;
                  void save(
                    movedTo(regions, teamId, region.id),
                    t`${team} moved to ${to}`
                  );
                }}
              >
                {region.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
        {others.length > 0 && !alone && roomLeft ? (
          <DropdownMenuSeparator />
        ) : null}
        {alone || !roomLeft ? null : (
          <DropdownMenuItem
            icon={Plus}
            onSelect={() => {
              const id = newRegionId();
              const team = name;
              void save(
                movedTo([...regions, { id, name, teamIds: [] }], teamId, id),
                t`${team} has a region of its own`
              );
            }}
          >
            {t`New region`}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The menu of a region on the map: rename it; and, when it holds one team, move that team. */
export const RegionMenu = ({
  regionId,
  name,
  onRename,
}: {
  regionId: string;
  name: string;
  onRename: () => void;
}) => {
  const { t } = useLingui();
  const arranging = useArranging();
  const region = arranging?.regions.find(({ id }) => id === regionId);
  if (arranging === undefined || region === undefined) {
    return null;
  }
  const { regions, teamName, save } = arranging;
  const [only] = region.teamIds;
  const teamId = region.teamIds.length === 1 ? only : undefined;
  const team = teamId === undefined ? undefined : teamName(teamId);
  const others = regions.filter(({ id }) => id !== regionId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Arrange ${name}`}
        icon={More}
        size="xs"
        variant="ghost"
      />
      <DropdownMenuContent align="start">
        <DropdownMenuItem icon={Edit} onSelect={onRename}>
          {t`Rename`}
        </DropdownMenuItem>
        {teamId === undefined ||
        team === undefined ||
        others.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t`Move ${team} to`}</DropdownMenuLabel>
              {others.map((other) => (
                <DropdownMenuItem
                  key={other.id}
                  onSelect={() => {
                    const to = other.name;
                    void save(
                      movedTo(regions, teamId, other.id),
                      t`${team} moved to ${to}`
                    );
                  }}
                >
                  {other.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const styles = stylex.create({
  field: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    borderWidth: 0,
    borderRadius: grasp.shellCorner,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    fontWeight: "inherit",
    lineHeight: "inherit",
  },
});

/**
 * A region's name as a field, in the row's own words: Enter or leaving it
 * saves, Escape or an empty name keeps the name.
 */
export const RegionRename = ({
  regionId,
  name: region,
  onDone,
}: {
  regionId: string;
  name: string;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const arranging = useArranging();
  const field = useRef<HTMLInputElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const end = (next?: string): void => {
    if (ended.current) {
      return;
    }
    ended.current = true;
    onDone();
    const trimmed = next?.trim();
    if (
      arranging === undefined ||
      trimmed === undefined ||
      trimmed === "" ||
      trimmed === region
    ) {
      return;
    }
    const name = trimmed;
    void arranging.save(
      arranging.regions.map((each) =>
        each.id === regionId ? { ...each, name } : each
      ),
      t`Renamed to ${name}`
    );
  };
  return (
    <input
      aria-label={t`Rename ${region}`}
      defaultValue={region}
      maxLength={80}
      onBlur={(event: FocusEvent<HTMLInputElement>) => {
        end(event.currentTarget.value);
      }}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.preventDefault();
          end(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          end();
        }
      }}
      ref={field}
      type="text"
      {...stylex.props(styles.field, focus.field)}
    />
  );
};
