import type { CatalogTool } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { useAppActions, useMenuDisconnect } from "./app-actions.tsx";
import { useAppOf, useSettled } from "./app-of.tsx";
import { AppPanel } from "./app/panel.tsx";
import { waitsForAdmin } from "./connect-dialog.tsx";
import { FollowLinks } from "./follow-links.tsx";
import type { Integration } from "./integrations.ts";
import type { ConnectionUses } from "./workflows-using.tsx";

// One app over the Integrations page, in its app panel (app/panel.tsx):
// its head in the app's own colour with
// Connect or Manage and its Settings (its own page), the account it is
// connected with, what its tools can do, and the workflows that use it.
// Focus goes back to the tile it was opened from. Its tools are read once a tab
// first opens it: an app can have hundreds.

/** An app's tools, as one read of them: the same read each time it opens. */
interface ToolsRead {
  tools: Promise<Loaded<CatalogTool[]>>;
}

/**
 * Each app's tools, read once a tab first opens it and kept for as long as
 * the tab is; a read that failed is forgotten, so the next open reads again.
 */
const toolsRead = new WeakMap<CoreConnection, Map<string, ToolsRead>>();

/** `integration`'s tools: the read from before, or a new one. */
const toolsOf = (core: CoreConnection, integration: Integration): ToolsRead => {
  const known = toolsRead.get(core) ?? new Map<string, ToolsRead>();
  toolsRead.set(core, known);
  const before = known.get(integration.key);
  if (before !== undefined) {
    return before;
  }
  const tools = loadFromCore(
    core,
    async (session) =>
      await session.connections.catalogTools(integration.source, integration.id)
  );
  const read = { tools };
  known.set(integration.key, read);
  void (async () => {
    const { state } = await tools;
    if (state !== "ready" && known.get(integration.key) === read) {
      known.delete(integration.key);
    }
  })();
  return read;
};

/** The open app, over the page: it never squeezes the tiles. */
export const IntegrationPanel = ({
  integration,
  identity,
  uses,
  onClose,
}: {
  integration: Integration;
  identity: Identity;
  uses: ConnectionUses;
  onClose: () => void;
}) => {
  const core = useCore();
  const appOf = useAppOf(identity);
  // Once as the panel opens (it is keyed by the app), not with every render.
  // oxlint-disable-next-line react/hook-use-state -- fixed at mount, never set
  const [read] = useState(() =>
    integration.listed ? toolsOf(core, integration) : undefined
  );
  const tools = useSettled(read?.tools);
  const used = useSettled(uses);
  const app = appOf(integration, {
    size: "default",
    tools: tools?.state === "ready" ? tools.data : undefined,
    uses: used?.state === "ready" ? used.data : undefined,
  });
  const { actions, dialogs } = useAppActions({
    integration,
    identity,
    app,
    tools,
    size: "xs",
    accountRows: false,
  });
  const disconnect = useMenuDisconnect(integration, identity);
  return (
    <FollowLinks>
      <AppPanel
        app={app}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        settingsHref={`/integrations/${integration.key}`}
        {...actions}
        {...disconnect.actions}
        member={waitsForAdmin(integration, identity)}
      />
      {dialogs}
      {disconnect.dialog}
    </FollowLinks>
  );
};
