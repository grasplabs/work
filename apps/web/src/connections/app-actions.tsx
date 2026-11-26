import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { useRef, useState } from "react";
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
  goTo,
  returnToOf,
  signInAgainTarget,
  signInHostOf,
} from "./connect-dialog.tsx";
import { DisconnectDialog, mayDisconnect } from "./connection-list.tsx";
import { fixOf } from "./fix.ts";
import type { Integration } from "./integrations.ts";
import { connectionLabel, reliedOnLapsed } from "./integrations.ts";
import { allowedOf, toolRules } from "./tool-choices.ts";

// What can be done to an app from its panel and its page, as its app
// parts offer it (`AppActions`, app/parts.tsx): connect it, sign in to it again,
// connect another account, or disconnect it. Core and connect check every
// one; this offers only what the person's role can do.
//
// Every app connects in the app parts' connect dialog (app/connect-app.tsx),
// which grows from the part's Connect. Grasp's own connectors (Microsoft, Google) in ConnectApp:
// who uses it (an admin chooses; anyone else connects it for themselves),
// where they'll sign in, and Sign in. A Composio toolkit in
// ConnectAppConsent, always for everyone: the consent word for word and
// what Grasp may do with each tool; connect records a hash of the exact
// text the admin was shown and the tools as the ones they chose. One that
// stopped working is connected again the same way: a new connection beside
// the stopped one, starting from what the stopped one allowed and nothing
// more, which stays until someone disconnects it (its row on the app's page
// says it can go once one of the same account works, connection-list.tsx).
// Only a toolkit that takes a key replaces its stopped key as the new one
// is added: connect keeps one key connection of a toolkit. The steps
// dialog (connect-dialog.tsx) is left for what this one can't do: a toolkit
// that takes a key (its fields), one whose tools couldn't be read (it
// reads them again, and says why not), signing in again and connecting
// another account.

/**
 * Connecting a Composio toolkit from the app parts' dialog. Connecting it
 * again, once it stopped working, is a new connection (Composio's account
 * can't be signed in to again) beside the stopped one, which stays as it
 * is until someone disconnects it.
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
    try {
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

/**
 * Connecting one of Grasp's own connectors, or a connector made from a URL
 * whose server signs in, from the app parts' dialog. Its
 * Sign in follows the start, so it can't be pressed again meanwhile; and
 * only the newest start sends the browser away, should an older one, from
 * the dialog opened before, answer later.
 */
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
  const newest = useRef(0);
  // A native suite by its provider, a connector made from a URL by its ID.
  const provider =
    integration.source === "connector"
      ? integration.id
      : oauthProviderSchema.safeParse(integration.id).data;
  if (provider === undefined) {
    return null;
  }
  const app = integration.name;
  const connect = async ({ forWhom }: ConnectAppChoice): Promise<void> => {
    newest.current += 1;
    const mine = newest.current;
    const start = async (): Promise<void> => {
      const started = await core.withSession(
        async (session) =>
          await session.connections.start({
            provider,
            scope: forWhom === "everyone" ? "shared" : "personal",
            returnTo: returnToOf(integration.key),
          })
      );
      if (newest.current === mine) {
        // The browser leaves for the provider's sign-in.
        goTo(started);
      }
    };
    const started = start();
    toast.promise(started, {
      loading: t`Waiting for ${app}`,
      error: (error) => failureText(error),
    });
    await started;
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
 * Which dialog this person's Connect opens, when they may connect the app:
 * the app parts' for a native connector not yet connected, or for a toolkit
 * not yet connected (or stopped) once its tools are read; the steps dialog for a toolkit
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
  // A connector made from a URL signs in as a native suite does, or takes
  // a key, which the steps dialog asks for.
  if (integration.source !== "composio") {
    if (!none) {
      return undefined;
    }
    return integration.auth === "key" ? "dialog" : "native";
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
  uses,
  size,
  accountRows,
}: {
  integration: Integration;
  identity: Identity;
  /** The app as the part draws it, for the connect dialog's head and tools. */
  app: App;
  /** The read of its tools: a toolkit's Connect waits for it. */
  tools: Loaded<CatalogTool[]> | undefined;
  /** Which workflows use each connection, once read: one they use is relied on. */
  uses: readonly ConnectionWorkflows[] | undefined;
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
  const stopped = stoppedOf(integration, identity, uses);
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
