import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { canConnect, canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { kindOf, stateOf } from "./integrations.ts";
import { ProviderMark } from "./provider-mark.tsx";
import { UsedBy } from "./workflows-using.tsx";
import type { ConnectionUses } from "./workflows-using.tsx";

// One app in the Integrations list, as a row of Grasp UI's Item: the
// provider's mark, its name (which opens its page), what kind of app it
// is and how many workflows use it, where it stands as a Badge, and the
// one thing this person can do about it now: Connect, Sign in again, or
// Manage. Its sentence on what it does shows when its name is pointed at.

/** Where an app stands, as a Badge: connected, to sign in to again, or not offered. */
const StateBadge = ({ integration }: { integration: Integration }) => {
  const { t } = useLingui();
  const state = stateOf(integration);
  if (state === "needs_reauth") {
    return <Badge tone="attention">{t`Needs signing in again`}</Badge>;
  }
  if (state === "shared") {
    return <Badge tone="success">{t`Connected for everyone`}</Badge>;
  }
  if (state === "personal") {
    return <Badge tone="success">{t`Connected for you`}</Badge>;
  }
  if (integration.listed && !integration.offered) {
    return <Badge>{t`Not offered`}</Badge>;
  }
  if (integration.auth === "own") {
    return <Badge>{t`Needs its own sign-in app`}</Badge>;
  }
  return null;
};

/** What this person can do about the app now: Connect, Sign in again or Manage. */
const ItemAction = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => {
  const { t } = useLingui();
  // Held above the swap below, so the dialog stays as the row changes.
  const [open, setOpen] = useState(false);
  const app = integration.name;
  const state = stateOf(integration);
  const again = integration.connections.find(
    (connection) =>
      connection.status === "needs_reauth" &&
      canReconnect(connection, integration.offered, identity)
  );
  if (state === "shared" || state === "personal") {
    return (
      <Button
        aria-label={t`Manage ${app}`}
        render={
          <Link
            params={{ integration: integration.key }}
            to="/integrations/$integration"
          />
        }
        size="sm"
        variant="ghost"
      >
        {t`Manage`}
      </Button>
    );
  }
  const connects =
    state === "not_connected" && canConnect(integration, identity);
  if (again === undefined && !connects) {
    return null;
  }
  return (
    <>
      <Button
        aria-label={
          again === undefined ? t`Connect ${app}` : t`Sign in to ${app} again`
        }
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        {again === undefined ? t`Connect` : t`Sign in again`}
      </Button>
      <ConnectDialog
        {...(again === undefined ? {} : { again })}
        identity={identity}
        integration={integration}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

/** One app, as a list's row. */
export const IntegrationItem = ({
  integration,
  identity,
  uses,
}: {
  integration: Integration;
  identity: Identity;
  /** Which workflows use each connection; left out where the page doesn't say. */
  uses?: ConnectionUses;
}) => (
  <Item size="sm">
    <ItemMedia>
      <ProviderMark
        id={integration.id}
        logo={integration.logo}
        name={integration.name}
      />
    </ItemMedia>
    <ItemContent>
      <ItemTitle>
        <TextLink
          render={
            <Link
              params={{ integration: integration.key }}
              title={integration.description ?? undefined}
              to="/integrations/$integration"
            />
          }
        >
          {integration.name}
        </TextLink>
      </ItemTitle>
      <ItemDescription>
        {kindOf(integration)}
        {uses === undefined ? null : (
          <UsedBy integration={integration} uses={uses} />
        )}
      </ItemDescription>
    </ItemContent>
    <ItemActions>
      <StateBadge integration={integration} />
      <ItemAction identity={identity} integration={integration} />
    </ItemActions>
  </Item>
);
