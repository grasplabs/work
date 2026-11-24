// An app's own page, the library's Settings pattern in one centred column (40rem), all of it in view:
//
//   head    a card of its own with the dither in the app's colour inside it: the app's mark, its name,
//           its description (cut at two lines, Show more) and the one action at the end: Connect, or,
//           once connected, its state ("Connected") as the menu that manages it
//   accounts one card, a row for each account it is connected with: the account, who connected it
//           and when in quiet words, its state, and what can be done to it (sign in again,
//           disconnect), which wraps under the account on a phone; left out while there is none
//   used by the workflows and agents that use it, only when something does
//   tools   "What Grasp may do": one card, each group of tools a setting row with a quiet Select at
//           its edge; a group opens in place to its tools, one line each. Search in the card's head.
//           A member sees the words, not the Selects.
//   host    what the host adds (`children`): its notices, a connection's access, in the same column
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  ChevronRightIcon,
  EyeIcon,
  Icon,
  PencilIcon,
  SearchIcon,
  WandSparklesIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRing } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useId, useState } from "react";
import type { ReactNode } from "react";

import { SectionCard } from "../section-card.tsx";
import type { App, AppConnection, AppTool, AppToolChoice } from "./model.ts";
import {
  AppMark,
  asksConnect,
  canConnect,
  ChoiceWord,
  Clamped,
  ConnectAction,
  groupChoice,
  GroupSelect,
  ManageMenu,
  OfferSwitch,
  StateWord,
  ToolSelect,
  underChoice,
  useAppTint,
} from "./parts.tsx";
import type { AppActions } from "./parts.tsx";
import { rowFrame, RowFrame, SettingsRows } from "./rows.tsx";
import { Texture } from "./texture.tsx";
import { groupTools, matches } from "./tools.ts";
import type { ToolGroup } from "./tools.ts";
import { useAppIntegrationWords } from "./words.ts";
import type { AppIntegrationWords } from "./words.ts";

/** The column's measure: the Settings pattern's centred width. */
const COLUMN = "40rem";

const styles = stylex.create({
  // The column stands centred in the page.
  page: { position: "relative", isolation: "isolate", minWidth: 0 },
  column: {
    display: "grid",
    gap: space["8"],
    width: "100%",
    maxWidth: COLUMN,
    marginInline: "auto",
    minWidth: 0,
  },
  // The head: a card of its own, the dither inside it, the mark beside the name and the action at
  // the line's end.
  headCard: {
    position: "relative",
    isolation: "isolate",
    overflow: "clip",
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr) auto",
      [media.maxSm]: "auto minmax(0, 1fr)",
    },
    columnGap: space["4"],
    rowGap: space["4"],
    alignItems: "start",
    padding: space["6"],
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: `inset 0 0 0 ${sizes.hairline} ${colors.border}`,
    backgroundColor: colors.card,
  },
  headCardTexture: { zIndex: -1 },
  // On a phone the action goes under the words, at their start.
  headCardAction: {
    gridColumn: { default: "auto", [media.maxSm]: "2" },
    justifySelf: "start",
  },
  // Whether it is offered (an admin): a compact switch and its one line, under the words, at their start.
  headCardOffer: { gridColumn: "2 / -1", justifySelf: "start", minWidth: 0 },
  headWords: { display: "grid", gap: space["1"], minWidth: 0 },
  // The description: the library's small muted text.
  description: {
    margin: 0,
    maxWidth: "100%",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  nameSm: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
    fontWeight: font.weightNormal,
    color: colors.foreground,
  },
  // The search beside the card's title, narrower on a phone so the title keeps its line.
  search: {
    display: "block",
    width: { default: "14rem", "@container (width < 28rem)": "100cqi" },
  },
  // A control at the row's edge.
  edge: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  // A text select at a row's end: past its own end padding and the chevron's side bearing, so its
  // chevron's ink ends on the card's inset with the values in the rows around it.
  pull: {
    display: "inline-flex",
    marginInlineEnd: `calc(-1 * (${space["1"]} + ${sizes.iconSm} * 5 / 24))`,
  },
  // A row of one line: its words at the start, its control at the end, at any width.
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["4"],
  },
  // A group and what it opened, a line between it and the group before.
  group: {
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  // An open group's row: the ground of what it opened, so the two read as one.
  lineOpen: { backgroundColor: colors.muted },
  // A group's name side: the disclosure's chevron before its name and counts, the whole of it the toggle.
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    marginInlineStart: `calc(-1 * ${space["1"]})`,
    paddingBlock: space["1"],
    paddingInline: space["1"],
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
    transitionProperty: "transform",
    transitionDuration: duration.hover,
    transform: { default: "none", ":dir(rtl)": "scaleX(-1)" },
  },
  chevronOpen: {
    transform: { default: "rotate(90deg)", ":dir(rtl)": "rotate(-90deg)" },
  },
  words: { display: "grid", minWidth: 0 },
  label: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  help: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  kind: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  // An open group's tools: one line each on the open group's ground, their names on the group's
  // name's line, a hairline between them, the last closing the group.
  tools: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    backgroundColor: colors.muted,
    borderBlockStart: `${sizes.hairline} solid ${colors.border}`,
  },
  tool: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["4"],
    minHeight: space["10"],
    paddingBlock: space["1"],
    paddingInlineStart: `calc(${space.tableCellInline} + ${sizes.iconSm} + ${space["2"]})`,
    paddingInlineEnd: space.tableCellInline,
    borderBlockStart: {
      default: `${sizes.hairline} solid ${colors.border}`,
      ":first-child": "none",
    },
  },
  toolName: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
  },
  toolText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  toolKind: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
  },
  quiet: {
    margin: 0,
    paddingBlock: space["3"],
    paddingInline: space["4"],
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // The accounts: one grid for every row, so each row's state stands in one column at the same x and
  // its actions in the column after; the rows are its subgrid. Measured by the card's own width: under
  // 28rem the actions wrap under the words, at their start.
  accountsBox: { containerType: "inline-size" },
  accounts: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto auto",
      "@container (width < 28rem)": "minmax(0, 1fr) auto",
    },
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // An account's row: the setting row's height and sides, a hairline over every row but the first.
  account: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    alignItems: "center",
    columnGap: space["4"],
    rowGap: space["2"],
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  accountWords: { display: "grid", minWidth: 0 },
  // The account, on one line: a long address ends in an ellipsis, never breaks.
  accountName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  // Its state: the dot and its word on one line, at any width.
  accountState: {
    display: "inline-flex",
    alignSelf: "start",
    whiteSpace: "nowrap",
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  accountActions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: {
      default: "flex-end",
      "@container (width < 28rem)": "flex-start",
    },
    gap: space["2"],
    gridColumn: { default: "auto", "@container (width < 28rem)": "1 / -1" },
  },
  // Who can use it, wrapped under the account: its word starts on the account's own start.
  who: {
    display: "inline-flex",
    marginInlineStart: {
      default: 0,
      "@container (width < 28rem)": `calc(-1 * ${space["2"]})`,
    },
  },
});

/** Every prop an AppPage takes. */
export interface AppPageProps extends AppActions {
  app: App;
  /** The person may change what Grasp may do and who uses it (an admin). */
  editable?: boolean;
  /** A change of what Grasp may do with some tools: the host keeps it. */
  onToolsChange?: (
    changes: readonly { id: string; choice: AppToolChoice }[]
  ) => void;
  /** A change of who may use an account: the host keeps it. Without it, who may use it is shown as words. */
  onForWhomChange?: (
    forWhom: AppConnection["forWhom"],
    connection: AppConnection
  ) => void;
  /**
   * An account row's own actions, in place of Sign in again and Disconnect from `onSignIn` and
   * `onDisconnect`: the host's triggers, so the dialogs they open grow from them.
   */
  accountActions?: (connection: AppConnection) => ReactNode;
  /** A line of the host's under an account's words: a notice of what can be done to it. */
  accountNote?: (connection: AppConnection) => ReactNode;
  /** What the host adds under the page's own sections, in the same column: its notices, a connection's access. */
  children?: ReactNode;
  /** Whether the app is offered in the organization. With `onOfferedChange`, a compact switch under the head's action (an admin). */
  offered?: boolean;
  /** A change of whether it is offered: the host keeps it. */
  onOfferedChange?: (offered: boolean) => void;
}

/** One tool, under its opened group: its name, whether it reads or changes, and what Grasp may do. */
const ToolLine = ({
  tool,
  editable,
  connected,
  words,
  onChange,
}: {
  tool: AppTool;
  editable: boolean;
  connected: boolean;
  words: AppIntegrationWords;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const kind = tool.kind === "read" ? words.readsWord : words.changesWord;
  let control: ReactNode = null;
  if (connected) {
    control = editable ? (
      <ToolSelect tool={tool} words={words} onChange={onChange} />
    ) : (
      <ChoiceWord choice={tool.choice} words={words} />
    );
  }
  return (
    <li data-slot="app-tool" {...stylex.props(styles.tool)}>
      <span {...stylex.props(styles.toolName)} title={tool.description}>
        <span {...stylex.props(styles.toolKind)}>
          <Icon
            icon={tool.kind === "read" ? EyeIcon : PencilIcon}
            label={kind}
          />
        </span>
        <span {...stylex.props(styles.toolText)}>{tool.name}</span>
      </span>
      <span
        {...stylex.props(styles.edge, editable && connected && styles.pull)}
      >
        {control}
      </span>
    </li>
  );
};

/** One group: a setting row with its Select and its disclosure, and its tools under it when open. */
const GroupLine = ({
  group,
  open,
  onOpen,
  shown,
  editable,
  connected,
  words,
  onChange,
}: {
  group: ToolGroup;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** The tools shown when it is open: all, or those a search found. */
  shown: readonly AppTool[];
  editable: boolean;
  connected: boolean;
  words: AppIntegrationWords;
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const name = group.name ?? words.other;
  const control = editable ? (
    <GroupSelect
      group={group}
      label={name}
      words={words}
      onChange={(next) => {
        onChange(underChoice(group, next));
      }}
    />
  ) : (
    <ChoiceWord choice={groupChoice(group)} words={words} />
  );
  // Before it is connected nothing is set: the counts alone.
  const choice = connected ? control : null;
  const toolsId = useId();
  return (
    <div
      data-slot="app-group"
      data-open={open ? "" : undefined}
      {...stylex.props(styles.group)}
    >
      <RowFrame data-state={open ? "open" : undefined} inner={[styles.line]}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={toolsId}
          onClick={() => {
            onOpen(!open);
          }}
          {...stylex.props(styles.toggle, focusRing)}
        >
          <span
            aria-hidden="true"
            {...stylex.props(styles.chevron, open && styles.chevronOpen)}
          >
            <Icon icon={ChevronRightIcon} />
          </span>
          <span {...stylex.props(styles.words)}>
            <span {...stylex.props(styles.label)}>{name}</span>
            <span {...stylex.props(styles.help)}>
              {words.counts(group.reads, group.writes)}
            </span>
          </span>
        </button>
        <span
          {...stylex.props(styles.edge, editable && connected && styles.pull)}
        >
          {choice}
        </span>
      </RowFrame>
      {open ? (
        <ul id={toolsId} aria-label={name} {...stylex.props(styles.tools)}>
          {shown.map((tool) => (
            <ToolLine
              key={tool.id}
              tool={tool}
              editable={editable}
              connected={connected}
              words={words}
              onChange={(next) => {
                onChange([{ id: tool.id, choice: next }]);
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** Every group of tools as a setting row, each opening in place to its tools; a search opens what it found. */
export const GroupRows = ({
  tools,
  query = "",
  editable,
  connected,
  words,
  onChange,
}: {
  tools: readonly AppTool[];
  query?: string;
  editable: boolean;
  connected: boolean;
  words: AppIntegrationWords;
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const found = groupTools(tools, words.toolGroup)
    .map((group) => ({
      group,
      shown: searching
        ? group.tools.filter(
            (tool) =>
              matches(tool, query) ||
              (group.name ?? "")
                .toLowerCase()
                .includes(query.trim().toLowerCase())
          )
        : group.tools,
    }))
    .filter((entry) => entry.shown.length > 0);
  if (found.length === 0) {
    return <p {...stylex.props(styles.quiet)}>{words.noMatch}</p>;
  }
  return (
    <SettingsRows>
      {found.map(({ group, shown }) => {
        const key = group.name ?? "other";
        return (
          <GroupLine
            key={key}
            group={group}
            open={searching || opened.has(key)}
            onOpen={(open) => {
              const next = new Set(opened);
              if (open) {
                next.add(key);
              } else {
                next.delete(key);
              }
              setOpened(next);
            }}
            shown={shown}
            editable={editable}
            connected={connected}
            words={words}
            onChange={onChange}
          />
        );
      })}
    </SettingsRows>
  );
};

/** What Grasp may do: every group as a setting row, searchable in the card's head. */
const MayDo = ({
  app,
  editable,
  words,
  onToolsChange,
}: {
  app: App;
  editable: boolean;
  words: AppIntegrationWords;
  onToolsChange: AppPageProps["onToolsChange"];
}) => {
  const [query, setQuery] = useState("");
  return (
    <SectionCard
      variant="grouped"
      flush
      title={words.mayDo}
      actions={
        <span {...stylex.props(styles.search)}>
          <InputGroup size="sm">
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={words.searchTools}
              placeholder={words.searchTools}
              value={query}
              onValueChange={setQuery}
            />
          </InputGroup>
        </span>
      }
    >
      <GroupRows
        tools={app.tools ?? []}
        query={query}
        editable={editable}
        connected={app.connection !== undefined}
        words={words}
        onChange={(changes) => {
          onToolsChange?.(changes);
        }}
      />
    </SectionCard>
  );
};

/** The one action that moves the connection on: Connect (for a member, who can), or Manage. */
const MainAction = ({
  app,
  actions,
  words,
}: {
  app: App;
  actions: AppActions;
  words: AppIntegrationWords;
}) => {
  if (!asksConnect(app)) {
    return (
      <ManageMenu app={app} actions={actions} words={words} size="sm" asState />
    );
  }
  if (actions.member === true) {
    return <span {...stylex.props(styles.help)}>{words.adminConnects}</span>;
  }
  return canConnect(actions) ? (
    <ConnectAction app={app} actions={actions} words={words} size="sm" />
  ) : null;
};

/** Who can use an account, as a quiet Select: where the person may change it and the host keeps it. */
const WhoSelect = ({
  connection,
  words,
  onChange,
}: {
  connection: AppConnection;
  words: AppIntegrationWords;
  onChange: (
    forWhom: AppConnection["forWhom"],
    connection: AppConnection
  ) => void;
}) => (
  <Select
    value={connection.forWhom}
    items={[
      { value: "everyone", label: words.forEveryone },
      { value: "you", label: words.forYou },
    ]}
    onValueChange={(next) => {
      if (next === "everyone" || next === "you") {
        onChange(next, connection);
      }
    }}
  >
    <SelectTrigger aria-label={words.whoCanUse} size="sm" variant="ghost">
      <SelectValue />
    </SelectTrigger>
    <SelectContent />
  </Select>
);

/** What can be done to one account: the host's own, else Sign in again (where it asks) and Disconnect. */
const AccountActions = ({
  app,
  connection,
  actions,
  words,
}: {
  app: App;
  connection: AppConnection;
  actions: AppActions;
  words: AppIntegrationWords;
}) => (
  <>
    {actions.onSignIn === undefined || connection.state !== "sign-in" ? null : (
      <Button
        onClick={() => {
          actions.onSignIn?.(app, connection);
        }}
        size="sm"
        variant="outline"
      >
        {words.signInAgain}
      </Button>
    )}
    {actions.onDisconnect === undefined ? null : (
      <Button
        onClick={() => {
          actions.onDisconnect?.(app, connection);
        }}
        size="sm"
        variant="outline"
      >
        {words.disconnect}
      </Button>
    )}
  </>
);

/** One account: who it is, who connected it and when, who can use it, its state, and its actions. */
const AccountRow = ({
  app,
  connection,
  onForWhomChange,
  actions,
  words,
  own,
  note,
}: {
  app: App;
  connection: AppConnection;
  onForWhomChange: AppPageProps["onForWhomChange"];
  actions: AppActions;
  words: AppIntegrationWords;
  own: ReactNode;
  note: ReactNode;
}) => {
  const name = connection.signedInAs ?? connection.account;
  const forWhom =
    connection.forWhom === "everyone" ? words.forEveryone : words.forYou;
  // Who can use it: a Select among its actions where it may be changed, else words after when.
  const who =
    onForWhomChange === undefined ? null : (
      <span {...stylex.props(styles.who)}>
        <WhoSelect
          connection={connection}
          words={words}
          onChange={onForWhomChange}
        />
      </span>
    );
  const when =
    who === null
      ? `${connection.by}, ${connection.on} · ${forWhom}`
      : `${connection.by}, ${connection.on}`;
  const acts = own ?? (
    <AccountActions
      app={app}
      connection={connection}
      actions={actions}
      words={words}
    />
  );
  return (
    <li
      data-slot="app-account"
      data-state={connection.state}
      {...stylex.props(rowFrame.pad, styles.account)}
    >
      <span {...stylex.props(styles.accountWords)}>
        <span {...stylex.props(styles.accountName)} title={name}>
          {name}
        </span>
        <span {...stylex.props(styles.help)}>{when}</span>
        {note === undefined || note === null ? null : (
          <span {...stylex.props(styles.help)}>{note}</span>
        )}
      </span>
      <span {...stylex.props(styles.accountState)}>
        <StateWord state={connection.state} words={words} />
      </span>
      <span {...stylex.props(styles.accountActions)}>
        {who}
        {acts}
      </span>
    </li>
  );
};

/** Used by: the workflows and agents that use it; nothing at all while nothing does. */
const UsedByRows = ({
  app,
  words,
}: {
  app: App;
  words: AppIntegrationWords;
}) => (
  <ItemGroup aria-label={words.usedBy}>
    {(app.workflows ?? []).map((user, index) => (
      <Fragment key={user.name}>
        {index > 0 && <ItemSeparator />}
        <Item
          onClick={
            user.href === undefined
              ? undefined
              : () => {
                  window.location.assign(user.href ?? "");
                }
          }
          size="xs"
        >
          <ItemMedia>
            <Icon
              icon={user.kind === "agent" ? WandSparklesIcon : WorkflowIcon}
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>
              {user.name}
              <ItemDetail>
                <span {...stylex.props(styles.kind)}>
                  {user.kind === "agent" ? words.agent : words.workflow}
                  {user.href === undefined ? null : (
                    <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                      <Icon icon={ChevronRightIcon} />
                    </span>
                  )}
                </span>
              </ItemDetail>
            </ItemTitle>
          </ItemContent>
        </Item>
      </Fragment>
    ))}
  </ItemGroup>
);

/** An app's own page: its head, its connection, what uses it, what Grasp may do, and whether it is offered. */
export const AppPage = ({
  app,
  editable = false,
  onToolsChange,
  onForWhomChange,
  accountActions,
  accountNote,
  offered,
  onOfferedChange,
  children,
  ...actions
}: AppPageProps) => {
  const words = useAppIntegrationWords();
  const tint = useAppTint(app);
  const accounts =
    app.connections ?? (app.connection === undefined ? [] : [app.connection]);
  const used = (app.workflows ?? []).length > 0;
  const tools =
    app.tools === undefined || app.tools.length === 0 ? null : (
      <MayDo
        app={app}
        editable={editable}
        words={words}
        onToolsChange={onToolsChange}
      />
    );
  const offer =
    offered === undefined || onOfferedChange === undefined ? null : (
      <OfferSwitch offered={offered} onChange={onOfferedChange} words={words} />
    );
  return (
    <div data-slot="app-page" {...stylex.props(styles.page)}>
      <div {...stylex.props(styles.column)}>
        <header {...stylex.props(styles.headCard)}>
          <Texture style={styles.headCardTexture} tint={tint} />
          <AppMark app={app} size="lg" />
          <div {...stylex.props(styles.headWords)}>
            <h1 {...stylex.props(styles.nameSm)}>{app.name}</h1>
            <p {...stylex.props(styles.description)}>
              <Clamped text={app.description} words={words} />
            </p>
          </div>
          <span {...stylex.props(styles.headCardAction)}>
            <MainAction app={app} actions={actions} words={words} />
          </span>
          {offer === null ? null : (
            <span {...stylex.props(styles.headCardOffer)}>{offer}</span>
          )}
        </header>
        {accounts.length === 0 ? null : (
          <SectionCard aria-label={words.connection} flush>
            <div {...stylex.props(styles.accountsBox)}>
              <ul
                aria-label={words.connection}
                {...stylex.props(styles.accounts)}
              >
                {accounts.map((each) => (
                  <AccountRow
                    key={each.id ?? each.signedInAs ?? each.account}
                    app={app}
                    connection={each}
                    // Changed only where the host can keep the change.
                    onForWhomChange={editable ? onForWhomChange : undefined}
                    actions={actions}
                    words={words}
                    own={accountActions?.(each)}
                    note={accountNote?.(each)}
                  />
                ))}
              </ul>
            </div>
          </SectionCard>
        )}
        {used ? (
          <SectionCard flush title={words.usedBy} variant="grouped">
            <UsedByRows app={app} words={words} />
          </SectionCard>
        ) : null}
        {tools}
        {children}
      </div>
    </div>
  );
};
