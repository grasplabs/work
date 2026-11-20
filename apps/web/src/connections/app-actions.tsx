import { oauthProviderSchema } from "@grasp-os/shared/connect";
import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import type {
  App,
  AppActions,
} from "../grasp/blocks/app-integration/app-integration.tsx";
import { ConnectApp } from "../grasp/blocks/connect-app/connect-app.tsx";
import type { ConnectAppChoice } from "../grasp/blocks/connect-app/connect-app.tsx";
import { toast } from "../grasp/toast/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import {
  canConnect,
  ConnectDialog,
  goTo,
  returnToOf,
  signInAgainTarget,
  signInHostOf,
} from "./connect-dialog.tsx";
import { DisconnectDialog } from "./connection-list.tsx";
import { fixOf } from "./integrations-header.tsx";
import type { Integration } from "./integrations.ts";
import { reliedOnLapsed } from "./integrations.ts";

// What can be done to an app from its panel and its page, as the library's
// app parts offer it (their `AppActions`): connect it, sign in to it again,
// connect another account, or disconnect it. Core and connect check every
// one; this offers only what the person's role can do.
//
// Grasp's own connectors (Microsoft, Google) connect in the library's
// connect dialog (ConnectApp), which grows from the part's Connect: who
// uses it (an admin chooses; anyone else connects it for themselves), where
// they'll sign in, and Sign in. A Composio toolkit connects in our own
// connect dialog, which shows the consent word for word and the tools to
// allow: connect records a hash of the exact text the admin was shown, and
// the tools as the ones they chose, so neither can be left out or chosen for
// them. Our dialog also signs in again and connects another account.

/** Connecting one of Grasp's own connectors from the library's dialog. */
const ConnectNative = ({
  app: shown,
  integration,
  identity,
  size,
}: {
  app: App;
  integration: Integration;
  identity: Identity;
  size: "xs" | "sm";
}) => {
  const core = useCore();
  const { t } = useLingui();
  const provider = oauthProviderSchema.safeParse(integration.id);
  if (!provider.success) {
    return null;
  }
  const app = integration.name;
  const connect = ({ forWhom }: ConnectAppChoice): void => {
    const start = async (): Promise<void> => {
      const started = await core.withSession(
        async (session) =>
          await session.connections.start({
            provider: provider.data,
            scope: forWhom === "everyone" ? "shared" : "personal",
            returnTo: returnToOf(integration.key),
          })
      );
      // The browser leaves for the provider's sign-in.
      goTo(started);
    };
    toast.promise(start(), {
      loading: t`Waiting for ${app}`,
      error: (error) => failureText(error),
    });
  };
  const signInAt = signInHostOf(integration);
  return (
    <ConnectApp
      app={shown}
      // Only an admin connects one for everyone.
      {...(isAdmin(identity.role) ? {} : { forWhom: "you" as const })}
      {...(signInAt === undefined ? {} : { signInAt })}
      onConnect={connect}
      size={size}
    />
  );
};

/**
 * The connection this person may disconnect from the app's Manage menu:
 * its only one, when it is theirs or they are an admin. With more, each
 * is disconnected from its own card on the app's page.
 */
const removableOf = (
  integration: Integration,
  identity: Identity
): ListedConnection | undefined => {
  const [only, ...more] = integration.connections;
  return only !== undefined &&
    more.length === 0 &&
    (only.scope === "personal" || isAdmin(identity.role)) &&
    !identity.staff
    ? only
    : undefined;
};

/**
 * A toolkit's connections that stopped working, which an admin connects
 * again (disconnecting them first); none while one the company relies on
 * still works, or for anyone else.
 */
const stoppedOf = (
  integration: Integration,
  identity: Identity
): ListedConnection[] =>
  integration.source === "composio" &&
  fixOf(integration, identity) === "reconnect" &&
  reliedOnLapsed(integration)
    ? integration.connections.filter(
        ({ status, scope }) => status === "needs_reauth" && scope === "shared"
      )
    : [];

/** What the native dialog is open for: connecting, or signing in again to one connection. */
type Native = { again: ListedConnection | undefined } | undefined;

/**
 * The actions an app's panel or page offers this person, and the dialogs
 * they open, to draw beside the part.
 */
export const useAppActions = ({
  integration,
  identity,
  app,
  tools,
  size,
}: {
  integration: Integration;
  identity: Identity;
  /** The app as the part draws it, for the connect dialog's head and tools. */
  app: App;
  /** The read of its tools: a toolkit's Connect waits for it. */
  tools: Loaded<CatalogTool[]> | undefined;
  size: "xs" | "sm";
}): { actions: AppActions; dialogs: ReactNode } => {
  const [native, setNative] = useState<Native>();
  const [disconnecting, setDisconnecting] = useState(false);
  const connectable = canConnect(integration, identity);
  const none = integration.connections.length === 0;
  const again = signInAgainTarget(integration, identity);
  const removable = removableOf(integration, identity);
  const openNative = (target?: ListedConnection) => () => {
    setNative({ again: target });
  };
  const actions: AppActions = {};
  const stopped = stoppedOf(integration, identity);
  if (connectable && none && integration.source === "native") {
    actions.connect = (
      <ConnectNative
        app={app}
        identity={identity}
        integration={integration}
        size={size}
      />
    );
  } else if (
    connectable &&
    integration.source === "composio" &&
    (none || stopped.length > 0) &&
    tools !== undefined
  ) {
    // A toolkit, once the read of its tools settled: our dialog reads them
    // again, and says why not where they couldn't be read.
    actions.onConnect = openNative();
  }
  if (again !== undefined) {
    actions.onSignIn = openNative(again);
  }
  if (connectable && !none && integration.source === "native") {
    actions.onConnectAnother = openNative();
  }
  if (removable !== undefined) {
    actions.onDisconnect = () => {
      setDisconnecting(true);
    };
  }
  const { name } = integration;
  const dialogs = (
    <>
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
        replacing={stopped}
      />
      {removable === undefined ? null : (
        <DisconnectDialog
          connection={removable}
          label={
            removable.accountName === null
              ? name
              : `${name} (${removable.accountName})`
          }
          last={!integration.listed}
          onOpenChange={setDisconnecting}
          open={disconnecting}
        />
      )}
    </>
  );
  return { actions, dialogs };
};
