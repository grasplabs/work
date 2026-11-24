// An app's panel over the Integrations page: a SidePanel in a Sheet, as Damsko's Inspector block
// lays one out, with the app's mark and the dither in its colour at the head:
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
import { Button } from "@grasp-os/ui/components/button";
import {
  Item,
  ItemActions,
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
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, size as sizes, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";
import type { ReactNode } from "react";

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
import { Texture } from "./texture.tsx";
import { groupTools } from "./tools.ts";
import { useAppIntegrationWords } from "./words.ts";
import type { AppIntegrationWords } from "./words.ts";

/** The bar's buttons' size, as the library's bar actions. */
const barActionSize = "sm";

const styles = stylex.create({
  fill: { height: "100%" },
  // What Grasp can do: the bar at the panel's inset, then the groups.
  can: { display: "grid", gap: space["2"] },
  // The bar, then a line across the panel's inset, then the groups.
  inset: {
    paddingInline: space.sidePanelPadding,
    paddingBlockStart: space["1"],
    paddingBlockEnd: space["3"],
    borderBlockEndWidth: sizes.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // The facts at the inset of the rows' words, as the Inspector's.
  facts: { paddingInline: space.sidePanelPadding },
  // A row that never has actions: its detail ends at the row's inset, not
  // before the room a side panel's row keeps for one (registry gap of 24
  // Nov 2026: Item has no such row). The actions' slot holds nothing, and
  // gives back the gap before it.
  noActions: { marginInlineStart: `calc(-1 * ${space["2"]})` },
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
}

/** Most groups the panel names: the rest are on the app's page. */
const SHOWN_GROUPS = 3;

/** One row of a section: its kind's icon where it has one, its name and a quiet word after it. */
interface PanelRow {
  id: string;
  name: string;
  icon?: IconData;
  detail: ReactNode;
  onClick?: () => void;
}

/** A section's rows, as one list named by its title, a hairline between them. */
const Rows = ({
  label,
  rows,
  noActions = false,
}: {
  label: string;
  rows: readonly PanelRow[];
  /** No row ever has actions: each detail ends at the row's own inset. */
  noActions?: boolean;
}) => (
  <ItemGroup aria-label={label}>
    {rows.map(({ onClick: handleClick, ...row }, index) => (
      <Fragment key={row.id}>
        {index > 0 && <ItemSeparator />}
        <Item onClick={handleClick} size="xs">
          {row.icon === undefined ? null : (
            <ItemMedia>
              <Icon icon={row.icon} />
            </ItemMedia>
          )}
          <ItemContent>
            <ItemTitle>
              {row.name}
              <ItemDetail>{row.detail}</ItemDetail>
            </ItemTitle>
          </ItemContent>
          {noActions ? (
            <ItemActions style={styles.noActions}>
              <span aria-hidden="true" />
            </ItemActions>
          ) : null}
        </Item>
      </Fragment>
    ))}
  </ItemGroup>
);

/** Account: who it is signed in as, and for whom. */
const AccountSection = ({
  app,
  words,
}: {
  app: App;
  words: AppIntegrationWords;
}) => {
  const { connection } = app;
  if (connection === undefined) {
    return null;
  }
  return (
    <SidePanelSection title={words.account}>
      <div {...stylex.props(styles.facts)}>
        <KeyValueList
          divided
          items={[
            {
              id: "signed-in-as",
              label: words.signedInAs,
              value: connection.signedInAs ?? connection.account,
            },
            {
              id: "for-whom",
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
  );
};

/** What Grasp may do: the balance of its tools, and the groups with the most allowed. */
const MayDoSection = ({
  app,
  settingsHref,
  words,
}: {
  app: App;
  settingsHref: string;
  words: AppIntegrationWords;
}) => {
  const tools = app.tools ?? [];
  if (tools.length === 0) {
    return null;
  }
  // The groups with the most allowed first; before it is connected, the largest.
  const groups = groupTools(tools, words.toolGroup)
    .filter((group) => group.name !== null)
    .toSorted(
      (a, b) => b.allowed - a.allowed || b.tools.length - a.tools.length
    )
    .slice(0, SHOWN_GROUPS);
  return (
    <SidePanelSection
      action={
        <Button asChild size="xs" variant="ghost">
          <a aria-label={words.allTools(tools.length)} href={settingsHref}>
            {words.allTools(tools.length)}
          </a>
        </Button>
      }
      title={words.mayDo}
    >
      <div {...stylex.props(styles.can)}>
        <div {...stylex.props(styles.inset)}>
          <Balance tools={tools} words={words} />
        </div>
        <Rows
          label={words.mayDo}
          noActions
          rows={groups.map((group) => ({
            id: group.name ?? words.other,
            name: group.name ?? words.other,
            detail:
              app.connection === undefined ? (
                words.counts(group.reads, group.writes)
              ) : (
                <ChoiceWord choice={groupChoice(group)} words={words} />
              ),
          }))}
        />
      </div>
    </SidePanelSection>
  );
};

/** Used by: the workflows and agents that use it, only when something does. */
const UsedBySection = ({
  app,
  words,
}: {
  app: App;
  words: AppIntegrationWords;
}) => {
  const users = app.workflows ?? [];
  if (users.length === 0) {
    return null;
  }
  return (
    <SidePanelSection title={words.usedBy}>
      <Rows
        label={words.usedBy}
        rows={users.map((user) => ({
          id: user.name,
          name: user.name,
          icon: user.kind === "agent" ? WandSparklesIcon : WorkflowIcon,
          detail: user.kind === "agent" ? words.agent : words.workflow,
          ...(user.href === undefined
            ? {}
            : {
                onClick: () => {
                  window.location.assign(user.href ?? "");
                },
              }),
        }))}
      />
    </SidePanelSection>
  );
};

/** An app's panel over the page: its tinted head and two buttons, its account, what it can do, and what uses it. */
export const AppPanel = ({
  app,
  open,
  onOpenChange,
  from,
  settingsHref,
  ...actions
}: AppPanelProps) => {
  const words = useAppIntegrationWords();
  const tint = useAppTint(app);
  const close = () => {
    onOpenChange(false);
    from?.focus();
  };
  return (
    <Sheet
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          from?.focus();
        }
      }}
      open={open}
    >
      <SheetContent showCloseButton={false}>
        {/* The Sheet's name, for a screen reader; the panel's head shows it with the app's mark. */}
        <div {...stylex.props(visuallyHidden)}>
          <SheetTitle>{app.name}</SheetTitle>
        </div>
        <SidePanel
          aria-label={app.name}
          cover={<Texture tint={tint} />}
          framed={false}
          style={styles.fill}
        >
          <SidePanelHeader
            actions={
              <>
                {asksConnect(app) ? (
                  <ConnectAction
                    actions={actions}
                    app={app}
                    size={barActionSize}
                    words={words}
                  />
                ) : (
                  <ManageMenu
                    actions={actions}
                    app={app}
                    asState
                    size={barActionSize}
                    words={words}
                  />
                )}
                <Button asChild size={barActionSize} variant="outline">
                  <a aria-label={words.settings} href={settingsHref}>
                    {words.settings}
                  </a>
                </Button>
              </>
            }
            description={<Clamped text={app.description} words={words} />}
            icon={<AppMark app={app} size="default" />}
            // A member, where the app waits to be connected: why there is no Connect.
            {...(actions.member === true && asksConnect(app)
              ? { meta: [words.adminConnects] }
              : {})}
            onClose={close}
            title={app.name}
          />
          {/* Under the head only when it has something to say. */}
          {app.connection === undefined &&
          (app.tools ?? []).length === 0 &&
          (app.workflows ?? []).length === 0 ? null : (
            <SidePanelContent>
              <AccountSection app={app} words={words} />
              <MayDoSection
                app={app}
                settingsHref={settingsHref}
                words={words}
              />
              <UsedBySection app={app} words={words} />
            </SidePanelContent>
          )}
        </SidePanel>
      </SheetContent>
    </Sheet>
  );
};
