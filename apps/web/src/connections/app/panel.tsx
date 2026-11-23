import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import {
  SidePanel,
  SidePanelContent,
  SidePanelHeader,
  SidePanelSection,
} from "@grasp-os/ui/components/side-panel";
import { Icon, WandSparklesIcon, WorkflowIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import type { App } from "./model.ts";
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
} from "./parts.tsx";
import type { AppActions } from "./parts.tsx";
import { groupTools } from "./tools.ts";
import { useAppWords } from "./words.ts";

// An app's panel over the Integrations page: Damsko's SidePanel in a
// Sheet.
//
//   head      the app's mark, its name and its description (cut at two
//             lines, Show more), and in the bar Connect and Settings, or,
//             once connected, its state ("Connected") as the menu that
//             manages it, and Settings; behind it a wash of the app's own
//             colour
//   Account   two facts: signed in as, and for whom (its state is the
//             head's menu)
//   What Grasp may do   how many tools read and change over a two-tone
//             bar, then the three groups with the most allowed with their
//             word at the end, and All 354 tools to the app's page
//   Used by   the workflows and agents that use it, only when something does
//
// It slides in from its side as the Sheet does, and focus goes back to
// its tile when it closes.

const styles = stylex.create({
  fill: { display: "flex", flexDirection: "column", height: "100%" },
  // The bar's key and its counts, at the panel's inset, over the groups.
  balance: {
    paddingInline: space.sidePanelPadding,
    paddingBlock: space["2"],
  },
  // The product's own cover: a wash of the app's colour, fading down from the top.
  cover: (tint: string) => ({
    width: "100%",
    height: "100%",
    backgroundImage: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 22%, transparent), transparent)`,
  }),
});

/** Most groups the panel names: the rest are on the app's page. */
const SHOWN_GROUPS = 3;

/** What Grasp may do: the balance, then the groups with the most allowed. */
const MayDo = ({ app, settingsHref }: { app: App; settingsHref: string }) => {
  const words = useAppWords();
  const tools = app.tools ?? [];
  if (tools.length === 0) {
    return null;
  }
  // The groups with the most allowed first; before it is connected, the largest.
  const groups = groupTools(tools, words.toolGroup)
    .filter((group) => group.name !== null)
    .toSorted(
      (one, other) =>
        other.allowed - one.allowed || other.tools.length - one.tools.length
    )
    .slice(0, SHOWN_GROUPS);
  const all = words.allTools(tools.length);
  return (
    <SidePanelSection
      action={
        <Button asChild size="xs" variant="ghost">
          <a href={settingsHref}>{all}</a>
        </Button>
      }
      title={words.mayDo}
    >
      <div {...stylex.props(styles.balance)}>
        <Balance tools={tools} />
      </div>
      <ItemGroup aria-label={words.mayDo}>
        {groups.map((group, index) => (
          <Fragment key={group.name}>
            {index > 0 ? <ItemSeparator /> : null}
            <Item size="xs">
              <ItemContent>
                <ItemTitle>
                  {group.name ?? words.other}
                  <ItemDetail>
                    {app.connection === undefined ? (
                      words.counts(group.reads, group.writes)
                    ) : (
                      <ChoiceWord choice={groupChoice(group)} />
                    )}
                  </ItemDetail>
                </ItemTitle>
              </ItemContent>
            </Item>
          </Fragment>
        ))}
      </ItemGroup>
    </SidePanelSection>
  );
};

/** Used by: the workflows and agents that use it; nothing while nothing does. */
const UsedBy = ({ app }: { app: App }) => {
  const words = useAppWords();
  const users = app.workflows ?? [];
  if (users.length === 0) {
    return null;
  }
  return (
    <SidePanelSection title={words.usedBy}>
      <ItemGroup aria-label={words.usedBy}>
        {users.map((user, index) => (
          <Fragment key={user.name}>
            {index > 0 ? <ItemSeparator /> : null}
            <Item href={user.href} size="xs">
              <ItemMedia>
                <Icon
                  icon={user.kind === "agent" ? WandSparklesIcon : WorkflowIcon}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {user.name}
                  <ItemDetail>
                    {user.kind === "agent" ? words.agent : words.workflow}
                  </ItemDetail>
                </ItemTitle>
              </ItemContent>
            </Item>
          </Fragment>
        ))}
      </ItemGroup>
    </SidePanelSection>
  );
};

/** An app's panel over the page: its head and two buttons, its account, what it can do, and what uses it. */
export const AppPanel = ({
  app,
  open,
  onOpenChange,
  settingsHref,
  ...actions
}: AppActions & {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The app's own page: Settings, and All tools. */
  settingsHref: string;
}) => {
  const words = useAppWords();
  const tint = useAppTint(app);
  const { connection } = app;
  return (
    <Sheet
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
      open={open}
    >
      <SheetContent showCloseButton={false}>
        {/* The Sheet's name, for a screen reader; the panel's head shows it with the app's mark. */}
        <span {...stylex.props(visuallyHidden)}>
          <SheetTitle>{app.name}</SheetTitle>
        </span>
        <div {...stylex.props(styles.fill)}>
          <SidePanel
            aria-label={app.name}
            // Without a colour of its own, the mint.
            cover={<div {...stylex.props(styles.cover(tint ?? colors.mint))} />}
            framed={false}
          >
            <SidePanelHeader
              actions={
                <>
                  {asksConnect(app) ? (
                    <ConnectAction actions={actions} app={app} size="sm" />
                  ) : (
                    <ManageMenu actions={actions} app={app} asState size="sm" />
                  )}
                  <Button asChild size="sm" variant="outline">
                    <a href={settingsHref}>{words.settings}</a>
                  </Button>
                </>
              }
              description={<Clamped text={app.description} />}
              icon={<AppMark app={app} size="default" />}
              // A member, where the app waits to be connected: why there is no Connect.
              meta={
                actions.member === true && asksConnect(app)
                  ? [words.adminConnects]
                  : undefined
              }
              onClose={() => {
                onOpenChange(false);
              }}
              title={app.name}
            />
            <SidePanelContent>
              {connection === undefined ? null : (
                <SidePanelSection title={words.account}>
                  <div {...stylex.props(styles.balance)}>
                    <KeyValueList
                      divided
                      items={[
                        {
                          id: "signed-in-as",
                          label: words.signedInAs,
                          value: connection.signedInAs ?? connection.account,
                        },
                        {
                          id: "for",
                          label: words.forWhom,
                          value:
                            connection.forWhom === "everyone"
                              ? words.forEveryone
                              : words.forYou,
                        },
                      ]}
                      orientation="horizontal"
                    />
                  </div>
                </SidePanelSection>
              )}
              <MayDo app={app} settingsHref={settingsHref} />
              <UsedBy app={app} />
            </SidePanelContent>
          </SidePanel>
        </div>
      </SheetContent>
    </Sheet>
  );
};
