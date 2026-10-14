import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { mosaicGroups } from "./landscape.ts";
import type { LandscapeApp, MosaicGroup } from "./landscape.ts";
import { insetRect, squarify } from "./treemap.ts";
import type { Rect } from "./treemap.ts";

// The Landscape as a mosaic, as the prototype draws it
// (`components/landscape/app-mosaic.tsx`): one block per category, one tile
// per app, sized by users. The prototype places each block and tile with
// inline sizes; here each sits in an SVG `foreignObject` at its place, so
// the layout needs no inline styles. On narrow screens it is a list.

/** "12 users" for a category, and for an app the same or "No usage seen". */
const useUserCounts = () => {
  const { t } = useLingui();
  const usersCount = (users: number) =>
    t`${plural(users, { one: "# user", other: "# users" })}`;
  return {
    usersCount,
    usersLabel: (users: number) =>
      users > 0 ? usersCount(users) : t`No usage seen`,
  };
};

/** The height of a block's heading, above its tiles. */
const blockHeader = 36;

/** Something placed at `rect` in the SVG around it. */
const Placed = ({ rect, children }: { rect: Rect; children: ReactNode }) => (
  <foreignObject height={rect.height} width={rect.width} x={rect.x} y={rect.y}>
    {children}
  </foreignObject>
);

const Tile = ({
  app,
  tile,
  category,
  onOpen,
}: {
  app: LandscapeApp;
  tile: Rect;
  category: string;
  onOpen: (appId: string) => void;
}) => {
  const { t } = useLingui();
  const { usersLabel } = useUserCounts();
  const iconOnly = tile.width < 110 || tile.height < 92;
  const roomy = !iconOnly && tile.width >= 130 && tile.height >= 82;
  return (
    <Placed rect={tile}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label={`${app.name}, ${usersLabel(app.users)}`}
              className="bg-card hover:bg-accent focus-visible:ring-ring/50 flex size-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border px-2 text-center outline-none focus-visible:ring-3"
              onClick={() => {
                onOpen(app.id);
              }}
              type="button"
            />
          }
        >
          <AppLogo name={app.name} size={roomy ? "default" : "sm"} />
          {iconOnly ? null : (
            <span className="max-w-full truncate">{app.name}</span>
          )}
          {roomy ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {usersLabel(app.users)}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-0.5">
            <span>{app.name}</span>
            <span>
              {category} · {usersLabel(app.users)}
            </span>
            <span>
              {app.owner ?? t`No owner`} · {t`Not assessed`}
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </Placed>
  );
};

const Block = ({
  rect,
  group,
  onOpen,
}: {
  rect: Rect;
  group: MosaicGroup;
  onOpen: (appId: string) => void;
}) => {
  const { usersCount } = useUserCounts();
  const tiles = squarify(
    group.apps.map((entry) => entry.weight),
    {
      x: 4,
      y: blockHeader,
      width: Math.max(0, rect.width - 8),
      height: Math.max(0, rect.height - blockHeader - 4),
    }
  );
  return (
    <Placed rect={rect}>
      <section className="bg-muted relative size-full overflow-hidden rounded-xl">
        <div className="flex h-9 items-center justify-between gap-3 px-3">
          <h3 className="truncate font-medium">{group.category}</h3>
          {group.apps.length > 1 ? (
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {usersCount(group.users)}
            </span>
          ) : null}
        </div>
        <svg className="absolute inset-0 size-full overflow-visible">
          {group.apps.map(({ app }, index) => (
            <Tile
              app={app}
              category={group.category}
              key={app.id}
              onOpen={onOpen}
              tile={insetRect(tiles[index] ?? rect, 2)}
            />
          ))}
        </svg>
      </section>
    </Placed>
  );
};

const Treemap = ({
  groups,
  onOpen,
}: {
  groups: readonly MosaicGroup[];
  onOpen: (appId: string) => void;
}) => {
  const { t } = useLingui();
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    if (element !== null) {
      observer.observe(element);
    }
    return () => {
      observer.disconnect();
    };
  }, []);

  const height = Math.max(640, Math.min(880, width * 0.62));
  const blocks = squarify(
    groups.map((group) => Math.max(group.users, group.apps.length * 3)),
    { x: 0, y: 0, width, height }
  );

  return (
    <figure
      aria-label={t`Apps by category`}
      className="hidden xl:block"
      ref={ref}
    >
      {width > 0 ? (
        <svg className="block overflow-visible" height={height} width={width}>
          {groups.map((group, index) => (
            <Block
              group={group}
              key={group.category}
              onOpen={onOpen}
              rect={insetRect(
                blocks[index] ?? { x: 0, y: 0, width: 0, height: 0 },
                4
              )}
            />
          ))}
        </svg>
      ) : null}
    </figure>
  );
};

/**
 * The landscape as a mosaic: one block per category, one tile per app,
 * sized by users. On narrow screens it becomes a list of categories.
 */
export const AppMosaic = ({
  apps,
  onOpen,
}: {
  apps: readonly LandscapeApp[];
  onOpen: (appId: string) => void;
}) => {
  const { usersCount, usersLabel } = useUserCounts();
  const groups = mosaicGroups(apps);
  if (apps.length === 0) {
    return (
      <div className="bg-card text-muted-foreground flex h-40 items-center justify-center rounded-xl border">
        <Trans>No apps match these filters.</Trans>
      </div>
    );
  }
  return (
    <>
      <Treemap groups={groups} onOpen={onOpen} />
      <div className="flex flex-col gap-3 xl:hidden">
        {groups.map((group) => (
          <section
            className="bg-muted flex flex-col gap-2 rounded-xl p-2.5"
            key={group.category}
          >
            <div className="flex items-center justify-between gap-3 px-1.5">
              <h3 className="font-medium">{group.category}</h3>
              <span className="text-muted-foreground tabular-nums">
                {usersCount(group.users)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {group.apps.map(({ app }) => (
                <button
                  className="bg-card hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2 rounded-lg border p-3 text-left outline-none focus-visible:ring-3"
                  key={app.id}
                  onClick={() => {
                    onOpen(app.id);
                  }}
                  type="button"
                >
                  <AppLogo name={app.name} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{app.name}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {usersLabel(app.users)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
};
