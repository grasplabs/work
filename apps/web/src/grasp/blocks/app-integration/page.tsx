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
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../../button";
import { focus } from "../../focus/focus";
import {
  Agent,
  ChevronRight,
  Edit,
  Icon,
  Search,
  Show,
  Workflow,
} from "../../icons";
import { iconVars } from "../../icons/icon.stylex";
import { InputGroup, InputGroupInput, InputGroupText } from "../../input-group";
import { RowList, RowListItem } from "../../row-list";
import { SectionCard } from "../../section-card";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../select";
import { SettingsRows } from "../../setting-row";
import { RowFrame, rowFrame } from "../../setting-row/frame";
import { Texture } from "../../texture/texture";
import { grasp, media } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App, AppConnection, AppTool, AppToolChoice } from "./model";
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
} from "./parts";
import type { AppActions } from "./parts";
import { groupTools, matches } from "./tools";
import type { ToolGroup } from "./tools";
import { appIntegrationWords } from "./words";
import type { AppIntegrationWords } from "./words";

/** The column's measure: the Settings pattern's centred width. */
const COLUMN = "40rem";

const styles = stylex.create({
  // The column stands centred in the page.
  page: { position: "relative", isolation: "isolate", minWidth: 0 },
  column: {
    display: "grid",
    gap: grasp.space8,
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
      [media.belowPhone]: "auto minmax(0, 1fr)",
    },
    columnGap: grasp.space4,
    rowGap: grasp.space4,
    alignItems: "start",
    padding: grasp.space6,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: `inset 0 0 0 ${grasp.hairline} ${grasp.line}`,
    backgroundColor: grasp.raised,
  },
  headCardTexture: { zIndex: -1 },
  // On a phone the action goes under the words, at their start.
  headCardAction: {
    gridColumn: { default: "auto", [media.belowPhone]: "2" },
    justifySelf: "start",
  },
  // Whether it is offered (an admin): a compact switch and its one line, under the words, at their start.
  headCardOffer: { gridColumn: "2 / -1", justifySelf: "start", minWidth: 0 },
  headWords: { display: "grid", gap: grasp.space1, minWidth: 0 },
  // The description: the library's small muted text.
  description: {
    margin: 0,
    maxWidth: "100%",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  nameSm: {
    margin: 0,
    fontFamily: grasp.fontSerif,
    fontSize: grasp.titleSm,
    lineHeight: grasp.titleSmLine,
    fontWeight: grasp.weightRegular,
    color: grasp.ink,
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
    gap: grasp.space2,
  },
  // A text select at a row's end: past its own end padding and the chevron's side bearing, so its
  // chevron's ink ends on the card's inset with the values in the rows around it.
  pull: {
    display: "inline-flex",
    marginInlineEnd: `calc(-1 * (${grasp.space1} + ${grasp.iconSm} * 5 / 24))`,
  },
  // A row of one line: its words at the start, its control at the end, at any width.
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space4,
  },
  // A group and what it opened, a line between it and the group before.
  group: {
    borderBlockStartWidth: { default: grasp.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  // An open group's row: the ground of what it opened, so the two read as one.
  lineOpen: { backgroundColor: grasp.soft },
  // A group's name side: the disclosure's chevron before its name and counts, the whole of it the toggle.
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    marginInlineStart: `calc(-1 * ${grasp.space1})`,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space1,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    textAlign: "start",
    cursor: "pointer",
  },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transitionProperty: "transform",
    transitionDuration: grasp.durationHover,
    transform: { default: "none", ":dir(rtl)": "scaleX(-1)" },
  },
  chevronOpen: {
    transform: { default: "rotate(90deg)", ":dir(rtl)": "rotate(-90deg)" },
  },
  words: { display: "grid", minWidth: 0 },
  label: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  help: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  kind: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
  // An open group's tools: one line each on the open group's ground, their names on the group's
  // name's line, a hairline between them, the last closing the group.
  tools: {
    margin: 0,
    padding: 0,
    listStyle: "none",
    backgroundColor: grasp.soft,
    borderBlockStart: `${grasp.hairline} solid ${grasp.line}`,
  },
  tool: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space4,
    minHeight: grasp.space10,
    paddingBlock: grasp.space1,
    paddingInlineStart: `calc(${grasp.tableCellInline} + ${grasp.iconSm} + ${grasp.space2})`,
    paddingInlineEnd: grasp.tableCellInline,
    borderBlockStart: {
      default: `${grasp.hairline} solid ${grasp.line}`,
      ":first-child": "none",
    },
  },
  toolName: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
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
    color: grasp.muted,
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
  },
  quiet: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
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
    columnGap: grasp.space4,
    rowGap: grasp.space2,
    borderBlockStartWidth: { default: grasp.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  accountWords: { display: "grid", minWidth: 0 },
  // The account, on one line: a long address ends in an ellipsis, never breaks.
  accountName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // Its state: the dot and its word on one line, at any width.
  accountState: {
    display: "inline-flex",
    alignSelf: "start",
    whiteSpace: "nowrap",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  accountActions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: {
      default: "flex-end",
      "@container (width < 28rem)": "flex-start",
    },
    gap: grasp.space2,
    gridColumn: { default: "auto", "@container (width < 28rem)": "1 / -1" },
  },
  // Who can use it, wrapped under the account: its word starts on the account's own start.
  who: {
    display: "inline-flex",
    marginInlineStart: {
      default: 0,
      "@container (width < 28rem)": `calc(-1 * ${grasp.space2})`,
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
  /** What the host adds under the page's own sections, in the same column: its notices, a connection's access. */
  children?: ReactNode;
  /** Whether the app is offered in the organization. With `onOfferedChange`, a compact switch under the head's action (an admin). */
  offered?: boolean;
  /** A change of whether it is offered: the host keeps it. */
  onOfferedChange?: (offered: boolean) => void;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<AppIntegrationWords>;
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
          <Icon icon={tool.kind === "read" ? Show : Edit} label={kind} />
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
      <RowFrame
        slot="setting-row"
        inner={[styles.line]}
        data-state={open ? "open" : undefined}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={toolsId}
          onClick={() => {
            onOpen(!open);
          }}
          {...stylex.props(styles.toggle, focus.ring)}
        >
          <span
            aria-hidden="true"
            {...stylex.props(styles.chevron, open && styles.chevronOpen)}
          >
            <Icon icon={ChevronRight} />
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
      density="compact"
      title={words.mayDo}
      actions={
        <span {...stylex.props(styles.search)}>
          <InputGroup size="sm">
            <InputGroupText icon={Search} />
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
    <SelectTrigger variant="text" size="sm" aria-label={words.whoCanUse}>
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
        variant="quiet"
        size="sm"
        onClick={() => {
          actions.onSignIn?.(app, connection);
        }}
      >
        {words.signInAgain}
      </Button>
    )}
    {actions.onDisconnect === undefined ? null : (
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          actions.onDisconnect?.(app, connection);
        }}
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
}: {
  app: App;
  connection: AppConnection;
  onForWhomChange: AppPageProps["onForWhomChange"];
  actions: AppActions;
  words: AppIntegrationWords;
  own: ReactNode;
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
  <RowList aria-label={words.usedBy}>
    {(app.workflows ?? []).map((user) => (
      <RowListItem
        key={user.name}
        icon={user.kind === "agent" ? Agent : Workflow}
        name={user.name}
        detail={
          <span {...stylex.props(styles.kind)}>
            {user.kind === "agent" ? words.agent : words.workflow}
            {user.href === undefined ? null : (
              <span aria-hidden="true" {...stylex.props(styles.chevron)}>
                <Icon icon={ChevronRight} />
              </span>
            )}
          </span>
        }
        onPress={
          user.href === undefined
            ? undefined
            : () => {
                window.location.assign(user.href ?? "");
              }
        }
      />
    ))}
  </RowList>
);

/** An app's own page: its head, its connection, what uses it, what Grasp may do, and whether it is offered. */
export const AppPage = ({
  app,
  editable = false,
  onToolsChange,
  onForWhomChange,
  accountActions,
  offered,
  onOfferedChange,
  words: given,
  children,
  ...actions
}: AppPageProps) => {
  const words = useWords("appIntegration", appIntegrationWords, given);
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
          <Texture tint={tint} layout={styles.headCardTexture} />
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
          <SectionCard
            variant="boxed"
            flush
            density="compact"
            aria-label={words.connection}
          >
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
                  />
                ))}
              </ul>
            </div>
          </SectionCard>
        )}
        {used ? (
          <SectionCard
            variant="grouped"
            flush
            density="compact"
            title={words.usedBy}
          >
            <UsedByRows app={app} words={words} />
          </SectionCard>
        ) : null}
        {tools}
        {children}
      </div>
    </div>
  );
};
