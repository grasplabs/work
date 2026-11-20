// An app's own page, the library's Settings pattern, all of it in view at once:
//
//   head    PageHeader's band in the app's own colour: its mark, its name, its description (two
//           sentences at most), and Manage (or Connect) at its end
//   main    "What Grasp may do": one card, each group of tools a setting row (its name, how many
//           read and change) with a quiet Select at its edge (Never, Read, Write, Mixed, each
//           meaning said in its option); a group opens in place to its tools, each with its own
//           Select. Search in the card's head. A member sees the words, not the Selects.
//   side    Connection (its facts, then Sign in again and Disconnect), Who can use it (one row),
//           Used by
//
// From 64rem of page the two stand side by side; narrower, the side comes first, then the main card.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { Button } from "../../button";
import { focus } from "../../focus/focus";
import { Agent, ChevronRight, Icon, Search, Workflow } from "../../icons";
import { InputGroup, InputGroupInput, InputGroupText } from "../../input-group";
import { KeyValueList } from "../../key-value";
import { PageHeader } from "../../page-header";
import { RowList, RowListItem } from "../../row-list";
import { SectionCard } from "../../section-card";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../select";
import { SettingRow, SettingsRows } from "../../setting-row";
import { RowFrame } from "../../setting-row/frame";
import { grasp } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App, AppConnection, AppTool, AppToolChoice } from "./model";
import {
  AppMark,
  asksConnect,
  ChoiceWord,
  ConnectAction,
  groupChoice,
  GroupSelect,
  ManageMenu,
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

const WIDE = "@container app-page (width >= 64rem)";

const styles = stylex.create({
  page: { display: "grid", gap: grasp.space6, minWidth: 0 },
  description: { whiteSpace: "pre-line" },
  body: {
    containerType: "inline-size",
    containerName: "app-page",
    minWidth: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(0, 1fr) minmax(0, 22rem)",
    },
    gap: grasp.space6,
    alignItems: "start",
  },
  // Narrow, the connection comes first.
  main: { order: { default: 2, [WIDE]: 1 }, minWidth: 0 },
  side: {
    order: { default: 1, [WIDE]: 2 },
    display: "grid",
    gap: grasp.space6,
    minWidth: 0,
  },
  search: { width: "14rem", maxWidth: "100%" },
  // A control at the row's edge.
  edge: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space1,
  },
  // A row of one line: its words at the start, its control at the end, at any width.
  line: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space4,
  },
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
  name: {
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
  // A group's tools, opened under it, a step in.
  tools: { paddingInlineStart: grasp.space6 },
  quiet: {
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    color: grasp.muted,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  foot: { display: "flex", justifyContent: "flex-end", gap: grasp.space2 },
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
  /** A change of who may use it: the host keeps it. */
  onForWhomChange?: (forWhom: AppConnection["forWhom"]) => void;
  /** This instance's own words, over the catalogue's, key by key. */
  words?: Partial<AppIntegrationWords>;
}

/** One tool, under its opened group: its name, whether it reads or changes, and what Grasp may do. */
const ToolLine = ({
  tool,
  editable,
  words,
  onChange,
}: {
  tool: AppTool;
  editable: boolean;
  words: AppIntegrationWords;
  onChange: (choice: AppToolChoice) => void;
}) => (
  <SettingRow
    label={tool.name}
    help={tool.kind === "read" ? words.readsWord : words.changesWord}
  >
    <span {...stylex.props(styles.edge)}>
      {editable ? (
        <ToolSelect tool={tool} words={words} onChange={onChange} />
      ) : (
        <ChoiceWord choice={tool.choice} words={words} />
      )}
    </span>
  </SettingRow>
);

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
    <>
      <RowFrame slot="setting-row" inner={styles.line}>
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
            <span {...stylex.props(styles.name)}>{name}</span>
            <span {...stylex.props(styles.help)}>
              {words.counts(group.reads, group.writes)}
            </span>
          </span>
        </button>
        <span {...stylex.props(styles.edge)}>{choice}</span>
      </RowFrame>
      {open ? (
        <div id={toolsId} {...stylex.props(styles.tools)}>
          <SettingsRows>
            {shown.map((tool) =>
              connected ? (
                <ToolLine
                  key={tool.id}
                  tool={tool}
                  editable={editable}
                  words={words}
                  onChange={(next) => {
                    onChange([{ id: tool.id, choice: next }]);
                  }}
                />
              ) : (
                <SettingRow
                  key={tool.id}
                  label={tool.name}
                  help={
                    tool.kind === "read" ? words.readsWord : words.changesWord
                  }
                >
                  {null}
                </SettingRow>
              )
            )}
          </SettingsRows>
        </div>
      ) : null}
    </>
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
  const found = groupTools(tools)
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

/** Connection: its facts, then Sign in again and Disconnect at the edge; Not connected before it is. */
const Connection = ({
  app,
  actions,
  words,
}: {
  app: App;
  actions: AppActions;
  words: AppIntegrationWords;
}) => {
  const { connection } = app;
  if (connection === undefined) {
    return (
      <SectionCard title={words.connection} density="compact">
        <StateWord state={undefined} words={words} />
      </SectionCard>
    );
  }
  const quiet = [
    actions.onSignIn === undefined ? null : (
      <Button
        key="sign-in"
        variant="quiet"
        size="sm"
        onClick={() => {
          actions.onSignIn?.(app);
        }}
      >
        {words.signInAgain}
      </Button>
    ),
    actions.onDisconnect === undefined ? null : (
      <Button
        key="disconnect"
        variant="quiet"
        size="sm"
        onClick={() => {
          actions.onDisconnect?.(app);
        }}
      >
        {words.disconnect}
      </Button>
    ),
  ].filter((button) => button !== null);
  return (
    <SectionCard
      title={words.connection}
      density="compact"
      footer={
        quiet.length === 0 ? undefined : (
          <span {...stylex.props(styles.foot)}>{quiet}</span>
        )
      }
    >
      <KeyValueList
        variant="inline"
        divided
        items={[
          {
            key: words.signedInAs,
            value: connection.signedInAs ?? connection.account,
          },
          {
            key: words.connectedBy,
            value: `${connection.by}, ${connection.on}`,
          },
          {
            key: words.status,
            value: <StateWord state={connection.state} words={words} />,
          },
        ]}
      />
    </SectionCard>
  );
};

/** Who can use it: one line, its name at the start and a Select (a member: the word) at the end. */
const WhoCanUse = ({
  connection,
  editable,
  words,
  onChange,
}: {
  connection: AppConnection;
  editable: boolean;
  words: AppIntegrationWords;
  onChange: AppPageProps["onForWhomChange"];
}) => (
  <SectionCard
    variant="boxed"
    flush
    density="compact"
    aria-label={words.whoCanUse}
  >
    <RowFrame slot="setting-row" inner={styles.line}>
      <span {...stylex.props(styles.name)}>{words.whoCanUse}</span>
      {editable ? (
        <Select
          value={connection.forWhom}
          items={[
            { value: "everyone", label: words.forEveryone },
            { value: "you", label: words.forYou },
          ]}
          onValueChange={(next) => {
            if (next === "everyone" || next === "you") {
              onChange?.(next);
            }
          }}
        >
          <SelectTrigger variant="text" size="sm" aria-label={words.whoCanUse}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      ) : (
        <span {...stylex.props(styles.help)}>
          {connection.forWhom === "everyone" ? words.forEveryone : words.forYou}
        </span>
      )}
    </RowFrame>
  </SectionCard>
);

/** Used by: the workflows and agents that use it, else one quiet line. */
const UsedBy = ({ app, words }: { app: App; words: AppIntegrationWords }) => {
  const users = app.workflows ?? [];
  return (
    <SectionCard title={words.usedBy} density="compact" flush>
      {users.length === 0 ? (
        <p {...stylex.props(styles.quiet)}>{words.notUsed}</p>
      ) : (
        <RowList aria-label={words.usedBy}>
          {users.map((user) => (
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
      )}
    </SectionCard>
  );
};

/** An app's own page: its tinted head, what Grasp may do, and its connection beside it. */
export const AppPage = ({
  app,
  editable = false,
  onToolsChange,
  onForWhomChange,
  words: given,
  ...actions
}: AppPageProps) => {
  const words = useWords("appIntegration", appIntegrationWords, given);
  const tint = useAppTint(app);
  return (
    <div data-slot="app-page" {...stylex.props(styles.page)}>
      <PageHeader
        variant="band"
        tint={tint}
        mark={<AppMark app={app} size="lg" />}
        title={app.name}
        description={
          <span {...stylex.props(styles.description)}>{app.description}</span>
        }
        actions={
          asksConnect(app) ? (
            <ConnectAction
              app={app}
              actions={actions}
              words={words}
              size="sm"
            />
          ) : (
            <ManageMenu app={app} actions={actions} words={words} size="sm" />
          )
        }
      />
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.grid)}>
          <div {...stylex.props(styles.main)}>
            {app.tools === undefined || app.tools.length === 0 ? null : (
              <MayDo
                app={app}
                editable={editable}
                words={words}
                onToolsChange={onToolsChange}
              />
            )}
          </div>
          <div {...stylex.props(styles.side)}>
            <Connection app={app} actions={actions} words={words} />
            {app.connection === undefined ? null : (
              <WhoCanUse
                connection={app.connection}
                // Changed only where the host can keep the change.
                editable={editable && onForWhomChange !== undefined}
                words={words}
                onChange={onForWhomChange}
              />
            )}
            <UsedBy app={app} words={words} />
          </div>
        </div>
      </div>
    </div>
  );
};
