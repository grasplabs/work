// An app's panel over the Integrations page: InspectorPanel in a Sheet, nothing drawn by hand.
//
//   head      the app's mark on the dither in its own colour (from the top, behind the close), its
//             name and its description (two sentences at most), Manage and Settings, or Connect and
//             Settings, in the bar
//   Account   three facts: signed in as, for whom, its state as a dot and a word
//   What Grasp can do   how many tools read and change over a two-tone bar, the three groups with
//             the most allowed with their word at the end, and All 354 tools to the app's page
//   Used by   the workflows and agents that use it, else "Not used yet"
//
// It grows from the tile it was opened from, and focus goes back there when it closes.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useLayoutEffect, useRef } from "react";

import { Button } from "../../button";
import { Agent, Workflow } from "../../icons";
import { InspectorPanel } from "../../inspector-panel";
import type { InspectorSection } from "../../inspector-panel";
import { RowList, RowListItem } from "../../row-list";
import { Sheet, SheetContent, SheetTitle } from "../../sheet";
import { grasp, media } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App } from "./model";
import {
  AppMark,
  asksConnect,
  Balance,
  ChoiceWord,
  ConnectAction,
  groupChoice,
  ManageMenu,
  StateWord,
  useAppTint,
} from "./parts";
import type { AppActions } from "./parts";
import { groupTools } from "./tools";
import { appIntegrationWords } from "./words";
import type { AppIntegrationWords } from "./words";

const grow = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.96)" },
  to: { opacity: 1, transform: "none" },
});

const styles = stylex.create({
  // The panel's content, swelling out of the tile it was opened from.
  grows: {
    height: "100%",
    animationName: { default: grow, [media.reduced]: "none" },
    animationDuration: grasp.durationOpen,
    animationTimingFunction: grasp.ease,
    animationFillMode: "backwards",
  },
  // The description: its two sentences, the line break kept.
  description: { whiteSpace: "pre-line" },
  actions: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // What Grasp can do: the bar at the panel's inset, then the groups.
  can: { display: "grid", gap: grasp.space2 },
  inset: {
    paddingInline: grasp.inspectorInset,
    paddingBlockStart: grasp.space1,
  },
  quiet: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.inspectorText,
    lineHeight: grasp.inspectorTextLine,
  },
});

/** Every prop an AppPanel takes. */
export interface AppPanelProps extends AppActions {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tile it was opened from: it grows from there, and focus goes back to it. */
  from?: HTMLElement | null;
  /** The app's own page: Settings, and All tools. */
  settingsHref: string;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<AppIntegrationWords>;
}

/** Where the content grows from: the tile's middle, from the panel's own place (not where it slides). */
const useGrowFrom = (from: HTMLElement | null | undefined, open: boolean) => {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = box.current;
    if (!open || content === null || from === null || from === undefined) {
      return;
    }
    const tile = from.getBoundingClientRect();
    const place = content.getBoundingClientRect();
    content.style.transformOrigin = `${tile.left + tile.width / 2 - place.left}px ${tile.top + tile.height / 2 - place.top}px`;
  }, [from, open]);
  return box;
};

/** Most groups the panel names: the rest are on the app's page. */
const SHOWN_GROUPS = 3;

/** The panel's sections: its account, what it can do, and what uses it. */
const sectionsOf = (
  app: App,
  settingsHref: string,
  words: AppIntegrationWords
): InspectorSection[] => {
  const tools = app.tools ?? [];
  const sections: InspectorSection[] = [];
  const { connection } = app;
  if (connection !== undefined) {
    sections.push({
      id: "account",
      label: words.account,
      facts: [
        {
          key: words.signedInAs,
          value: connection.signedInAs ?? connection.account,
        },
        {
          key: words.forWhom,
          value:
            connection.forWhom === "everyone"
              ? words.forEveryone
              : words.forYou,
        },
        {
          key: words.status,
          value: <StateWord state={connection.state} words={words} />,
        },
      ],
    });
  }
  if (tools.length > 0) {
    // The groups with the most allowed first; before it is connected, the largest.
    const groups = groupTools(tools)
      .filter((group) => group.name !== null)
      .toSorted(
        (a, b) => b.allowed - a.allowed || b.tools.length - a.tools.length
      )
      .slice(0, SHOWN_GROUPS);
    sections.push({
      id: "can",
      label: words.canDo,
      action: (
        <Button
          variant="ghost"
          size="xs"
          render={
            <a href={settingsHref} aria-label={words.allTools(tools.length)} />
          }
        >
          {words.allTools(tools.length)}
        </Button>
      ),
      content: (
        <div {...stylex.props(styles.can)}>
          <div {...stylex.props(styles.inset)}>
            <Balance tools={tools} words={words} />
          </div>
          <RowList aria-label={words.canDo}>
            {groups.map((group) => (
              <RowListItem
                key={group.name}
                name={group.name ?? words.other}
                detail={
                  connection === undefined ? (
                    words.counts(group.reads, group.writes)
                  ) : (
                    <ChoiceWord choice={groupChoice(group)} words={words} />
                  )
                }
              />
            ))}
          </RowList>
        </div>
      ),
    });
  }
  const users = app.workflows ?? [];
  sections.push({
    id: "used",
    label: words.usedBy,
    ...(users.length === 0
      ? { content: <p {...stylex.props(styles.quiet)}>{words.notUsed}</p> }
      : {
          rows: users.map((user) => ({
            id: user.name,
            name: user.name,
            icon: user.kind === "agent" ? Agent : Workflow,
            detail: user.kind === "agent" ? words.agent : words.workflow,
            onPress:
              user.href === undefined
                ? undefined
                : () => {
                    window.location.assign(user.href ?? "");
                  },
          })),
        }),
  });
  return sections;
};

/** An app's panel over the page: its tinted head and two buttons, its account, what it can do, and what uses it. */
export const AppPanel = ({
  app,
  open,
  onOpenChange,
  from,
  settingsHref,
  words: given,
  ...actions
}: AppPanelProps) => {
  const words = useWords("appIntegration", appIntegrationWords, given);
  const box = useGrowFrom(from, open);
  const tint = useAppTint(app);
  const close = () => {
    onOpenChange(false);
    from?.focus();
  };
  const settings = (
    <Button
      variant="quiet"
      size="xs"
      render={<a href={settingsHref} aria-label={words.settings} />}
    >
      {words.settings}
    </Button>
  );
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          from?.focus();
        }
      }}
    >
      <SheetContent close="none" initialFocus="content">
        {/* The Sheet's name, for a screen reader; the panel's head shows it with the app's mark. */}
        <SheetTitle hidden>{app.name}</SheetTitle>
        <div ref={box} data-slot="app-panel" {...stylex.props(styles.grows)}>
          <InspectorPanel
            framed={false}
            aria-label={app.name}
            title={app.name}
            mark={<AppMark app={app} size="md" />}
            tint={tint}
            texture
            description={
              <span {...stylex.props(styles.description)}>
                {app.description}
              </span>
            }
            actions={
              <span {...stylex.props(styles.actions)}>
                {asksConnect(app) ? (
                  <ConnectAction
                    app={app}
                    actions={actions}
                    words={words}
                    size="xs"
                  />
                ) : (
                  <ManageMenu
                    app={app}
                    actions={actions}
                    words={words}
                    size="xs"
                  />
                )}
                {settings}
              </span>
            }
            onClose={close}
            sections={sectionsOf(app, settingsHref, words)}
            words={{ close: words.close }}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
};
