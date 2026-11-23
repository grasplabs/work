import type { CatalogTool } from "@grasp-os/shared/connect";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { useAppActions } from "./app-actions.tsx";
import { useAppOf } from "./app-of.tsx";
import type { AppToolChoice } from "./app/model.ts";
import { AppPage } from "./app/page.tsx";
import { waitsForAdmin } from "./connect-dialog.tsx";
import {
  AccountActions,
  StoppedNotice,
  stoppedBesideWorking,
} from "./connection-list.tsx";
import { FollowLinks } from "./follow-links.tsx";
import type { Integration } from "./integrations.ts";
import {
  allowedOf,
  changeableConnectionOf,
  toolRules,
  withChoices,
} from "./tool-choices.ts";
import { useChange } from "./use-change.ts";

// An app's own page (app/page.tsx), in one column:
// its head in the app's own colour with what can be done to it, a row for
// each account (who connected it and when, who can use it, where it
// stands, and signing in again and disconnecting from its own buttons),
// the workflows that use it, what Grasp may do with each group of its
// tools, and under them what the host adds. An admin changes what Grasp
// may do in a shared Composio connection (GRA-993): each change goes to
// core at once with what the page showed (connect refuses it when that
// changed meanwhile, and the page is read again), and the last tool
// allowed can't be taken away (disconnect instead). Everyone else, Grasp
// staff included, reads it; a native connector's tools are fixed. A change
// that didn't go through says why beside its control (the tools, or the
// offered switch), never in a toast. A row that stopped working beside a
// shared connection that works says it can go now, to whoever may
// disconnect it.

/** One app's page, its actions' dialogs beside it. */
export const IntegrationAppPage = ({
  integration,
  identity,
  tools,
  uses,
  children,
}: {
  integration: Integration;
  identity: Identity;
  /** The read of its tools; none for an app the catalog doesn't list. */
  tools: Loaded<CatalogTool[]> | undefined;
  /** Which workflows use each connection, once read. */
  uses: Loaded<ConnectionWorkflows[]> | undefined;
  /** What the page shows under its own sections: its notices, each connection's access. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const appOf = useAppOf(identity);
  const toolsChange = useChange();
  const offerChange = useChange();
  const busy = toolsChange.busy || offerChange.busy;
  // The last tool allowed, kept: said over the tools like a refused change.
  const [lastTool, setLastTool] = useState<string>();
  const app = appOf(integration, {
    size: "lg",
    tools: tools?.state === "ready" ? tools.data : undefined,
    uses: uses?.state === "ready" ? uses.data : undefined,
  });
  const { actions, dialogs } = useAppActions({
    integration,
    identity,
    app,
    tools,
    size: "sm",
    accountRows: true,
  });
  // Each account row's own Sign in again and Disconnect, so their dialogs
  // grow from them.
  const rowActions = new Map(
    integration.connections.map((connection) => [
      connection.id,
      <AccountActions
        connection={connection}
        identity={identity}
        integration={integration}
        key={connection.id}
      />,
    ])
  );
  const rowNotes = new Map(
    integration.connections
      .filter((connection) =>
        stoppedBesideWorking(connection, integration, identity)
      )
      .map((connection) => [
        connection.id,
        <StoppedNotice
          connection={connection}
          integration={integration}
          key={connection.id}
        />,
      ])
  );
  const changeable = changeableConnectionOf(integration, identity);
  const changeTools = (
    changes: readonly { id: string; choice: AppToolChoice }[]
  ): void => {
    if (changeable === undefined || busy) {
      return;
    }
    const allowed = allowedOf(changeable);
    const next = withChoices(allowed, changes);
    if (next.length === 0) {
      setLastTool(
        t`A connection allows at least one tool. Disconnect it instead.`
      );
      return;
    }
    setLastTool(undefined);
    void toolsChange.change(async (session) => {
      await session.connections.changeTools({
        connectionId: changeable.id,
        tools: toolRules(next),
        // What this page shows: a change since makes it refused, and the
        // page is read again (`useChange`).
        expected: toolRules(allowed),
      });
    });
  };
  // Whether the app is offered: the organization's own admins choose, never Grasp staff (core refuses them).
  const offers = integration.listed && isMemberAdmin(identity);
  const changeOffered = (offered: boolean): void => {
    if (busy) {
      return;
    }
    void offerChange.change(async (session) => {
      await session.connections.setOffered(
        integration.source,
        integration.id,
        offered
      );
    });
  };
  return (
    <FollowLinks>
      <AppPage
        app={app}
        editable={changeable !== undefined}
        onToolsChange={changeTools}
        {...actions}
        accountActions={(row) => rowActions.get(row.id ?? "")}
        accountNote={(row) => rowNotes.get(row.id ?? "")}
        toolsFailure={lastTool ?? toolsChange.failure}
        member={waitsForAdmin(integration, identity)}
        {...(offers
          ? {
              offered: integration.offered,
              onOfferedChange: changeOffered,
              offeredFailure: offerChange.failure,
            }
          : {})}
      >
        {children}
      </AppPage>
      {dialogs}
    </FollowLinks>
  );
};
