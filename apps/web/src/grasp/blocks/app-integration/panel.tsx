// An app's panel over the Integrations page: InspectorPanel in a Sheet, nothing drawn by hand.
//
//   head      the app's mark on the dither in its own colour (from the top, behind the close), its
//             name and its description (cut at two lines, Show more), and in the bar Connect and
//             Settings, or, once connected, its state ("Connected") as the menu that manages it, and
//             Settings
//   Account   two facts: signed in as, and for whom (its state is the head's menu)
//   What Grasp may do   how many tools read and change over a two-tone bar, a line, the three groups
//             with the most allowed with their word at the end, and All 354 tools to the app's page
//   Used by   the workflows and agents that use it, only when something does
//
// It slides in from its side as the Sheet does, and focus goes back to its tile when it closes.
"use client";

import * as stylex from "@stylexjs/stylex";

import { barActionSize } from "../../bar-actions/bar-actions";
import { Button } from "../../button";
import { Agent, Workflow } from "../../icons";
import { InspectorPanel } from "../../inspector-panel";
import type { InspectorSection } from "../../inspector-panel";
import { RowList, RowListItem } from "../../row-list";
import { Sheet, SheetContent, SheetTitle } from "../../sheet";
import { grasp } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App } from "./model";
import {
  AppMark,
  asksConnect,
  Balance,
  ChoiceWord,
  Clamped,
  ConnectAction,
  groupChoice,
  ManageMenu,
  useAppTint,
} from "./parts";
import type { AppActions } from "./parts";
import { groupTools } from "./tools";
import { appIntegrationWords } from "./words";
import type { AppIntegrationWords } from "./words";

const styles = stylex.create({
  fill: { height: "100%" },
  // What Grasp can do: the bar at the panel's inset, then the groups.
  can: { display: "grid", gap: grasp.space2 },
  // The bar, then a line across the panel's inset, then the groups.
  inset: {
    paddingInline: grasp.inspectorInset,
    paddingBlockStart: grasp.space1,
    paddingBlockEnd: grasp.space3,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
});

/** Every prop an AppPanel takes. */
export interface AppPanelProps extends AppActions {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tile it was opened from: focus goes back to it. */
  from?: HTMLElement | null;
  /** The app's own page: Settings, and All tools. */
  settingsHref: string;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<AppIntegrationWords>;
}

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
      label: words.mayDo,
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
          <RowList aria-label={words.mayDo} noActions>
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
  if (users.length === 0) {
    return sections;
  }
  sections.push({
    id: "used",
    label: words.usedBy,
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
  const tint = useAppTint(app);
  const close = () => {
    onOpenChange(false);
    from?.focus();
  };
  const settings = (
    <Button
      variant="quiet"
      size={barActionSize}
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
        <div data-slot="app-panel" {...stylex.props(styles.fill)}>
          <InspectorPanel
            framed={false}
            aria-label={app.name}
            title={app.name}
            mark={<AppMark app={app} size="md" />}
            tint={tint}
            texture
            description={<Clamped text={app.description} words={words} />}
            // A member, where the app waits to be connected: why there is no Connect.
            meta={
              actions.member === true && asksConnect(app)
                ? [words.adminConnects]
                : undefined
            }
            actions={
              <>
                {asksConnect(app) ? (
                  <ConnectAction
                    app={app}
                    actions={actions}
                    words={words}
                    size={barActionSize}
                  />
                ) : (
                  <ManageMenu
                    app={app}
                    actions={actions}
                    words={words}
                    size={barActionSize}
                    asState
                  />
                )}
                {settings}
              </>
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
