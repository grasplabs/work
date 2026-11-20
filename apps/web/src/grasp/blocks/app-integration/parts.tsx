// The small parts an app's tile, panel, page and connect dialog share (app-integration.tsx): its mark
// and its colour, the words of what Grasp may do (Never, Read, Write, Mixed, each with an icon, so
// colour is never the only mark) and the control that sets it, how many tools read and change as one
// line over a two-tone bar, a connection's state as a dot and a word, and the Manage menu.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { BrandIcon } from "../../brand-icon";
import { Button } from "../../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../dropdown-menu";
import { focus } from "../../focus/focus";
import { Edit, Icon, Lock, Rows, Show } from "../../icons";
import type { IconData } from "../../icons";
import { iconVars } from "../../icons/icon.stylex";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../select";
import { Switch } from "../../switch";
import { useMarkTint } from "../../texture/mark-tint";
import { grasp, media } from "../../tokens/tokens.stylex";
import { useWords } from "../../words/words";
import type { App, AppState, AppTool, AppToolChoice } from "./model";
import { needsYou } from "./state";
import { choiceUnder, choicesFor, presetOf } from "./tools";
import type { ToolGroup } from "./tools";
import { appIntegrationWords } from "./words";
import type { AppIntegrationWords } from "./words";

/** What Grasp may do with a group: one choice for all its tools, or Mixed where they differ. */
export type GroupChoice = AppToolChoice | "mixed";

const styles = stylex.create({
  // Whether it is offered: the switch, then the one line for its state, small and muted.
  offer: {
    display: "flex",
    alignItems: "flex-start",
    gap: grasp.space2,
    minWidth: 0,
  },
  offerSwitch: { display: "inline-flex", flexShrink: 0 },
  offerLine: {
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
  // A host's action, laid out as if it stood there itself.
  slot: { display: "contents" },
  // A mark the host gave, in its own box at the size asked.
  mark: { display: "inline-flex", flexShrink: 0 },
  word: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    whiteSpace: "nowrap",
  },
  // Allowed in some way: the word in ink, so what Grasp may use stands out from the rest.
  wordOn: { color: grasp.ink },
  // How many read and change: the line, then the bar.
  balance: { display: "grid", gap: grasp.space2, minWidth: 0 },
  balanceLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    fontVariantNumeric: "tabular-nums",
  },
  key: { display: "inline-flex", alignItems: "center", gap: grasp.space1 },
  // The bar: reading solid, changing hatched, a gap between, so the two read apart in shape too.
  bar: { display: "flex", gap: "2px", height: grasp.space2, minWidth: 0 },
  part: { minWidth: "2px", borderRadius: "999px", forcedColorAdjust: "none" },
  grow: (share: number) => ({ flexGrow: share }),
  reads: {
    backgroundColor: { default: grasp.ink, [media.forced]: "CanvasText" },
  },
  writes: {
    backgroundColor: "transparent",
    backgroundImage: {
      default: `repeating-linear-gradient(135deg, ${grasp.muted} 0 2px, transparent 2px 4px)`,
      [media.forced]:
        "repeating-linear-gradient(135deg, CanvasText 0 2px, transparent 2px 4px)",
    },
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.muted}`,
      [media.forced]: "inset 0 0 0 1px CanvasText",
    },
  },
  // The bar's key: a small swatch of each part before its count.
  swatch: {
    display: "inline-block",
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: "2px",
    forcedColorAdjust: "none",
  },
  // A connection's state: a dot and its word.
  state: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    verticalAlign: "top",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: "999px",
    flexShrink: 0,
    forcedColorAdjust: "none",
  },
  works: {
    backgroundColor: { default: grasp.success, [media.forced]: "CanvasText" },
  },
  attention: {
    backgroundColor: { default: grasp.attention, [media.forced]: "CanvasText" },
  },
  // A description cut at its lines, and the quiet button that shows it whole.
  clampText: { display: "block", whiteSpace: "pre-line", textWrap: "pretty" },
  clamped: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
  },
  more: {
    display: "inline-flex",
    marginBlockStart: grasp.space1,
    marginInlineStart: `calc(-1 * ${grasp.space1})`,
    paddingBlock: 0,
    paddingInline: grasp.space1,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: "transparent",
    color: { default: grasp.muted, ":hover": grasp.ink },
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    cursor: "pointer",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
  },
  none: {
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.muted}`,
      [media.forced]: "inset 0 0 0 1px CanvasText",
    },
  },
});

/** The app's mark at a size: the host's, or its first letter on a tile. */
export const AppMark = ({
  app,
  size,
}: {
  app: App;
  size: "sm" | "md" | "lg";
}) =>
  app.mark === undefined ? (
    <BrandIcon name={app.name} size={size} decorative />
  ) : (
    <span aria-hidden="true" {...stylex.props(styles.mark)}>
      {app.mark}
    </span>
  );

/** The app's own colour for the dither behind its head: the host's, else read from its mark, else none (the mint). */
export const useAppTint = (app: App) => {
  const read = useMarkTint(app.tint === undefined ? app.markSrc : undefined);
  return app.tint ?? read;
};

/** A choice's icon: a lock for Never, an eye for Read, a pen for Write, rows for Mixed. */
const iconOf: Record<GroupChoice, IconData> = {
  never: Lock,
  read: Show,
  write: Edit,
  mixed: Rows,
};

/** A choice's word. */
export const wordOf = (choice: GroupChoice, words: AppIntegrationWords) =>
  ({
    never: words.never,
    read: words.read,
    write: words.write,
    mixed: words.mixed,
  })[choice];

/** The words for a choice, with its icon: what a member sees, and a summary row's end. */
export const ChoiceWord = ({
  choice,
  words,
}: {
  choice: GroupChoice;
  words: AppIntegrationWords;
}) => (
  <span {...stylex.props(styles.word, choice !== "never" && styles.wordOn)}>
    <Icon icon={iconOf[choice]} />
    {wordOf(choice, words)}
  </span>
);

/** A group's choice: its preset in Never, Read, Write, or Mixed where its tools differ. */
export const groupChoice = (group: ToolGroup): GroupChoice =>
  (({ off: "never", read: "read", all: "write", mixed: "mixed" }) as const)[
    presetOf(group.tools)
  ];

/** The tools of a group set to one choice: Never, reads only, or reads and asked changes. */
export const underChoice = (group: ToolGroup, choice: AppToolChoice) => {
  const preset = ({ never: "off", read: "read", write: "all" } as const)[
    choice
  ];
  return group.tools.map((tool) => ({
    id: tool.id,
    choice: choiceUnder(preset, tool),
  }));
};

const isChoice = (value: unknown): value is AppToolChoice =>
  value === "never" || value === "read" || value === "write";

/** A quiet Select of what Grasp may do with a group: its meaning in each option's line. */
export const GroupSelect = ({
  group,
  label,
  words,
  onChange,
}: {
  group: ToolGroup;
  label: string;
  words: AppIntegrationWords;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const value = groupChoice(group);
  const items = [
    { value: "never", label: words.never, description: words.neverNote },
    { value: "read", label: words.read, description: words.readNote },
    { value: "write", label: words.write, description: words.writeNote },
    // Mixed is where the tools stand, not a choice: shown, never picked.
    ...(value === "mixed"
      ? [
          {
            value: "mixed",
            label: words.mixed,
            description: words.mixedNote,
            disabled: true,
          },
        ]
      : []),
  ];
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => {
        if (isChoice(next)) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger
        variant="text"
        size="sm"
        aria-label={words.choiceOf(label)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

/** A quiet Select of what Grasp may do with one tool: a tool that changes something always asks. */
export const ToolSelect = ({
  tool,
  words,
  onChange,
}: {
  tool: AppTool;
  words: AppIntegrationWords;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const note = {
    never: words.neverNote,
    read: words.toolReadNote,
    write: words.toolWriteNote,
  };
  return (
    <Select
      value={tool.choice}
      items={choicesFor(tool).map((choice) => ({
        value: choice,
        label: wordOf(choice, words),
        description: note[choice],
      }))}
      onValueChange={(next) => {
        if (isChoice(next)) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger
        variant="text"
        size="sm"
        aria-label={words.choiceOf(tool.name)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

/** How many tools read and how many change: one line, then a thin bar of the two, reading solid and changing hatched. */
export const Balance = ({
  tools,
  words,
}: {
  tools: readonly AppTool[];
  words: AppIntegrationWords;
}) => {
  const reads = tools.filter((tool) => tool.kind === "read").length;
  const writes = tools.length - reads;
  return (
    <div data-slot="app-balance" {...stylex.props(styles.balance)}>
      <p {...stylex.props(styles.balanceLine)}>
        <span {...stylex.props(styles.key)}>
          <span
            aria-hidden="true"
            {...stylex.props(styles.swatch, styles.reads)}
          />
          {words.readCount(reads)}
        </span>
        <span {...stylex.props(styles.key)}>
          <span
            aria-hidden="true"
            {...stylex.props(styles.swatch, styles.writes)}
          />
          {words.changeCount(writes)}
        </span>
      </p>
      {/* The line above says the counts; the bar shows their share. */}
      <div aria-hidden="true" {...stylex.props(styles.bar)}>
        {reads > 0 ? (
          <span
            {...stylex.props(styles.part, styles.reads, styles.grow(reads))}
          />
        ) : null}
        {writes > 0 ? (
          <span
            {...stylex.props(styles.part, styles.writes, styles.grow(writes))}
          />
        ) : null}
      </div>
    </div>
  );
};

/** A connection's state as a quiet dot and its word; Not connected without one. */
export const StateWord = ({
  state,
  words,
}: {
  state: AppState | undefined;
  words: AppIntegrationWords;
}) => {
  const word =
    state === undefined
      ? words.notConnected
      : {
          works: words.works,
          "needs-you": words.needsYou,
          "sign-in": words.signedOut,
          reconnect: words.stopped,
        }[state];
  const looks = {
    works: styles.works,
    "needs-you": styles.attention,
    "sign-in": styles.attention,
    reconnect: styles.attention,
  };
  const look = state === undefined ? styles.none : looks[state];
  return (
    <span {...stylex.props(styles.state)}>
      <span aria-hidden="true" {...stylex.props(styles.dot, look)} />
      {word}
    </span>
  );
};

/** Every prop an AppsState takes. */
export interface AppsStateProps {
  /** The connected apps. */
  apps: readonly App[];
  words?: Partial<AppIntegrationWords>;
}

/**
 * The connected apps summed up in one line, as a page's band says it: how many need someone, in
 * amber, else how many are connected.
 */
export const AppsState = ({ apps, words: given }: AppsStateProps) => {
  const words = useWords("appIntegration", appIntegrationWords, given);
  const waiting = apps.filter(needsYou).length;
  return (
    <span {...stylex.props(styles.state)}>
      <span
        aria-hidden="true"
        {...stylex.props(
          styles.dot,
          waiting > 0 ? styles.attention : styles.works
        )}
      />
      {waiting > 0
        ? words.appsNeedYou(waiting)
        : words.connectedCount(apps.length)}
    </span>
  );
};

/**
 * The app's description cut at two lines, with Show more under it where it runs longer (a press,
 * not a hover, so a touch screen reaches it too), and Show less once it is whole.
 */
export const Clamped = ({
  text,
  words,
}: {
  text: string;
  words: AppIntegrationWords;
}) => {
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null || whole) {
      return () => {
        // Whole, it is not measured.
      };
    }
    const measure = () => {
      setCut(text !== "" && element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(element);
    return () => {
      seen.disconnect();
    };
  }, [text, whole]);
  return (
    <>
      <span
        ref={box}
        id={id}
        {...stylex.props(styles.clampText, !whole && styles.clamped)}
      >
        {text}
      </span>
      {cut || whole ? (
        <button
          type="button"
          aria-expanded={whole}
          aria-controls={id}
          onClick={() => {
            setWhole(!whole);
          }}
          {...stylex.props(styles.more, focus.ring)}
        >
          {whole ? words.showLess : words.showMore}
        </button>
      ) : null}
    </>
  );
};

/** Whether the app is offered in the organization: a compact switch, named by `offered`, and one line for its state. */
export const OfferSwitch = ({
  offered,
  onChange,
  words,
}: {
  offered: boolean;
  onChange: (offered: boolean) => void;
  words: AppIntegrationWords;
}) => (
  <span {...stylex.props(styles.offer)}>
    <span {...stylex.props(styles.offerSwitch)}>
      <Switch
        aria-label={words.offered}
        checked={offered}
        onCheckedChange={onChange}
      />
    </span>
    <span {...stylex.props(styles.offerLine)}>
      {offered ? words.offeredOn : words.offeredOff}
    </span>
  </span>
);

/** What the host does for the app's actions; each left out is not offered. */
export interface AppActions {
  /**
   * The Connect that opens the connect dialog (`<ConnectApp app={app} … />`, the connect-app block):
   * in place of a plain Connect button, for an app not connected or to connect again, so the dialog
   * grows from it.
   */
  connect?: ReactNode;
  /** Connect it, or connect it again, where no `connect` is given. */
  onConnect?: (app: App) => void;
  /** Sign in again. */
  onSignIn?: (app: App) => void;
  /** Connect a second account. */
  onConnectAnother?: (app: App) => void;
  /** Disconnect it (the host asks first). */
  onDisconnect?: (app: App) => void;
  /**
   * The person is a member, who cannot connect apps: where the app waits to be connected, the page
   * and the panel say "An admin connects this" in place of Connect. Left out, a missing Connect shows
   * nothing (the host still loading what it needs), never that line.
   * @default false
   */
  member?: boolean;
}

/** Manage: a menu of what can be done to the connection, Disconnect last. */
export const ManageMenu = ({
  app,
  actions,
  words,
  size,
  asState = false,
}: {
  app: App;
  actions: AppActions;
  words: AppIntegrationWords;
  size: "xs" | "sm";
  asState?: boolean;
}) => {
  // With `asState` the trigger is the connection's state ("Connected"), so no Status line repeats it.
  const state = <StateWord state={app.connection?.state} words={words} />;
  const items: { label: string; run: (app: App) => void; danger?: boolean }[] =
    [];
  if (actions.onSignIn !== undefined) {
    items.push({ label: words.signInAgain, run: actions.onSignIn });
  }
  if (actions.onConnectAnother !== undefined) {
    items.push({ label: words.connectAnother, run: actions.onConnectAnother });
  }
  if (actions.onDisconnect !== undefined) {
    items.push({
      label: words.disconnect,
      run: actions.onDisconnect,
      danger: true,
    });
  }
  if (items.length === 0) {
    return asState ? state : null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        variant="quiet"
        size={size}
        chevron
        {...(asState ? { "aria-label": words.manage } : {})}
      >
        {asState ? state : words.manage}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant={item.danger === true ? "danger" : undefined}
            onSelect={() => {
              item.run(app);
            }}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Connect, or Connect again: the host's dialog trigger where given, else a plain button. */
export const ConnectAction = ({
  app,
  actions,
  words,
  size,
}: {
  app: App;
  actions: AppActions;
  words: AppIntegrationWords;
  size: "xs" | "sm";
}) => {
  if (actions.connect !== undefined) {
    return <span {...stylex.props(styles.slot)}>{actions.connect}</span>;
  }
  return actions.onConnect === undefined ? null : (
    <Button
      variant="ink"
      size={size}
      onClick={() => {
        actions.onConnect?.(app);
      }}
    >
      {app.connection === undefined ? words.connect : words.connectAgain}
    </Button>
  );
};

/** Whether the person may connect it: the host gave a Connect (an admin), else it is said why not. */
export const canConnect = (actions: AppActions) =>
  actions.connect !== undefined || actions.onConnect !== undefined;

/** Whether the app asks to be connected (again) before anything else: none yet, or it stopped. */
export const asksConnect = (app: App) =>
  app.connection === undefined || app.connection.state === "reconnect";
