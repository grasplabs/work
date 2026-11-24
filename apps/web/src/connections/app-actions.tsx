import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ConnectApp, ConnectAppConsent } from "./app/connect-app.tsx";
import type {
  ConnectAppChoice,
  ConnectAppConsentChoice,
} from "./app/connect-app.tsx";
import type { App } from "./app/model.ts";
import type { AppActions } from "./app/parts.tsx";
import {
  canConnect,
  ConnectDialog,
  leaveFor,
  returnToOf,
  signInAgainTarget,
  signInHostOf,
} from "./connect-dialog.tsx";
import { DisconnectDialog, mayDisconnect } from "./connection-list.tsx";
import { connectsAgainBeside, lapsedOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";
import { allowedOf, toolRules } from "./tool-choices.ts";

// What can be done to an app from its panel and its page, as its app
// parts offer it (`AppActions`, app/parts.tsx): connect it, sign in to it again,
// connect another account, or disconnect it. Core and connect check every
// one; this offers only what the person's role can do.
//
// Every app connects in the app parts' connect dialog (app/connect-app.tsx),
// opened from the part's Connect. Grasp's own connectors (Microsoft, Google) in ConnectApp:
// who uses it (an admin chooses; anyone else connects it for themselves),
// where they'll sign in, and Sign in. A Composio toolkit in
// ConnectAppConsent, always for everyone: the consent word for word and
// what Grasp may do with each tool; connect records a hash of the exact
// text the admin was shown and the tools as the ones they chose. One that
// stopped working is connected again the same way: a new connection beside
// the stopped one, which stays until someone disconnects it (its row says
// it can go once one works, connection-list.tsx). Nothing here ever
// disconnects anything by itself. The steps dialog (connect-dialog.tsx) is left for
// what that one doesn't do: a toolkit that takes a key (its fields), one
// whose tools couldn't be read (it reads them again, and says why not),
// signing in again and connecting another account.

/**
 * Connecting a Composio toolkit from the app parts' dialog. Connecting it
 * again, once it stopped working, is a new connection (Composio's account
 * can't be signed in to again), starting from what the stopped one
 * allowed; the stopped one stays as it is until it is disconnected.
 */
const ConnectToolkit = ({
  app: shown,
  integration,
  stopped,
  catalog,
  size,
}: {
  app: App;
  integration: Integration;
  /** The connections that stopped working, beside which it is connected again. */
  stopped: readonly ListedConnection[];
  /** The toolkit's tools as the catalog lists them now. */
  catalog: readonly CatalogTool[];
  size: "xs" | "sm";
}) => {
  const core = useCore();
  const [old] = stopped;
  // What the old connection allowed of what the catalog still lists: where
  // connecting again starts, each tool keeping the resource it was held to.
  const listed = new Set(catalog.map(({ name }) => name));
  const before =
    old === undefined
      ? []
      : allowedOf(old).filter(({ name }) => listed.has(name));
  const resources = new Map(
    before.map(({ name, resource }) => [name, resource])
  );
  const connect = async ({
    tools,
    consent,
  }: ConnectAppConsentChoice): Promise<void> => {
    const allowed = tools
      .filter(({ choice }) => choice !== "never")
      .map(({ id, choice }) => {
        const resource = resources.get(id);
        return {
          name: id,
          read: choice === "read",
          ...(resource === undefined ? {} : { resource }),
        };
      });
    const started = await core.withSession(
      async (session) =>
        await session.connections.connectToolkit({
          toolkit: integration.id,
          tools: toolRules(allowed),
          // Word for word what the dialog showed: core records its hash.
          consent,
          returnTo: returnToOf(integration.key),
        })
    );
    // The browser leaves for the provider's sign-in.
    await leaveFor(started);
  };
  return (
    <ConnectAppConsent
      again={old !== undefined}
      {...(old === undefined
        ? {}
        : {
            initialTools: before.map(({ name, read }) => ({
              id: name,
              choice: read ? ("read" as const) : ("write" as const),
            })),
          })}
      app={shown}
      consent={composioConsentText}
      forWhom="everyone"
      onConnect={connect}
      size={size}
    />
  );
};

/** Connecting one of Grasp's own connectors from the app parts' dialog. */
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
  const provider = oauthProviderSchema.safeParse(integration.id);
  if (!provider.success) {
    return null;
  }
  const connect = async ({ forWhom }: ConnectAppChoice): Promise<void> => {
    const started = await core.withSession(
      async (session) =>
        await session.connections.start({
          provider: provider.data,
          scope: forWhom === "everyone" ? "shared" : "personal",
          returnTo: returnToOf(integration.key),
        })
    );
    // The browser leaves for the provider's sign-in.
    await leaveFor(started);
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
 * Which dialog this person's Connect opens, when they may connect the app:
 * the app parts' for a native connector not yet connected, or for a toolkit
 * not yet connected (or stopped) once its tools are read; the steps dialog
 * for a toolkit that takes a key, or whose tools couldn't be read, as it
 * asks for the key, or reads them again and says why not.
 */
const connectWayOf = (
  integration: Integration,
  identity: Identity,
  tools: Loaded<CatalogTool[]> | undefined,
  stopped: readonly ListedConnection[]
): "native" | "toolkit" | "dialog" | undefined => {
  if (!canConnect(integration, identity)) {
    return undefined;
  }
  const none = integration.connections.length === 0;
  if (integration.source === "native") {
    return none ? "native" : undefined;
  }
  if (!none && stopped.length === 0) {
    return undefined;
  }
  if (
    integration.auth !== "key" &&
    tools?.state === "ready" &&
    tools.data.length > 0
  ) {
    return "toolkit";
  }
  return tools === undefined ? undefined : "dialog";
};

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
  accountRows,
}: {
  integration: Integration;
  identity: Identity;
  /** The app as the part draws it, for the connect dialog's head and tools. */
  app: App;
  /** The read of its tools: a toolkit's Connect waits for it. */
  tools: Loaded<CatalogTool[]> | undefined;
  size: "xs" | "sm";
  /**
   * Whether the host draws a row for each account, which offers signing in
   * again to it: the app's page does, so its Manage menu doesn't; the panel
   * has no rows.
   */
  accountRows: boolean;
}): { actions: AppActions; dialogs: ReactNode } => {
  const { t } = useLingui();
  const [native, setNative] = useState<Native>();
  const connectable = canConnect(integration, identity);
  const none = integration.connections.length === 0;
  const again = signInAgainTarget(integration, identity);
  const openNative = (target?: ListedConnection) => () => {
    setNative({ again: target });
  };
  const actions: AppActions = {};
  const lapsed = lapsedOf(integration, identity);
  const stopped = connectsAgainBeside(integration, identity);
  const way = connectWayOf(integration, identity, tools, stopped);
  if (way === "native") {
    actions.connect = (
      <ConnectNative
        app={app}
        identity={identity}
        integration={integration}
        size={size}
      />
    );
  } else if (way === "toolkit") {
    actions.connect = (
      <ConnectToolkit
        app={app}
        catalog={tools?.state === "ready" ? tools.data : []}
        integration={integration}
        size={size}
        stopped={stopped}
      />
    );
  } else if (way === "dialog") {
    actions.onConnect = openNative();
  }
  if (again !== undefined && !accountRows) {
    actions.onSignIn = openNative(again);
  }
  // A second account: a native connector's, or a toolkit's that signs in
  // beside one that works (a stopped one is connected again instead). A
  // key stays the toolkit's one.
  const another =
    integration.source === "native" ||
    (integration.auth === "managed" && stopped.length === 0);
  if (connectable && !none && another) {
    actions.onConnectAnother = openNative();
  }
  if (connectable && integration.auth === "key" && lapsed.length > 0) {
    actions.whyNoConnect = t`The key that stopped working must be disconnected before a new one can be added.`;
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
      stopped={stopped.length > 0}
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
  const { name } = integration;
  return {
    actions: {
      onDisconnect: () => {
        setOpen(true);
      },
    },
    dialog: (
      <DisconnectDialog
        connection={removable}
        label={
          removable.accountName === null
            ? name
            : `${name} (${removable.accountName})`
        }
        last={!integration.listed}
        onOpenChange={setOpen}
        open={open}
      />
    ),
  };
};
