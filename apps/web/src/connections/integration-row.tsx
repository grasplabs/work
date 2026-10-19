import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { AppLogo } from "./app-logo.tsx";
import { canConnect, canReconnect, ConnectDialog } from "./connect-dialog.tsx";
import type { Integration } from "./integrations.ts";
import { kindOf, stateOf } from "./integrations.ts";

// One app in the Integrations list, as the prototype's row
// (`components/integration-row.tsx`, `integration-button.tsx`): its tile,
// its name to open it, what it is for, and its button: Connect, Sign in
// again, or Connected, which says Manage under the pointer or focus.

/**
 * Measures the two labels of a Manage button, so it slides from one's
 * width to the other's, and keeps a strip on its left while it is narrower,
 * so the pointer stays on it and it does not flicker back. Measured again
 * once the fonts are in.
 */
const measureFaces = (element: HTMLElement | null): void => {
  if (element === null) {
    return;
  }
  const measure = () => {
    const [connected, manage] =
      element.querySelectorAll<HTMLElement>("[data-face]");
    if (connected === undefined || manage === undefined) {
      return;
    }
    element.style.setProperty("--face", `${connected.offsetWidth}px`);
    element.style.setProperty("--face-hover", `${manage.offsetWidth}px`);
    element.style.setProperty(
      "--face-slack",
      `${Math.max(0, connected.offsetWidth - manage.offsetWidth)}px`
    );
  };
  const measureOnceFontsAreIn = async (): Promise<void> => {
    await document.fonts.ready;
    measure();
  };
  measure();
  void measureOnceFontsAreIn();
};

/**
 * Connected, which becomes Manage under the pointer or keyboard focus: the
 * two labels cross-fade and the button slides to the new label's width.
 * Its labels change width with the language, so the page mounts it again
 * for another language (`key`).
 */
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
      className="relative"
      ref={measureFaces}
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
      <span
        aria-hidden="true"
        className="absolute inset-y-0 right-full hidden w-(--face-slack) group-hover/button:block"
      />
      <span className="block w-(--face) overflow-hidden transition-all duration-200 ease-out group-hover/button:w-(--face-hover) group-focus-visible/button:w-(--face-hover)">
        <span className="grid w-max">
          <span
            className="col-start-1 row-start-1 flex w-max items-center gap-1 transition-opacity duration-150 group-hover/button:opacity-0 group-focus-visible/button:opacity-0"
            data-face
          >
            <CheckIcon aria-hidden="true" className="size-3.5" />
            <Trans context="state of one app">Connected</Trans>
          </span>
          <span
            className="col-start-1 row-start-1 w-max opacity-0 transition-opacity duration-150 group-hover/button:opacity-100 group-focus-visible/button:opacity-100"
            data-face
          >
            <Trans>Manage</Trans>
          </span>
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
  const { t, i18n } = useLingui();
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
    return (
      <ManageLink
        integration={integration}
        key={i18n.locale}
        shared={state === "shared"}
      />
    );
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

/**
 * One app, as the prototype's row: its logo, its name to open it, what kind
 * of app it is, and its button. What it does, in a sentence, shows when it
 * is pointed at. No frame. An app the organization doesn't offer says so to
 * the admins who see it.
 */
export const IntegrationRow = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => (
  <li className="flex h-14 min-w-0 items-center gap-3">
    <AppLogo logo={integration.logo} name={integration.name} />
    <div
      className="flex min-w-0 flex-1 flex-col gap-0.5"
      title={integration.description ?? undefined}
    >
      <Link
        className="w-fit max-w-full truncate font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
        params={{ integration: integration.key }}
        to="/integrations/$integration"
      >
        {integration.name}
      </Link>
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
        <span className="truncate">{kindOf(integration)}</span>
        {integration.listed && !integration.offered ? (
          <Badge variant="outline">
            <Trans>Not offered</Trans>
          </Badge>
        ) : null}
        {integration.auth === "own" ? (
          <Badge variant="outline">
            <Trans>Needs your own sign-in app</Trans>
          </Badge>
        ) : null}
      </span>
    </div>
    <IntegrationButton identity={identity} integration={integration} />
  </li>
);
