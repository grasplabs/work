import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";

import { AppTile } from "../grasp/blocks/app-integration/app-integration.tsx";
import { useAppOf, useTileWords } from "./app-of.tsx";
import type { Integration } from "./integrations.ts";

// One app on the Integrations page, as the library's app tile (Grasp UI's
// app-integration block): its own mark, its name and one fact, in an
// ItemGrid. Not connected, the fact is how many tools it has (or that it
// isn't offered); connected, how many of its tools Grasp may use, or what
// it needs: sign in again, connect it again, or an admin. A press opens
// its panel, which grows from the tile.

/** Opens an app's panel by its key, growing from the tile pressed. */
export type OpenApp = (key: string, tile: HTMLElement | null) => void;

/** One app, as a tile that opens its panel. */
export const IntegrationTile = ({
  integration,
  identity,
  uses,
  open,
  onOpen,
}: {
  integration: Integration;
  /** Who looks: what a tile that needs someone says depends on what they may do. */
  identity: Pick<Identity, "role" | "staff" | "userId">;
  /** Which workflows use each connection, once read. */
  uses?: readonly ConnectionWorkflows[] | undefined;
  /** It is the one open over the page. */
  open: boolean;
  onOpen: OpenApp;
}) => {
  const appOf = useAppOf(identity);
  const wordsOf = useTileWords(identity);
  return (
    <AppTile
      app={appOf(integration, { size: "sm", uses })}
      current={open}
      onOpen={(_app, tile) => {
        onOpen(integration.key, tile);
      }}
      words={wordsOf(integration, uses)}
    />
  );
};
