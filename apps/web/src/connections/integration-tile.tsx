import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import type { ReactNode } from "react";

import { useAppOf, useTileWords } from "./app-of.tsx";
import { AppTile } from "./app/app-tile.tsx";
import type { Integration } from "./integrations.ts";

// One app on the Integrations page, as its app tile (app/app-tile.tsx):
// its own mark, its name and one fact, in an
// ItemGrid. Not connected, the fact is how many tools it has (or that it
// isn't offered); connected, how many of its tools Grasp may use, or what
// it needs: sign in again, connect it again, or an admin. A press opens
// its panel, and focus comes back to the tile when it closes.

/** Opens an app's panel by its key. */
export type OpenApp = (key: string) => void;

/** One app, as a tile that opens its panel. */
export const IntegrationTile = ({
  integration,
  identity,
  uses,
  open,
  onOpen,
  fact,
}: {
  integration: Integration;
  /** Who looks: what a tile that needs someone says depends on what they may do. */
  identity: Pick<Identity, "role" | "staff" | "userId">;
  /** Which workflows use each connection, once read. */
  uses?: readonly ConnectionWorkflows[] | undefined;
  /** It is the one open over the page. */
  open: boolean;
  onOpen: OpenApp;
  /** The one line under its name in place of where it stands: why it is recommended. */
  fact?: ReactNode;
}) => {
  const appOf = useAppOf(identity);
  const wordsOf = useTileWords(identity);
  return (
    <AppTile
      app={appOf(integration, { size: "sm", uses })}
      current={open}
      fact={fact}
      onOpen={() => {
        onOpen(integration.key);
      }}
      words={wordsOf(integration, uses)}
    />
  );
};
