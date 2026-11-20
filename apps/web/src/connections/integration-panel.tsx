import type { CatalogTool } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";

import type { CoreConnection } from "../core-connection.ts";
import { AppPanel } from "../grasp/blocks/app-integration/app-integration.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { useAppActions, useMenuDisconnect } from "./app-actions.tsx";
import { useAppOf, useSettled } from "./app-of.tsx";
import { waitsForAdmin } from "./connect-dialog.tsx";
import { FollowLinks } from "./follow-links.tsx";
import type { Integration } from "./integrations.ts";
import type { ConnectionUses } from "./workflows-using.tsx";

// One app over the Integrations page, in the library's app panel (Grasp
// UI's app-integration block): its head in the app's own colour with
// Connect or Manage and its Settings (its own page), the account it is
// connected with, what its tools can do, and the workflows that use it.
// It grows from the tile it was opened from. Its tools are read once a tab
// first opens it: an app can have hundreds.

/** An app's tools, as one read of them: the same read each time it opens. */
interface ToolsRead {
  tools: Promise<Loaded<CatalogTool[]>>;
}

/** Each app's tools, read once a tab first opens it, kept for as long as the tab is. */
const toolsRead = new WeakMap<CoreConnection, Map<string, ToolsRead>>();

/**
 * `integration`'s tools: read now, or the read from before, so the panel
 * waits for one read, not a new one with every render.
 */
const toolsOf = (core: CoreConnection, integration: Integration): ToolsRead => {
  const known = toolsRead.get(core) ?? new Map<string, ToolsRead>();
  toolsRead.set(core, known);
  const read = known.get(integration.key) ?? {
    tools: loadFromCore(
      core,
      async (session) =>
        await session.connections.catalogTools(
          integration.source,
          integration.id
        )
    ),
  };
  known.set(integration.key, read);
  return read;
};

/** The open app, over the page: it never squeezes the tiles. */
export const IntegrationPanel = ({
  integration,
  identity,
  uses,
  from,
  onClose,
}: {
  integration: Integration;
  identity: Identity;
  uses: ConnectionUses;
  /** The tile it was opened from; none when the address opened it. */
  from: HTMLElement | null;
  onClose: () => void;
}) => {
  const core = useCore();
  const appOf = useAppOf(identity);
  const tools = useSettled(
    integration.listed ? toolsOf(core, integration).tools : undefined
  );
  const used = useSettled(uses);
  const app = appOf(integration, {
    size: "md",
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
        from={from}
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
