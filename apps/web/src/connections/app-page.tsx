import type { CatalogTool } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { useLingui } from "@lingui/react/macro";

import { AppPage } from "../grasp/blocks/app-integration/app-integration.tsx";
import type { AppToolChoice } from "../grasp/blocks/app-integration/app-integration.tsx";
import { toast } from "../grasp/toast/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useAppActions } from "./app-actions.tsx";
import { useAppOf } from "./app-of.tsx";
import { FollowLinks } from "./follow-links.tsx";
import type { Integration } from "./integrations.ts";
import {
  allowedOf,
  changeableConnectionOf,
  toolRules,
  withChoices,
} from "./tool-choices.ts";
import { useChange } from "./use-change.ts";

// An app's own page, as the library's app page draws it: its head in the
// app's own colour with what can be done to it, what Grasp may do with
// each group of its tools beside its connection, who can use it and the
// workflows that use it. An admin changes what Grasp may do in a shared
// Composio connection (GRA-993): each change goes to core at once with
// what the page showed (connect refuses it when that changed meanwhile,
// and the page is read again), and the last tool allowed can't be taken
// away (disconnect instead). Everyone else, Grasp staff included, reads
// it; a native connector's tools are fixed.

/** One app's page, its actions' dialogs beside it. */
export const IntegrationAppPage = ({
  integration,
  identity,
  tools,
  uses,
}: {
  integration: Integration;
  identity: Identity;
  /** The read of its tools; none for an app the catalog doesn't list. */
  tools: Loaded<CatalogTool[]> | undefined;
  /** Which workflows use each connection, once read. */
  uses: Loaded<ConnectionWorkflows[]> | undefined;
}) => {
  const { t } = useLingui();
  const appOf = useAppOf(identity);
  const { busy, change } = useChange();
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
  });
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
  return (
    <FollowLinks>
      <AppPage
        app={app}
        editable={changeable !== undefined}
        onToolsChange={changeTools}
        {...actions}
        // The library takes no Connect for a member's app; an admin's is only
        // missing while its tools load, or where none can connect it.
        {...(isAdmin(identity.role) ? { words: { adminConnects: "" } } : {})}
      />
      {dialogs}
    </FollowLinks>
  );
};
