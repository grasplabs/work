// App integration: an app as the Integrations page shows it, in three parts drawn from one App
// (model.ts), and the connect dialog beside them (connect-app.tsx), as #2503's library block
// (`grasp/blocks/app-integration`) drew them, on Damsko's parts:
//
//   <ItemGrid aria-label="Connected">{apps.map((app) => <AppTile key={app.id} app={app} onOpen={open} />)}</ItemGrid>
//   <AppPanel app={app} open={open} onOpenChange={setOpen} from={tile} settingsHref={`/integrations/${app.id}`} … />
//   <AppPage app={app} editable onToolsChange={save} … />
//
// The tile: compact (56px), its mark, its name and one fact. The panel (panel.tsx): a SidePanel in a
// Sheet over the page, its head on the dither in the app's own colour. The page (page.tsx): the
// Settings pattern, what Grasp may do beside the connection, all in view at once. The app's colour
// is the host's `tint`, else read from `markSrc` (useMarkTint), else the mint.
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { useId } from "react";
import type { ReactNode } from "react";

import type { App } from "./model.ts";
import { AppMark } from "./parts.tsx";
import { useAppIntegrationWords } from "./words.ts";
import type { AppIntegrationWords } from "./words.ts";

/** The tile's one fact: what it asks for, how many of its tools Grasp may use, or how many it has. */
const TileFact = ({ app, words }: { app: App; words: AppIntegrationWords }) => {
  const state = app.connection?.state;
  if (state === "sign-in") {
    return (
      <Badge size="sm" variant="warning">
        {words.needsSignIn}
      </Badge>
    );
  }
  if (state === "reconnect") {
    return (
      <Badge size="sm" variant="warning">
        {words.needsConnect}
      </Badge>
    );
  }
  if (state === "needs-you") {
    return (
      <Badge size="sm" variant="warning">
        {words.needsYou}
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

/** Every prop an AppTile takes. */
export interface AppTileProps {
  app: App;
  /** Opens its panel, with the tile it was pressed on, so the panel grows from it. */
  onOpen: (app: App, tile: HTMLElement | null) => void;
  /** Its panel is open: the tile stays lit. */
  active?: boolean;
  /** The one fact under its name, in place of its state or tool count: why it is recommended ("Asked for by 2 people"). */
  fact?: ReactNode;
  /** This tile's own words, over the app's, key by key. */
  words?: Partial<AppIntegrationWords>;
}

/** An app as a compact tile: its mark, its name, one fact. Put it in an ItemGrid. */
export const AppTile = ({
  app,
  onOpen,
  active = false,
  fact,
  words: given,
}: AppTileProps) => {
  const words = { ...useAppIntegrationWords(), ...given };
  const id = useId();
  return (
    <Item
      active={active}
      onClick={() => {
        onOpen(
          app,
          document
            .querySelector(`#${CSS.escape(id)}`)
            ?.closest<HTMLElement>("[data-slot=item]") ?? null
        );
      }}
      size="xs"
      variant="outline"
    >
      <ItemMedia align="center">
        <AppMark app={app} size="sm" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          <span id={id}>{app.name}</span>
        </ItemTitle>
        <ItemDescription>
          {fact ?? <TileFact app={app} words={words} />}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};
