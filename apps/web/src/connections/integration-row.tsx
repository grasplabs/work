import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { formatList } from "../format.ts";
import { AppLogo } from "./app-logo.tsx";
import { canConnect, canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { stateOf } from "./integrations.ts";

// One app in the Integrations list, as the prototype's row
// (`components/integration-row.tsx`, `integration-button.tsx`): its tile,
// its name to open it, what it is for, and its button: Connect, Sign in
// again, or Connected, which says Manage under the pointer or focus.

/** Connected: Manage under the pointer or keyboard focus, both labels in one place so it keeps its width. */
const ManageLink = ({
  integration,
  shared,
}: {
  integration: Integration;
  /** Connected for everyone, rather than for this person alone. */
  shared: boolean;
}) => {
  const { t } = useLingui();
  const app = integration.name;
  return (
    <Button
      aria-label={
        shared
          ? t`Manage ${app}, connected for everyone`
          : t`Manage ${app}, connected for you`
      }
      nativeButton={false}
      render={
        <Link
          params={{ integration: integration.key }}
          to="/integrations/$integration"
        />
      }
      size="sm"
      variant="secondary"
    >
      <span className="grid">
        <span className="col-start-1 row-start-1 flex items-center justify-center gap-1 transition-opacity duration-150 group-hover/button:opacity-0 group-focus-visible/button:opacity-0">
          <CheckIcon aria-hidden="true" className="size-3.5" />
          <Trans context="state of one app">Connected</Trans>
        </span>
        <span className="col-start-1 row-start-1 opacity-0 transition-opacity duration-150 group-hover/button:opacity-100 group-focus-visible/button:opacity-100">
          <Trans>Manage</Trans>
        </span>
      </span>
    </Button>
  );
};

/** The row's button: what this person can do about the app now. */
const IntegrationButton = ({
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
  if (state === "needs_reauth") {
    return again === undefined ? (
      <Badge variant="outline">
        <span
          aria-hidden="true"
          className="bg-status-attention size-1.75 rounded-full"
        />
        <Trans>Needs signing in again</Trans>
      </Badge>
    ) : (
      <>
        <Button
          aria-label={t`Sign in to ${app} again`}
          onClick={() => {
            setOpen(true);
          }}
          size="sm"
          variant="outline"
        >
          <span
            aria-hidden="true"
            className="bg-status-attention size-1.75 rounded-full"
          />
          <Trans>Sign in again</Trans>
        </Button>
        <ConnectDialog
          again={again}
          identity={identity}
          integration={integration}
          onOpenChange={setOpen}
          open={open}
        />
      </>
    );
  }
  if (state !== "not_connected") {
    return <ManageLink integration={integration} shared={state === "shared"} />;
  }
  if (!canConnect(integration, identity)) {
    return null;
  }
  return (
    <>
      <Button
        aria-label={t`Connect ${app}`}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Connect</Trans>
      </Button>
      <ConnectDialog
        identity={identity}
        integration={integration}
        onOpenChange={setOpen}
        open={open}
      />
    </>
  );
};

/** For whom it is connected, once it is: everyone, or this person alone. */
const ScopeBadge = ({ integration }: { integration: Integration }) => {
  const state = stateOf(integration);
  if (state === "shared") {
    return (
      <Badge variant="secondary">
        <Trans>For everyone</Trans>
      </Badge>
    );
  }
  return state === "personal" ? (
    <Badge variant="secondary">
      <Trans>Only you</Trans>
    </Badge>
  ) : null;
};

/** What the app is for: its kinds, and how many tools it has. */
const About = ({ integration }: { integration: Integration }) => {
  const { t } = useLingui();
  const { toolCount } = integration;
  const tools =
    toolCount === undefined
      ? undefined
      : t`${plural(toolCount, { one: "# tool", other: "# tools" })}`;
  const kinds =
    integration.categories.length === 0
      ? undefined
      : formatList(integration.categories);
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
      {kinds === undefined ? null : <span className="truncate">{kinds}</span>}
      {kinds === undefined || tools === undefined ? null : (
        <span aria-hidden="true">·</span>
      )}
      {tools === undefined ? null : <span className="flex-none">{tools}</span>}
    </span>
  );
};

/** One app: its tile, name and what it is for, and its button. No frame. */
export const IntegrationRow = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => (
  <li className="flex min-h-16 items-center gap-3 py-2">
    <AppLogo name={integration.name} />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <Link
          className="w-fit max-w-full truncate font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
          params={{ integration: integration.key }}
          to="/integrations/$integration"
        >
          {integration.name}
        </Link>
        <ScopeBadge integration={integration} />
        {integration.listed && !integration.offered ? (
          <Badge variant="outline">
            <Trans>Not offered</Trans>
          </Badge>
        ) : null}
      </span>
      <About integration={integration} />
    </div>
    <IntegrationButton identity={identity} integration={integration} />
  </li>
);
