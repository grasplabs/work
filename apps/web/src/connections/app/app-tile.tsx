import { Badge } from "@grasp-os/ui/components/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import type { ReactNode } from "react";

import type { App } from "./model.ts";
import { AppMark } from "./parts.tsx";
import { useAppWords } from "./words.ts";
import type { AppWords } from "./words.ts";

// An app as a compact tile on the Integrations page: its mark, its name
// and one fact, an outlined Item in an ItemGrid. A press opens its panel
// (panel.tsx); the panel and the app's own
// page (page.tsx) are drawn from the same App (model.ts).

/** The tile's one fact: what it asks for, how many of its tools Grasp may use, or how many it has. */
const TileFact = ({ app, words }: { app: App; words: AppWords }) => {
  const state = app.connection?.state;
  if (state === "sign-in" || state === "reconnect" || state === "needs-you") {
    const said = {
      "sign-in": words.needsSignIn,
      reconnect: words.needsConnect,
      "needs-you": words.needsYou,
    }[state];
    return (
      <Badge size="sm" variant="warning">
        {said}
      </Badge>
    );
  }
  if (state === "works" && app.tools !== undefined) {
    return words.allowed(
      app.tools.filter((tool) => tool.choice !== "never").length,
      app.tools.length
    );
  }
  if (state === "works") {
    return words.works;
  }
  return words.tools(app.tools?.length ?? app.toolCount ?? 0);
};

/** An app as a compact tile: its mark, its name, one fact. Put it in an ItemGrid. */
export const AppTile = ({
  app,
  onOpen,
  current = false,
  fact,
  words: given,
}: {
  app: App;
  /** Opens its panel. */
  onOpen: (app: App) => void;
  /** Its panel is open: the tile stays lit. */
  current?: boolean;
  /** The one fact under its name, in place of its state or tool count: why it is recommended ("Asked for by 2 people"). */
  fact?: ReactNode;
  /** This tile's own words, over the parts', key by key. */
  words?: Partial<AppWords>;
}) => {
  const words = { ...useAppWords(), ...given };
  return (
    <Item
      active={current}
      onClick={() => {
        onOpen(app);
      }}
      size="xs"
      variant="outline"
    >
      <ItemMedia align="center">
        <AppMark app={app} size="sm" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{app.name}</ItemTitle>
        <ItemDescription>
          {fact ?? <TileFact app={app} words={words} />}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};
