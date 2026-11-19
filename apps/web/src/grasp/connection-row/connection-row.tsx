"use client";

import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import { Button } from "../button";
import { visuallyHidden } from "../hidden/hidden";
import { Alert as Warning, Icon, Info } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { Switch } from "../switch";
import type { SwitchChange } from "../switch";
import { grasp } from "../tokens/tokens.stylex";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { useWords, withGiven } from "../words/words";
import { connectionRowWords } from "./words";
import type { ConnectionRowWords } from "./words";

/** Where the place stands: on (a switch), missing (not connected), or broken (it lost access). */
export type ConnectionStatus = "on" | "missing" | "broken";

/** Every prop a ConnectionRow takes. */
export interface ConnectionRowProps {
  /** The place, in its own words: a channel ("#finance-ar"), "Direct messages". */
  label: string;
  /** One quiet line: what answering there means ("Answers when someone mentions it"). */
  help?: string;
  /**
   * `on`: a switch. `missing`: not connected, a sentence and one action instead of the switch.
   * `broken`: it lost access, a sentence in the attention tone and the action that fixes it in the
   * switch's place.
   * @default "on"
   */
  status?: ConnectionStatus;
  /** On now, for a switch your code holds. Pass `onCheckedChange` with it. */
  checked?: boolean;
  /** On at first, when the switch holds its own state. @default false */
  defaultChecked?: boolean;
  /** Runs when the switch turns on or off, with the new state. */
  onCheckedChange?: SwitchChange;
  /** What is wrong, in one sentence, when `missing` or `broken` ("Grasp lost access to Slack on Monday."). */
  problem?: string;
  /** The one action that fixes it, when `missing` or `broken` ("Connect Slack", "Reconnect"). */
  actionLabel?: string;
  /** Called by the action. */
  onAction?: () => void;
  /**
   * Who can fix it when the reader cannot ("Ilse Vos and Pieter Jansen can connect it."), behind
   * an info mark beside the name, when `missing` or `broken`.
   */
  actionHelp?: ReactNode;
  /**
   * The info mark's name for a screen reader.
   * @default "Who can fix this"
   */
  actionHelpLabel?: string;
  /** Said to a screen reader for a broken row that gives no sentence. @default "Not working" */
  brokenLabel?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ whoCanFix: "Who to ask" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<ConnectionRowWords>;
}

/** A row narrower than this puts its action under its sentence (the row's own width). */
const NARROW = "@container connection-row (width < 28rem)";

const styles = stylex.create({
  box: {
    containerType: "inline-size",
    containerName: "connection-row",
    // A hairline over every row but the first, as Setting row's rows.
    borderTopStyle: "solid",
    borderTopColor: grasp.line,
    borderTopWidth: { default: grasp.hairline, ":first-child": 0 },
    fontFamily: grasp.fontSans,
  },
  pad: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    boxSizing: "border-box",
    minHeight: grasp.settingRow,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
  },
  // Words that never hyphenate, set on the words themselves: Label hyphenates its own.
  whole: { hyphens: "manual", overflowWrap: "break-word" },
  // The words and the control side by side, the control centred on the two lines; in a narrow row
  // the control goes under the words, at the start.
  row: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto",
      [NARROW]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    columnGap: grasp.space6,
    rowGap: grasp.space2,
  },
  // The name and its line as far apart as Switch has them, so every state is as tall.
  words: { display: "grid", rowGap: grasp.space1, minWidth: 0 },
  name: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  // The info mark, in a box one line tall: its button may be taller, the row never is.
  info: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.textSmLine,
  },
  line: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    textWrap: "pretty",
  },
  // Broken: the sentence in the attention tone, after a small warning mark on its first line.
  attention: { color: grasp.attention },
  mark: {
    [iconVars.size]: grasp.textSm,
    display: "inline-flex",
    verticalAlign: "-0.125em",
    marginInlineEnd: grasp.space1,
  },
  action: {
    display: "flex",
    justifySelf: { default: "end", [NARROW]: "start" },
  },
  // A switch is small: it stays at the row's end at every width, as Switch's own row has it.
  rowSwitch: { gridTemplateColumns: "minmax(0, 1fr) auto" },
  actionSwitch: { justifySelf: "end" },
  // The name of an on row is the switch's label: a press on it turns the switch.
  press: { cursor: "pointer" },
});

/** What only a switch row takes, given to Switch only when set. */
const switchState = ({
  checked,
  defaultChecked,
  onCheckedChange,
}: Pick<
  ConnectionRowProps,
  "checked" | "defaultChecked" | "onCheckedChange"
>) => ({
  ...(checked !== undefined && { checked }),
  ...(defaultChecked !== undefined && { defaultChecked }),
  ...(onCheckedChange !== undefined && { onCheckedChange }),
});

type ProblemProps = Pick<
  ConnectionRowProps,
  | "label"
  | "problem"
  | "actionLabel"
  | "onAction"
  | "actionHelp"
  | "actionHelpLabel"
  | "brokenLabel"
  | "words"
> & {
  broken: boolean;
};

const hasWords = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== "";

/**
 * Not connected, or broken: the name (who can fix it behind the info mark beside it), the sentence
 * as the one line (broken: in the attention tone after the warning mark), the action at the end.
 */
const Problem = ({
  label,
  problem,
  actionLabel,
  onAction,
  actionHelp,
  actionHelpLabel: helpLabelGiven,
  brokenLabel,
  broken,
  words,
}: ProblemProps) => {
  const said = useId();
  // The words file gives both in the page's language; the caller's props still win.
  const text = withGiven(useWords("connectionRow", connectionRowWords, words), {
    whoCanFix: helpLabelGiven,
    notWorking: brokenLabel,
  });
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.words, styles.whole)}>
        <span {...stylex.props(styles.name)}>
          {label}
          {hasWords(actionHelp) && (
            <span
              data-slot="connection-row-action-help"
              {...stylex.props(styles.info)}
            >
              <Tooltip>
                <TooltipTrigger
                  icon={Info}
                  aria-label={text.whoCanFix}
                  variant="ghost"
                  size="xs"
                />
                <TooltipContent>{actionHelp}</TooltipContent>
              </Tooltip>
            </span>
          )}
        </span>
        {problem !== undefined && (
          <p
            id={said}
            data-slot="connection-row-problem"
            {...stylex.props(styles.line, broken && styles.attention)}
          >
            {broken && (
              <span aria-hidden="true" {...stylex.props(styles.mark)}>
                <Icon icon={Warning} />
              </span>
            )}
            {problem}
          </p>
        )}
        {/* Broken says it is not working even where the sentence does not. */}
        {broken && problem === undefined && (
          <span {...stylex.props(visuallyHidden)}>{text.notWorking}</span>
        )}
      </div>
      {actionLabel !== undefined && (
        <span
          data-slot="connection-row-action"
          {...stylex.props(styles.action)}
        >
          <Button
            size="sm"
            variant="quiet"
            onClick={onAction}
            aria-describedby={problem === undefined ? undefined : said}
          >
            {actionLabel}
          </Button>
        </span>
      )}
    </div>
  );
};

/**
 * On: the name and its quiet line, the switch at the end centred on the two lines, as the other
 * states' actions are. The name is the switch's label (a press on it turns it), the line its
 * description.
 */
const On = ({
  label,
  help,
  state,
}: {
  label: string;
  help?: string;
  state: ReturnType<typeof switchState> & { disabled?: boolean };
}) => {
  const id = useId();
  const helpId = useId();
  return (
    <div {...stylex.props(styles.row, styles.rowSwitch)}>
      <div {...stylex.props(styles.words, styles.whole)}>
        <label htmlFor={id} {...stylex.props(styles.name, styles.press)}>
          {label}
        </label>
        {help !== undefined && (
          <p id={helpId} {...stylex.props(styles.line)}>
            {help}
          </p>
        )}
      </div>
      <span
        data-slot="connection-row-switch"
        {...stylex.props(styles.action, styles.actionSwitch)}
      >
        <Switch
          id={id}
          aria-describedby={help === undefined ? undefined : helpId}
          {...state}
        />
      </span>
    </div>
  );
};

/** One place an agent can answer, on, not connected, or broken. Put it in SettingsRows. */
export const ConnectionRow = ({
  label,
  help,
  status = "on",
  checked,
  defaultChecked,
  onCheckedChange,
  problem,
  actionLabel,
  onAction,
  actionHelp,
  actionHelpLabel,
  brokenLabel,
  words,
}: ConnectionRowProps) => {
  const state = switchState({ checked, defaultChecked, onCheckedChange });
  // Broken with nothing to say or do keeps the switch, out of use, as before.
  const broken =
    status === "broken" && (problem !== undefined || actionLabel !== undefined);
  return (
    <div
      data-slot="connection-row"
      data-status={status}
      {...stylex.props(styles.box)}
    >
      <div {...stylex.props(styles.pad)}>
        {status === "missing" || broken ? (
          <Problem
            label={label}
            problem={problem}
            actionLabel={actionLabel}
            onAction={onAction}
            actionHelp={actionHelp}
            actionHelpLabel={actionHelpLabel}
            brokenLabel={brokenLabel}
            words={words}
            broken={broken}
          />
        ) : (
          // Broken: off and out of use, whatever it was, until it is fixed; a new status mounts the
          // switch afresh, so after Reconnect it shows the page's own choice again.
          <On
            key={status}
            label={label}
            help={help}
            state={
              status === "broken" ? { checked: false, disabled: true } : state
            }
          />
        )}
      </div>
    </div>
  );
};
