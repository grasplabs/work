import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  ChevronDownIcon,
  EyeIcon,
  Icon,
  LockIcon,
  PencilIcon,
  TableIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { MarkSize } from "../provider-mark.tsx";
import { useMarkTint } from "./mark-tint.ts";
import type {
  App,
  AppConnection,
  AppState,
  AppTool,
  AppToolChoice,
} from "./model.ts";
import { needsYou } from "./state.ts";
import { choiceUnder, choicesFor, presetOf } from "./tools.ts";
import type { ToolGroup } from "./tools.ts";
import { useAppWords } from "./words.ts";
import type { AppWords } from "./words.ts";

// The small parts an app's tile, panel, page and connect dialog share: its
// mark and its colour, the words of what Grasp may do (Never, Read, Write,
// Mixed, each with an icon, so colour is never the only mark) and the
// control that sets it, how many tools read and change as one line over a
// two-tone bar, a connection's state as a dot and a word, and the Manage
// menu. Each is Damsko's parts where Damsko has one; the bar, the dot and
// the overlapping marks are the product's own drawing.

/** What Grasp may do with a group: one choice for all its tools, or Mixed where they differ. */
export type GroupChoice = AppToolChoice | "mixed";

const styles = stylex.create({
  // Whether it is offered: the switch, then the one line for its state, small and muted.
  offer: {
    display: "flex",
    alignItems: "flex-start",
    gap: space["2"],
    minWidth: 0,
  },
  offerSwitch: { display: "inline-flex", flexShrink: 0 },
  offerLine: {
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  // A change that didn't go through: why, in the line's place, as a field's error.
  offerFailed: { color: colors.destructive },
  // A host's action, laid out as if it stood there itself.
  slot: { display: "contents" },
  // A mark the host gave, in its own box at the size asked.
  mark: { display: "inline-flex", flexShrink: 0 },
  word: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    display: "inline-flex",
    alignItems: "center",
    gap: space["1"],
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  },
  // Allowed in some way: the word in ink, so what Grasp may use stands out from the rest.
  wordOn: { color: colors.foreground },
  // How many read and change: the line, then the bar.
  balance: { display: "grid", gap: space["2"], minWidth: 0 },
  balanceLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["1"],
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
    fontVariantNumeric: "tabular-nums",
  },
  key: { display: "inline-flex", alignItems: "center", gap: space["1"] },
  // The bar: reading solid, changing hatched, a gap between, so the two read apart in shape too.
  bar: { display: "flex", gap: "2px", height: space["2"], minWidth: 0 },
  part: {
    minWidth: "2px",
    borderRadius: radius.full,
    forcedColorAdjust: "none",
  },
  grow: (share: number) => ({ flexGrow: share }),
  reads: {
    backgroundColor: {
      default: colors.foreground,
      [media.forcedColors]: "CanvasText",
    },
  },
  writes: {
    backgroundColor: "transparent",
    backgroundImage: {
      default: `repeating-linear-gradient(135deg, ${colors.mutedForeground} 0 2px, transparent 2px 4px)`,
      [media.forcedColors]:
        "repeating-linear-gradient(135deg, CanvasText 0 2px, transparent 2px 4px)",
    },
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.mutedForeground}`,
      [media.forcedColors]: "inset 0 0 0 1px CanvasText",
    },
  },
  // The bar's key: a small swatch of each part before its count.
  swatch: {
    display: "inline-block",
    width: space["2"],
    height: space["2"],
    borderRadius: "2px",
    forcedColorAdjust: "none",
  },
  // A band's apps: their marks a step apart, then the line.
  stack: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  stackMarks: { display: "flex", gap: space["1"] },
  // A connection's state: a dot and its word.
  state: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    verticalAlign: "top",
  },
  dot: {
    width: "6px",
    height: "6px",
    borderRadius: radius.full,
    flexShrink: 0,
    forcedColorAdjust: "none",
  },
  works: {
    backgroundColor: {
      default: colors.success,
      [media.forcedColors]: "CanvasText",
    },
  },
  attention: {
    backgroundColor: {
      default: colors.warning,
      [media.forcedColors]: "CanvasText",
    },
  },
  none: {
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.mutedForeground}`,
      [media.forcedColors]: "inset 0 0 0 1px CanvasText",
    },
  },
  // A description cut at its lines, and the quiet button that shows it whole.
  clampText: { display: "block", whiteSpace: "pre-line", textWrap: "pretty" },
  clamped: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
  },
  more: { marginBlockStart: space["1"] },
});

/** The app's mark at a size: the host's, or its first letter on a tile. */
export const AppMark = ({ app, size }: { app: App; size: MarkSize }) =>
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
  never: LockIcon,
  read: EyeIcon,
  write: PencilIcon,
  mixed: TableIcon,
};

/** A choice's word. */
export const wordOf = (choice: GroupChoice, words: AppWords) =>
  ({
    never: words.never,
    read: words.read,
    write: words.write,
    mixed: words.mixed,
  })[choice];

/** The words for a choice, with its icon: what a member sees, and a summary row's end. */
export const ChoiceWord = ({ choice }: { choice: GroupChoice }) => {
  const words = useAppWords();
  return (
    <span {...stylex.props(styles.word, choice !== "never" && styles.wordOn)}>
      <Icon icon={iconOf[choice]} />
      {wordOf(choice, words)}
    </span>
  );
};

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
  onChange,
}: {
  group: ToolGroup;
  label: string;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const words = useAppWords();
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
      items={items}
      onValueChange={(next) => {
        if (isChoice(next)) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={words.choiceOf(label)}
        size="sm"
        variant="ghost"
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
  onChange,
}: {
  tool: AppTool;
  onChange: (choice: AppToolChoice) => void;
}) => {
  const words = useAppWords();
  const note = {
    never: words.neverNote,
    read: words.toolReadNote,
    write: words.toolWriteNote,
  };
  return (
    <Select
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
      value={tool.choice}
    >
      <SelectTrigger
        aria-label={words.choiceOf(tool.name)}
        size="sm"
        variant="ghost"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
};

/** How many tools read and how many change: one line, then a thin bar of the two, reading solid and changing hatched. */
export const Balance = ({ tools }: { tools: readonly AppTool[] }) => {
  const words = useAppWords();
  const reads = tools.filter((tool) => tool.kind === "read").length;
  const writes = tools.length - reads;
  return (
    <div {...stylex.props(styles.balance)}>
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
export const StateWord = ({ state }: { state: AppState | undefined }) => {
  const words = useAppWords();
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

/**
 * The connected apps summed up, as a page's band says it: the marks of the
 * apps it speaks of, then one line. Where some need someone, their marks
 * and how many, in amber; else every connected app's marks and how many
 * are connected.
 */
export const AppsState = ({
  apps,
  waiting: waitingWords,
}: {
  apps: readonly App[];
  /** How many need someone, where the page says it its own way ("2 apps wait for an admin"). */
  waiting?: (count: number) => string;
}) => {
  const words = useAppWords();
  const waiting = apps.filter(needsYou);
  const shown = waiting.length > 0 ? waiting : apps;
  return (
    <span {...stylex.props(styles.stack)}>
      <span aria-hidden="true" {...stylex.props(styles.stackMarks)}>
        {shown.map((app) => (
          <AppMark app={app} key={app.id} size="sm" />
        ))}
      </span>
      <span {...stylex.props(styles.state)}>
        <span
          aria-hidden="true"
          {...stylex.props(
            styles.dot,
            waiting.length > 0 ? styles.attention : styles.works
          )}
        />
        {waiting.length > 0
          ? (waitingWords ?? words.appsNeedYou)(waiting.length)
          : words.connectedCount(apps.length)}
      </span>
    </span>
  );
};

/**
 * The app's description cut at two lines, with Show more under it where it
 * runs longer (a press, not a hover, so a touch screen reaches it too), and
 * Show less once it is whole.
 */
export const Clamped = ({ text }: { text: string }) => {
  const words = useAppWords();
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
        id={id}
        ref={box}
        {...stylex.props(styles.clampText, !whole && styles.clamped)}
      >
        {text}
      </span>
      {cut || whole ? (
        <span {...stylex.props(styles.more)}>
          <Button
            aria-controls={id}
            aria-expanded={whole}
            onClick={() => {
              setWhole(!whole);
            }}
            size="xs"
            variant="link"
          >
            {whole ? words.showLess : words.showMore}
          </Button>
        </span>
      ) : null}
    </>
  );
};

/**
 * Whether the app is offered in the organization: a compact switch, named
 * by `offered`, and one line for its state, or why its last change didn't
 * go through (`failure`).
 */
export const OfferSwitch = ({
  offered,
  onChange,
  failure,
}: {
  offered: boolean;
  onChange: (offered: boolean) => void;
  failure?: string | undefined;
}) => {
  const words = useAppWords();
  return (
    <span {...stylex.props(styles.offer)}>
      <span {...stylex.props(styles.offerSwitch)}>
        <Switch
          aria-label={words.offered}
          checked={offered}
          onCheckedChange={onChange}
        />
      </span>
      {failure === undefined ? (
        <span {...stylex.props(styles.offerLine)}>
          {offered ? words.offeredOn : words.offeredOff}
        </span>
      ) : (
        <span
          role="alert"
          {...stylex.props(styles.offerLine, styles.offerFailed)}
        >
          {failure}
        </span>
      )}
    </span>
  );
};

/** What the host does for the app's actions; each left out is not offered. */
export interface AppActions {
  /**
   * The Connect that opens the connect dialog (connect-app.tsx): in place
   * of a plain Connect button, for an app not connected or to connect
   * again, so the dialog grows from it.
   */
  connect?: ReactNode;
  /** Connect it, or connect it again, where no `connect` is given. */
  onConnect?: (app: App) => void;
  /** Sign in again: to `connection` where the page's row of that account asks. */
  onSignIn?: (app: App, connection?: AppConnection) => void;
  /** Connect a second account. */
  onConnectAnother?: (app: App) => void;
  /** Disconnect it (the host asks first): `connection` where the page's row of that account asks. */
  onDisconnect?: (app: App, connection?: AppConnection) => void;
  /**
   * The person is a member, who cannot connect apps: where the app waits
   * to be connected, the page and the panel say "An admin connects this"
   * in place of Connect. Left out, a missing Connect shows nothing (the
   * host still loading what it needs), never that line.
   */
  member?: boolean;
  /**
   * Why it can't be connected again yet, where it asks to be but something
   * must go first (a key that stopped working, which connect keeps as the
   * app's one): the panel offers Manage in place of Connect and says this,
   * as does the page's head.
   */
  whyNoConnect?: string;
}

/** Manage: a menu of what can be done to the connection, Disconnect last. */
export const ManageMenu = ({
  app,
  actions,
  size,
  asState = false,
}: {
  app: App;
  actions: AppActions;
  size: "xs" | "sm";
  asState?: boolean;
}) => {
  const words = useAppWords();
  // With `asState` the trigger is the connection's state ("Connected"), so no Status line repeats it.
  const state = <StateWord state={app.connection?.state} />;
  const items: {
    label: string;
    run: (app: App) => void;
    destructive?: boolean;
  }[] = [];
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
      destructive: true,
    });
  }
  if (items.length === 0) {
    return asState ? state : null;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {asState ? (
          <Button aria-label={words.manage} size={size} variant="outline">
            {state}
            <Icon icon={ChevronDownIcon} />
          </Button>
        ) : (
          <Button size={size} variant="outline">
            {words.manage}
            <Icon icon={ChevronDownIcon} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onSelect={() => {
              item.run(app);
            }}
            variant={item.destructive === true ? "destructive" : "default"}
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
  size,
}: {
  app: App;
  actions: AppActions;
  size: "xs" | "sm";
}) => {
  const words = useAppWords();
  if (actions.connect !== undefined) {
    return <span {...stylex.props(styles.slot)}>{actions.connect}</span>;
  }
  return actions.onConnect === undefined ? null : (
    <Button
      onClick={() => {
        actions.onConnect?.(app);
      }}
      size={size}
    >
      {app.connection === undefined ? words.connect : words.connectAgain}
    </Button>
  );
};

/** Whether the person may connect it: the host gave a Connect (an admin), else it is said why not. */
export const canConnect = (actions: AppActions) =>
  actions.connect !== undefined || actions.onConnect !== undefined;

/**
 * Whether the app asks to be connected (again) before anything else: none
 * yet, or it stopped, unless something must go first (`whyNoConnect`).
 */
export const asksConnect = (app: App, actions: AppActions) =>
  actions.whyNoConnect === undefined &&
  (app.connection === undefined || app.connection.state === "reconnect");
