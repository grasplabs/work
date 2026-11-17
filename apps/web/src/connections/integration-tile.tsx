import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Badge } from "../grasp/badge/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Integration } from "./integrations.ts";
import { kindOf, reliedOnLapsed, workflowsOf } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";

// One app on the Integrations page, as a tile: Grasp UI's Item, outlined,
// with the app's own mark, its name and one live fact, the whole tile one
// link that opens it beside the list (`?app=`). Connected, the fact is
// where it stands: to sign in to again, or how many workflows use it once
// that is read, or for whom it is connected until then. Not connected, it
// is what kind of app it is, so a person picks it by its mark and its kind.

const styles = stylex.create({
  // Tiles side by side, as many as the width takes.
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
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
  if (reliedOnLapsed(integration, uses)) {
    return <Badge tone="attention">{t`Sign in again`}</Badge>;
  }
  if (uses === undefined) {
    return integration.connections.some(({ scope }) => scope === "shared")
      ? t`Connected for everyone`
      : t`Connected for you`;
  }
  const count = workflowsOf(integration, uses).length;
  return count === 0
    ? t`No workflow uses it yet`
    : t`${plural(count, { one: "Used by # workflow", other: "Used by # workflows" })}`;
};

/** What a not-connected app is: its kind, or that it isn't offered. */
const Kind = ({ integration }: { integration: Integration }) => {
  const { t } = useLingui();
  return integration.listed && !integration.offered
    ? t`Not offered`
    : kindOf(integration);
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
    <li>
      <Item
        current={open}
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
