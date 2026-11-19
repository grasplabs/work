import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { groupLabel } from "./groups.ts";
import type { Integration } from "./integrations.ts";
import { reliedOnLapsed, workflowsOf } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";

// One app on the Integrations page, as a tile: Grasp UI's Item, outlined,
// with the app's own mark, its name and one live fact, the whole tile one
// link that opens it beside the list (`?app=`). Connected, the fact is
// where it stands: to sign in to again, or how many workflows use it once
// that is read, or for whom it is connected until then. Not connected, it
// is how many tools it has. Every tile is the same: one height across the
// grid, its mark, its name and one short fact in the same quiet words, so
// no tile stands out but by its mark (Ruben, 19 Nov 2026).

const styles = stylex.create({
  // Tiles side by side, as many as the width takes.
  // One height for every tile on the page: room for a name on two lines
  // and its fact, so a long name never makes its row taller than the rest.
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
    gridAutoRows: "minmax(5.5rem, 1fr)",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The tile fills its cell, so every tile in the grid is the same height.
  cell: { display: "grid" },
  tile: { height: "100%" },
});

/** The tiles, as a list. */
export const TileGrid = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <ul aria-label={label} {...stylex.props(styles.grid)}>
    {children}
  </ul>
);

/** The one fact under a connected app's name. */
const ConnectedFact = ({
  integration,
  uses,
}: {
  integration: Integration;
  /** Which workflows use each connection, once read. */
  uses: readonly ConnectionWorkflows[] | undefined;
}) => {
  const { t } = useLingui();
  // The header card and the app's nerve say it louder: here it is one
  // quiet fact like any other.
  if (reliedOnLapsed(integration, uses)) {
    return t`Sign in again`;
  }
  if (uses === undefined) {
    return integration.connections.some(({ scope }) => scope === "shared")
      ? t`For everyone`
      : t`Only you`;
  }
  const count = workflowsOf(integration, uses).length;
  return count === 0
    ? t`Not used yet`
    : t`${plural(count, { one: "In # workflow", other: "In # workflows" })}`;
};

/** What a not-connected app holds: how many tools, or that it isn't offered. */
const Kind = ({ integration }: { integration: Integration }) => {
  const { t, i18n } = useLingui();
  const { toolCount } = integration;
  if (integration.listed && !integration.offered) {
    return t`Not offered`;
  }
  return toolCount === undefined
    ? i18n._(groupLabel[integration.group])
    : t`${plural(toolCount, { one: "# tool", other: "# tools" })}`;
};

/** One app, as a tile that opens it beside the list. */
export const IntegrationTile = ({
  integration,
  uses,
  open,
}: {
  integration: Integration;
  uses?: readonly ConnectionWorkflows[] | undefined;
  /** It is the one open beside the list. */
  open: boolean;
}) => {
  const connected = integration.connections.length > 0;
  return (
    <li {...stylex.props(styles.cell)}>
      <Item
        current={open}
        layout={styles.tile}
        render={
          <Link
            from="/integrations/"
            resetScroll={false}
            search={(last) => ({ ...last, app: integration.key })}
            to="."
          />
        }
        size="sm"
        variant="outline"
      >
        <ItemMedia>
          <ProviderMark
            id={integration.id}
            logo={integration.logo}
            name={integration.name}
          />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{integration.name}</ItemTitle>
          <ItemDescription>
            {connected ? (
              <ConnectedFact integration={integration} uses={uses} />
            ) : (
              <Kind integration={integration} />
            )}
          </ItemDescription>
        </ItemContent>
      </Item>
    </li>
  );
};
