import type { ListedConnection } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { useState } from "react";
import type { ReactNode } from "react";

import type { AppActions } from "./app/parts.tsx";
import {
  canConnect,
  ConnectDialog,
  signInAgainTarget,
} from "./connect-dialog.tsx";
import { DisconnectDialog, mayDisconnect } from "./connection-list.tsx";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";
import { connectionLabel, reliedOnLapsed } from "./integrations.ts";

// What can be done to an app from its panel and its page, as its app
// parts offer it (`AppActions`, app/parts.tsx): connect it, sign in to it again,
// connect another account, or disconnect it. Core and connect check every
// one; this offers only what the person's role can do.
//
// Every app connects in the one connect dialog (connect-dialog.tsx), as
// onboarding does: a native connector (Microsoft, Google), or a connector
// made from a URL whose server signs in, asks an admin who uses it, then
// signs in; one made from a URL that takes a key asks for it; a Composio
// toolkit asks what Grasp may do, with the consent word for word. One that
// stopped working is connected again the same way: a new connection beside
// the stopped one, starting from what the stopped one allowed and nothing
// more, which stays until someone disconnects it (its row on the app's page
// says it can go once one of the same account works, connection-list.tsx).
// Only a toolkit that takes a key replaces its stopped key as the new one
// is added: connect keeps one key connection of a toolkit.

/**
 * The connection this person may disconnect from the app panel's Manage
 * menu: its only one, where they may disconnect it. With more, each is
 * disconnected from its own row on the app's page.
 */
const removableOf = (
  integration: Integration,
  identity: Identity
): ListedConnection | undefined => {
  const [only, ...more] = integration.connections;
  return only !== undefined &&
    more.length === 0 &&
    mayDisconnect(only, identity)
    ? only
    : undefined;
};

/**
 * A toolkit's connections that stopped working, which an admin connects
 * again beside (a key toolkit's, replaced by the new key); none while one
 * the company relies on still works, or for anyone else. One a workflow
 * uses is relied on, as the app's state says (`primaryOf`, app-of.tsx).
 */
const stoppedOf = (
  integration: Integration,
  identity: Identity,
  uses: readonly ConnectionWorkflows[] | undefined
): ListedConnection[] =>
  integration.source === "composio" &&
  fixOf(integration, identity) === "reconnect" &&
  reliedOnLapsed(integration, uses)
    ? integration.connections.filter(
        ({ status, scope }) => status === "needs_reauth" && scope === "shared"
      )
    : [];

/**
 * Whether this person's Connect opens the connect dialog: for an app they
 * may connect that isn't connected yet, or a toolkit that stopped working.
 */
const connectsNow = (
  integration: Integration,
  identity: Identity,
  stopped: readonly ListedConnection[]
): boolean =>
  canConnect(integration, identity) &&
  (integration.connections.length === 0 ||
    (integration.source === "composio" && stopped.length > 0));

/** What the dialog is open for: connecting (again, beside `from`), or signing in again to one connection. */
type Open =
  | { again: ListedConnection | undefined; from?: ListedConnection }
  | undefined;

/**
 * The actions an app's panel or page offers this person, and the dialogs
 * they open, to draw beside the part.
 */
export const useAppActions = ({
  integration,
  identity,
  uses,
  accountRows,
}: {
  integration: Integration;
  identity: Identity;
  /** Which workflows use each connection, once read: one they use is relied on. */
  uses: readonly ConnectionWorkflows[] | undefined;
  /**
   * Whether the host draws a row for each account, which offers signing in
   * again to it: the app's page does, so its Manage menu doesn't; the panel
   * has no rows.
   */
  accountRows: boolean;
}): { actions: AppActions; dialogs: ReactNode } => {
  const [native, setNative] = useState<Open>();
  const connectable = canConnect(integration, identity);
  const none = integration.connections.length === 0;
  const again = signInAgainTarget(integration, identity);
  const openNative = (target?: ListedConnection) => () => {
    setNative({ again: target });
  };
  const actions: AppActions = {};
  const stopped = stoppedOf(integration, identity, uses);
  if (connectsNow(integration, identity, stopped)) {
    const [from] = stopped;
    actions.onConnect = () => {
      setNative({ again: undefined, ...(from === undefined ? {} : { from }) });
    };
  }
  if (again !== undefined && !accountRows) {
    actions.onSignIn = openNative(again);
  }
  // A second account: a native connector's, or a toolkit's that signs in
  // (an admin's, beside one that works: a stopped one is connected again
  // instead). A key stays the toolkit's one.
  if (
    connectable &&
    !none &&
    (integration.source !== "composio" ||
      (integration.auth === "managed" && stopped.length === 0))
  ) {
    actions.onConnectAnother = openNative();
  }
  const dialogs = (
    <ConnectDialog
      {...(native?.again === undefined ? {} : { again: native.again })}
      identity={identity}
      integration={integration}
      onOpenChange={(open) => {
        if (!open) {
          setNative(undefined);
        }
      }}
      open={native !== undefined}
      // Only a stopped key goes as the new one comes: connect keeps one.
      replacing={integration.auth === "key" ? stopped : []}
      {...(native?.from === undefined ? {} : { startFrom: native.from })}
    />
  );
  return { actions, dialogs };
};

/**
 * Disconnect in the app panel's Manage menu, and the dialog it opens. The
 * app's page has none there: each of its account rows has its own.
 */
export const useMenuDisconnect = (
  integration: Integration,
  identity: Identity
): { actions: Pick<AppActions, "onDisconnect">; dialog: ReactNode } => {
  const [open, setOpen] = useState(false);
  const removable = removableOf(integration, identity);
  if (removable === undefined) {
    return { actions: {}, dialog: null };
  }
  return {
    actions: {
      onDisconnect: () => {
        setOpen(true);
      },
    },
    dialog: (
      <DisconnectDialog
        connection={removable}
        label={connectionLabel(removable, integration)}
        last={!integration.listed}
        onOpenChange={setOpen}
        open={open}
      />
    ),
  };
};
