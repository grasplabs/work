// App integration: an app as the Integrations page shows it, in three parts drawn from one App
// (model.ts), and the connect dialog beside them (the connect-app block):
//
//   <ItemGrid aria-label="Connected">{apps.map((app) => <AppTile key={app.id} app={app} onOpen={open} />)}</ItemGrid>
//   <AppPanel app={app} open={open} onOpenChange={setOpen} from={tile} settingsHref={`/integrations/${app.id}`} … />
//   <AppPage app={app} editable onToolsChange={save} … />
//
// The tile: compact (56px), its mark, its name and one fact. The panel (panel.tsx): InspectorPanel
// over the page, its head on the dither in the app's own colour. The page (page.tsx): the Settings
// pattern, what Grasp may do beside the connection, all in view at once. The app's colour is the
// host's `tint`, else read from `markSrc` (useMarkTint), else the mint.
"use client";

import { useId } from "react";
import type { ReactNode } from "react";

import { Badge } from "../../badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../../item";
import { useWords } from "../../words/words";
import type { App } from "./model";
import { AppMark } from "./parts";
import { appIntegrationWords } from "./words";
import type { AppIntegrationWords } from "./words";

export type {
  App,
  AppConnection,
  AppState,
  AppTool,
  AppToolChoice,
  AppToolKind,
  AppWorkflow,
} from "./model";
export type { AppIntegrationWords } from "./words";
export { appIntegrationWords } from "./words";
export { groupTools } from "./tools";
export type { ToolGroup } from "./tools";

export { AppPanel } from "./panel";
export type { AppPanelProps } from "./panel";
export { AppPage } from "./page";
export type { AppPageProps } from "./page";
export type { AppActions } from "./parts";
export { useMarkTint } from "../../texture/mark-tint";

/** The words, the catalogue's under the host's own. */
const useAppWords = (given: Partial<AppIntegrationWords> | undefined) =>
  useWords("appIntegration", appIntegrationWords, given);

/** The tile's one fact: what it asks for, how many of its tools Grasp may use, or how many it has. */
const TileFact = ({ app, words }: { app: App; words: AppIntegrationWords }) => {
  const state = app.connection?.state;
  if (state === "sign-in") {
    return (
      <Badge tone="attention" size="sm">
        {words.needsSignIn}
      </Badge>
    );
  }
  if (state === "reconnect") {
    return (
      <Badge tone="attention" size="sm">
        {words.needsConnect}
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
  current?: boolean;
  /** The one fact under its name, in place of its state or tool count: why it is recommended ("Asked for by 2 people"). */
  fact?: ReactNode;
  words?: Partial<AppIntegrationWords>;
}

/** An app as a compact tile: its mark, its name, one fact. Put it in an ItemGrid. */
export const AppTile = ({
  app,
  onOpen,
  current = false,
  fact,
  words: given,
}: AppTileProps) => {
  const words = useAppWords(given);
  const id = useId();
  return (
    <Item
      variant="outline"
      size="xs"
      current={current}
      onPress={() => {
        onOpen(
          app,
          document
            .querySelector(`#${CSS.escape(id)}`)
            ?.closest<HTMLElement>("[data-slot=item]") ?? null
        );
      }}
    >
      <ItemMedia>
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
