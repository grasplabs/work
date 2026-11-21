import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
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
import {
  ConnectApp,
  ConnectAppConsent,
} from "../grasp/blocks/connect-app/connect-app.tsx";
import type {
  ConnectAppChoice,
  ConnectAppConsentChoice,
} from "../grasp/blocks/connect-app/connect-app.tsx";
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
import { DisconnectDialog, mayDisconnect } from "./connection-list.tsx";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";
import { reliedOnLapsed } from "./integrations.ts";
import { allowedOf, toolRules } from "./tool-choices.ts";

// What can be done to an app from its panel and its page, as the library's
// app parts offer it (their `AppActions`): connect it, sign in to it again,
// connect another account, or disconnect it. Core and connect check every
// one; this offers only what the person's role can do.
//
// Every app connects in the library's connect dialog, which grows from the
// part's Connect. Grasp's own connectors (Microsoft, Google) in ConnectApp:
// who uses it (an admin chooses; anyone else connects it for themselves),
// where they'll sign in, and Sign in. A Composio toolkit in
// ConnectAppConsent, always for everyone: the consent word for word and
// what Grasp may do with each tool; connect records a hash of the exact
// text the admin was shown and the tools as the ones they chose. One that
// stopped working is connected again the same way, its stopped connections
// disconnected first. Our own connect dialog is left for what the library's
// can't do: a toolkit that takes a key (its fields), one whose tools
// couldn't be read (it reads them again, and says why not), signing in
// again and connecting another account.

/**
 * Connecting a Composio toolkit from the library's dialog. Connecting it
 * again, once it stopped working, disconnects the connections that stopped
 * first: Composio's account can't be signed in to again, and the same
 * account can't be connected twice.
 */
const ConnectToolkit = ({
  app: shown,
  integration,
  replacing,
  catalog,
  size,
}: {
  app: App;
  integration: Integration;
  /** The connections that stopped working, which connecting again replaces. */
  replacing: readonly ListedConnection[];
  /** The toolkit's tools as the catalog lists them now. */
  catalog: readonly CatalogTool[];
  size: "xs" | "sm";
}) => {
  const core = useCore();
  const [old] = replacing;
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
    try {
      const started = await core.withSession(async (session) => {
        await Promise.all(
          replacing.map(
            async ({ id }) => await session.connections.disconnect(id)
          )
        );
        return await session.connections.connectToolkit({
          toolkit: integration.id,
          tools: toolRules(allowed),
          // Word for word what the dialog showed: core records its hash.
          consent,
          returnTo: returnToOf(integration.key),
        });
      });
      // The browser leaves for the provider's sign-in.
      goTo(started);
    } catch (error) {
      toast.error(failureText(error));
      throw error;
    }
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

/**
 * Which dialog this person's Connect opens, when they may connect the app:
 * the library's for a native connector not yet connected, or for a toolkit
 * not yet connected (or stopped) once its tools are read; ours for a toolkit
 * that takes a key, or whose tools couldn't be read, as it asks for the key,
 * or reads them again and says why not.
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
  const [native, setNative] = useState<Native>();
  const connectable = canConnect(integration, identity);
  const none = integration.connections.length === 0;
  const again = signInAgainTarget(integration, identity);
  const openNative = (target?: ListedConnection) => () => {
    setNative({ again: target });
  };
  const actions: AppActions = {};
  const stopped = stoppedOf(integration, identity);
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
        replacing={stopped}
        size={size}
      />
    );
  } else if (way === "dialog") {
    actions.onConnect = openNative();
  }
  if (again !== undefined && !accountRows) {
    actions.onSignIn = openNative(again);
  }
  if (connectable && !none && integration.source === "native") {
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
      replacing={stopped}
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
