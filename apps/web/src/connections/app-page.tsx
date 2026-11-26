import type { CatalogTool } from "@grasp-os/shared/connect";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { Fragment } from "react";
import type { ReactNode } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { useAppActions } from "./app-actions.tsx";
import { useAppOf } from "./app-of.tsx";
import type { AppToolChoice } from "./app/model.ts";
import { AppPage } from "./app/page.tsx";
import { useAppIntegrationWords } from "./app/words.ts";
import { waitsForAdmin } from "./connect-dialog.tsx";
import {
  AccountActions,
  StoppedNotice,
  stoppedBesideWorking,
} from "./connection-list.tsx";
import { FollowLinks } from "./follow-links.tsx";
import type { Integration } from "./integrations.ts";
import { PartNotLoaded } from "./part-not-loaded.tsx";
import {
  allowedOf,
  changeableConnectionOf,
  toolRules,
  withChoices,
} from "./tool-choices.ts";
import { useChange } from "./use-change.ts";

// An app's own page, as its app page (app/page.tsx) draws it, in one column:
// its head in the app's own colour with what can be done to it, a row for
// each account (who connected it and when, who can use it, where it
// stands, where one reached through the company network goes, and signing
// in again and disconnecting from its own buttons),
// the workflows that use it, what Grasp may do with each group of its
// tools, and under them what the host adds. An admin changes what Grasp
// may do in a shared Composio connection (GRA-993): each change goes to
// core at once with what the page showed (connect refuses it when that
// changed meanwhile, and the page is read again), and the last tool
// allowed can't be taken away (disconnect instead). Everyone else, Grasp
// staff included, reads it; a native connector's tools are fixed.

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
  const words = useAppIntegrationWords();
  const appOf = useAppOf(identity);
  const { busy, change } = useChange();
  // The connection a change of tools goes to: its tools are the ones shown.
  const changeable = changeableConnectionOf(integration, identity);
  const app = appOf(integration, {
    size: "lg",
    tools: tools?.state === "ready" ? tools.data : undefined,
    uses: uses?.state === "ready" ? uses.data : undefined,
    toolsOf: changeable,
  });
  const { actions, dialogs } = useAppActions({
    integration,
    identity,
    app,
    tools,
    uses: uses?.state === "ready" ? uses.data : undefined,
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
  // A row's line under its account: where one reached through the company
  // network goes, and for a stopped one beside one of the same account that
  // works, that it can be disconnected now.
  const rowNotes = new Map(
    integration.connections.flatMap((connection) => {
      const address = connection.companyNetwork;
      const stopped = stoppedBesideWorking(connection, integration, identity);
      if (address === undefined && !stopped) {
        return [];
      }
      return [
        [
          connection.id,
          <Fragment key={connection.id}>
            {address === undefined
              ? null
              : t`Reached through your company network at ${address}.`}
            {address !== undefined && stopped ? " " : null}
            {stopped ? (
              <StoppedNotice
                connection={connection}
                integration={integration}
              />
            ) : null}
          </Fragment>,
        ],
      ];
    })
  );
  const changeTools = (
    changes: readonly { id: string; choice: AppToolChoice }[]
  ): void => {
    if (changeable === undefined || busy) {
      return;
    }
    const allowed = allowedOf(changeable);
    const offered = new Set(
      tools?.state === "ready" ? tools.data.map(({ name }) => name) : []
    );
    const next = withChoices(allowed, changes, offered);
    if (
      JSON.stringify(toolRules(next)) === JSON.stringify(toolRules(allowed))
    ) {
      return;
    }
    if (next.length === 0) {
      toast.error(
        t`A connection allows at least one tool. Disconnect it instead.`
      );
      return;
    }
    void change(
      async (session) => {
        await session.connections.changeTools({
          connectionId: changeable.id,
          tools: toolRules(next),
          // What this page shows: a change since makes it refused, and the
          // page is read again (`useChange`).
          expected: toolRules(allowed),
        });
      },
      (reason) => {
        toast.error(reason);
      }
    );
  };
  // Whether the app is offered: the organization's own admins choose, never Grasp staff (core refuses them).
  const offers = integration.listed && isMemberAdmin(identity);
  const changeOffered = (offered: boolean): void => {
    if (busy) {
      return;
    }
    void change(
      async (session) => {
        await session.connections.setOffered(
          integration.source,
          integration.id,
          offered
        );
      },
      (reason) => {
        toast.error(reason);
      }
    );
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
        member={waitsForAdmin(integration, identity)}
        {...(offers
          ? { offered: integration.offered, onOfferedChange: changeOffered }
          : {})}
      >
        {/* Used by shows only what uses it: a read that failed says so. */}
        {uses === undefined ? null : (
          <PartNotLoaded page={uses} what={words.usedBy} />
        )}
        {children}
      </AppPage>
      {dialogs}
    </FollowLinks>
  );
};
