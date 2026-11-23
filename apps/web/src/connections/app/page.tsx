import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Section, SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
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
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment, useId, useState } from "react";
import type { ReactNode } from "react";

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
import { groupTools, matches } from "./tools.ts";
import type { ToolGroup } from "./tools.ts";
import { useAppWords } from "./words.ts";

// An app's own page, in one centred column (40rem), all of it in view:
//
//   head     a card of its own on a wash of the app's colour: the app's
//            mark, its name (the page's h1), its description (cut at two
//            lines, Show more) and the one action at its end: Connect, or,
//            once connected, its state ("Connected") as the menu that
//            manages it; for an admin, whether it is offered, under it
//   accounts one card, a row for each account it is connected with: the
//            account, who connected it and when, who can use it, its state,
//            and what can be done to it (sign in again, disconnect)
//   used by  the workflows and agents that use it, only when something does
//   tools    "What Grasp may do": one card, each group of tools a row with
//            a quiet Select at its end; a group opens in place to its
//            tools, one line each. Search in the card's head. A member
//            sees the words, not the Selects.
//   host     what the host adds (`children`): its notices, a connection's
//            access, in the same column

/** The column's measure: the Settings pattern's centred width. */
const COLUMN = "40rem";

const styles = stylex.create({
  column: {
    display: "grid",
    gap: space["8"],
    containerType: "inline-size",
    width: "100%",
    maxWidth: COLUMN,
    marginInline: "auto",
    minWidth: 0,
  },
  // The head: a card of its own, the mark beside the name and the action at the line's end; on a
  // phone the action goes under the words, at their start.
  head: {
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
  },
  // The product's own wash of the app's colour, from the head's top corner: Damsko's dither stands
  // only in its page header's banner.
  wash: (tint: string) => ({
    backgroundImage: `linear-gradient(160deg, color-mix(in srgb, ${tint} 22%, transparent), transparent 45%)`,
  }),
  headWords: { display: "grid", gap: space["1"], minWidth: 0 },
  headAction: {
    gridColumn: { default: "auto", [media.maxSm]: "2" },
    justifySelf: "start",
  },
  // Whether it is offered (an admin): a compact switch and its one line, under the words.
  headOffer: { gridColumn: "2 / -1", justifySelf: "start", minWidth: 0 },
  help: {
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // The search beside the card's title; in a column under 28rem, a line of its own under it, so
  // the title keeps its line (the column is the container).
  search: {
    display: "block",
    width: { default: "14rem", "@container (width < 28rem)": "100cqi" },
  },
  // A group: its row, and what it opened under it, a hairline before every group but the first.
  group: {
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  // A group's row: its disclosure, then its control at the end.
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["4"],
    minHeight: space.fieldRow,
    paddingBlock: space["2"],
    paddingInline: space.tableCellInline,
  },
  // An open group's row: the ground of what it opened, so the two read as one.
  lineOpen: { backgroundColor: colors.muted },
  // A group's name side: the chevron before its name and counts, the whole of it the toggle.
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    margin: 0,
    marginInlineStart: `calc(-1 * ${space["1"]})`,
    padding: space["1"],
    borderWidth: 0,
    borderRadius: radius.mark,
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
  // A control at the row's end.
  edge: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  // An open group's tools: one line each on the open group's ground, their names on the group's
  // name's line, a hairline between them.
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
});

/** One tool, under its opened group: its name, whether it reads or changes, and what Grasp may do. */
const ToolLine = ({
  tool,
  editable,
  connected,
  onChange,
}: {
  tool: AppTool;
  editable: boolean;
  connected: boolean;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const words = useAppWords();
  const kind = tool.kind === "read" ? words.readsWord : words.changesWord;
  let control: ReactNode = null;
  if (connected) {
    control = editable ? (
      <ToolSelect onChange={onChange} tool={tool} />
    ) : (
      <ChoiceWord choice={tool.choice} />
    );
  }
  return (
    <li {...stylex.props(styles.tool)}>
      <span title={tool.description} {...stylex.props(styles.toolName)}>
        <span {...stylex.props(styles.toolKind)}>
          <Icon
            icon={tool.kind === "read" ? EyeIcon : PencilIcon}
            label={kind}
          />
        </span>
        <span {...stylex.props(styles.toolText)}>{tool.name}</span>
      </span>
      <span {...stylex.props(styles.edge)}>{control}</span>
    </li>
  );
};

/** One group: a row with its Select and its disclosure, and its tools under it when open. */
const GroupLine = ({
  group,
  open,
  onOpen,
  shown,
  editable,
  connected,
  onChange,
}: {
  group: ToolGroup;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** The tools shown when it is open: all, or those a search found. */
  shown: readonly AppTool[];
  editable: boolean;
  connected: boolean;
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const words = useAppWords();
  const name = group.name ?? words.other;
  const toolsId = useId();
  let choice: ReactNode = null;
  // Before it is connected nothing is set: the counts alone.
  if (connected) {
    choice = editable ? (
      <GroupSelect
        group={group}
        label={name}
        onChange={(next) => {
          onChange(underChoice(group, next));
        }}
      />
    ) : (
      <ChoiceWord choice={groupChoice(group)} />
    );
  }
  return (
    <div {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.line, open && styles.lineOpen)}>
        {/* Damsko has no row that opens in place with a control at its end: the product's own disclosure. */}
        <button
          aria-controls={toolsId}
          aria-expanded={open}
          onClick={() => {
            onOpen(!open);
          }}
          type="button"
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
        <span {...stylex.props(styles.edge)}>{choice}</span>
      </div>
      {open ? (
        <ul aria-label={name} id={toolsId} {...stylex.props(styles.tools)}>
          {shown.map((tool) => (
            <ToolLine
              connected={connected}
              editable={editable}
              key={tool.id}
              onChange={(next) => {
                onChange([{ id: tool.id, choice: next }]);
              }}
              tool={tool}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** Every group of tools as a row, each opening in place to its tools; a search opens what it found. */
export const GroupRows = ({
  tools,
  query,
  editable,
  connected,
  onChange,
}: {
  tools: readonly AppTool[];
  query: string;
  editable: boolean;
  connected: boolean;
  onChange: (changes: readonly { id: string; choice: AppToolChoice }[]) => void;
}) => {
  const words = useAppWords();
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const searching = query.trim() !== "";
  const needle = query.trim().toLowerCase();
  const found = groupTools(tools, words.toolGroup)
    .map((group) => ({
      group,
      shown: searching
        ? group.tools.filter(
            (tool) =>
              matches(tool, query) ||
              (group.name ?? "").toLowerCase().includes(needle)
          )
        : group.tools,
    }))
    .filter((entry) => entry.shown.length > 0);
  if (found.length === 0) {
    return <p {...stylex.props(styles.quiet)}>{words.noMatch}</p>;
  }
  return found.map(({ group, shown }) => {
    const key = group.name ?? "other";
    return (
      <GroupLine
        connected={connected}
        editable={editable}
        group={group}
        key={key}
        onChange={onChange}
        onOpen={(open) => {
          const next = new Set(opened);
          if (open) {
            next.add(key);
          } else {
            next.delete(key);
          }
          setOpened(next);
        }}
        open={searching || opened.has(key)}
        shown={shown}
      />
    );
  });
};

/** What Grasp may do: every group as a row, searchable in the card's head. */
const MayDo = ({
  app,
  editable,
  onToolsChange,
}: {
  app: App;
  editable: boolean;
  onToolsChange: AppPageProps["onToolsChange"];
}) => {
  const words = useAppWords();
  const [query, setQuery] = useState("");
  const id = useId();
  return (
    <Section aria-labelledby={id}>
      <SectionHeader
        actions={
          <span {...stylex.props(styles.search)}>
            <InputGroup size="sm">
              <InputGroupAddon>
                <Icon icon={SearchIcon} />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={words.searchTools}
                onValueChange={setQuery}
                placeholder={words.searchTools}
                type="search"
                value={query}
              />
            </InputGroup>
          </span>
        }
        id={id}
        title={words.mayDo}
        variant="group"
      />
      <Card padding="none" size="sm">
        <GroupRows
          connected={app.connection !== undefined}
          editable={editable}
          onChange={(changes) => {
            onToolsChange?.(changes);
          }}
          query={query}
          tools={app.tools ?? []}
        />
      </Card>
    </Section>
  );
};

/** The one action that moves the connection on: Connect (for a member, who can), or Manage. */
const MainAction = ({ app, actions }: { app: App; actions: AppActions }) => {
  const words = useAppWords();
  if (!asksConnect(app)) {
    return <ManageMenu actions={actions} app={app} asState size="sm" />;
  }
  if (actions.member === true) {
    return <span {...stylex.props(styles.help)}>{words.adminConnects}</span>;
  }
  return canConnect(actions) ? (
    <ConnectAction actions={actions} app={app} size="sm" />
  ) : null;
};

/** Who can use an account, as a quiet Select: where the person may change it and the host keeps it. */
const WhoSelect = ({
  connection,
  onChange,
}: {
  connection: AppConnection;
  onChange: (
    forWhom: AppConnection["forWhom"],
    connection: AppConnection
  ) => void;
}) => {
  const words = useAppWords();
  return (
    <Select
      items={[
        { value: "everyone", label: words.forEveryone },
        { value: "you", label: words.forYou },
      ]}
      onValueChange={(next) => {
        if (next === "everyone" || next === "you") {
          onChange(next, connection);
        }
      }}
      value={connection.forWhom}
    >
      <SelectTrigger aria-label={words.whoCanUse} size="sm" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

/** What can be done to one account: the host's own, else Sign in again (where it asks) and Disconnect. */
const AccountActions = ({
  app,
  connection,
  actions,
}: {
  app: App;
  connection: AppConnection;
  actions: AppActions;
}) => {
  const words = useAppWords();
  return (
    <>
      {actions.onSignIn === undefined ||
      connection.state !== "sign-in" ? null : (
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
};

/** One account: who it is, who connected it and when, who can use it, its state, and its actions. */
const AccountRow = ({
  app,
  connection,
  onForWhomChange,
  actions,
  own,
}: {
  app: App;
  connection: AppConnection;
  onForWhomChange: AppPageProps["onForWhomChange"];
  actions: AppActions;
  own: ReactNode;
}) => {
  const words = useAppWords();
  const { t } = useLingui();
  const name = connection.signedInAs ?? connection.account;
  const forWhom =
    connection.forWhom === "everyone" ? words.forEveryone : words.forYou;
  const { by, on } = connection;
  // Who can use it: a Select among its actions where it may be changed, else words after when.
  const when =
    onForWhomChange === undefined
      ? t({
          message: `${by}, ${on} · ${forWhom}`,
          comment:
            "An account's line: {by} connected it (a person's name, or You), on the date {on}, for {forWhom} (Just you, or Everyone).",
        })
      : t({
          message: `${by}, ${on}`,
          comment:
            "An account's line: {by} connected it (a person's name, or You), on the date {on}.",
        });
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          {name}
          <ItemDetail>
            <StateWord state={connection.state} />
          </ItemDetail>
        </ItemTitle>
        <ItemDescription>{when}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {onForWhomChange === undefined ? null : (
          <WhoSelect connection={connection} onChange={onForWhomChange} />
        )}
        {own ?? (
          <AccountActions actions={actions} app={app} connection={connection} />
        )}
      </ItemActions>
    </Item>
  );
};

/** Used by: the workflows and agents that use it. */
const UsedBy = ({ app }: { app: App }) => {
  const words = useAppWords();
  const id = useId();
  return (
    <Section aria-labelledby={id}>
      <SectionHeader id={id} title={words.usedBy} variant="group" />
      <Card padding="none" size="sm">
        <ItemGroup aria-label={words.usedBy}>
          {(app.workflows ?? []).map((user, index) => (
            <Fragment key={user.name}>
              {index > 0 ? <ItemSeparator /> : null}
              <Item href={user.href} size="xs">
                <ItemMedia>
                  <Icon
                    icon={
                      user.kind === "agent" ? WandSparklesIcon : WorkflowIcon
                    }
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
      </Card>
    </Section>
  );
};

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
   * An account row's own actions, in place of Sign in again and Disconnect
   * from `onSignIn` and `onDisconnect`: the host's triggers, so the dialogs
   * they open grow from them.
   */
  accountActions?: (connection: AppConnection) => ReactNode;
  /** What the host adds under the page's own sections, in the same column: its notices, a connection's access. */
  children?: ReactNode;
  /** Whether the app is offered in the organization. With `onOfferedChange`, a compact switch under the head (an admin). */
  offered?: boolean;
  /** A change of whether it is offered: the host keeps it. */
  onOfferedChange?: (offered: boolean) => void;
}

/** An app's own page: its head, its connection, what uses it, what Grasp may do, and whether it is offered. */
export const AppPage = ({
  app,
  editable = false,
  onToolsChange,
  onForWhomChange,
  accountActions,
  offered,
  onOfferedChange,
  children,
  ...actions
}: AppPageProps) => {
  const words = useAppWords();
  const tint = useAppTint(app);
  const accounts =
    app.connections ?? (app.connection === undefined ? [] : [app.connection]);
  const used = (app.workflows ?? []).length > 0;
  return (
    <div {...stylex.props(styles.column)}>
      <Card padding="none" size="sm">
        {/* Without a colour of its own, the mint. */}
        <header
          {...stylex.props(styles.head, styles.wash(tint ?? colors.mint))}
        >
          <AppMark app={app} size="lg" />
          <div {...stylex.props(styles.headWords)}>
            <Heading level={1} size="sm">
              {app.name}
            </Heading>
            <Text as="div" color="muted" size="sm">
              <Clamped text={app.description} />
            </Text>
          </div>
          <span {...stylex.props(styles.headAction)}>
            <MainAction actions={actions} app={app} />
          </span>
          {offered === undefined || onOfferedChange === undefined ? null : (
            <span {...stylex.props(styles.headOffer)}>
              <OfferSwitch offered={offered} onChange={onOfferedChange} />
            </span>
          )}
        </header>
      </Card>
      {accounts.length === 0 ? null : (
        <Card aria-label={words.connection} size="sm">
          <CardContent flush>
            <ItemGroup aria-label={words.connection}>
              {accounts.map((each, index) => (
                <Fragment key={each.id ?? each.signedInAs ?? each.account}>
                  {index > 0 ? <ItemSeparator /> : null}
                  <AccountRow
                    actions={actions}
                    app={app}
                    connection={each}
                    // Changed only where the host can keep the change.
                    onForWhomChange={editable ? onForWhomChange : undefined}
                    own={accountActions?.(each)}
                  />
                </Fragment>
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      )}
      {used ? <UsedBy app={app} /> : null}
      {app.tools === undefined || app.tools.length === 0 ? null : (
        <MayDo app={app} editable={editable} onToolsChange={onToolsChange} />
      )}
      {children}
    </div>
  );
};
