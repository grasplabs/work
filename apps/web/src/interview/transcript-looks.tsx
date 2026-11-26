import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, PencilIcon, TrashIcon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { pixel } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Marked } from "./marked.tsx";
import { lineRow } from "./transcript-looks.stylex.ts";
import { useInterviewWords } from "./words.ts";

// How a line of the transcript looks, three ways to choose from (a
// concept, `?transcript=a|b|c`; `a` when none is asked for):
//
//   a  Script: who spoke stands in a narrow column at the start, once per
//      turn, as in a play's script; Stephen's words and theirs both
//      in the sans (his serif is the stage's).
//   b  Chat: Stephen at the start under his small pixel mark, no bubble;
//      theirs at the end in a soft bubble, as a message they sent.
//   c  Q&A: the conversation as a printed interview, his question and
//      their answer as one numbered exchange, their words on a mint rule.
//
// In each a line is removed from a small bin that shows under a pointer
// resting on the line or with the keyboard on it, and always, quietly, on
// a touch screen. Every line wraps evenly, so no word is left alone.

export type TranscriptLook = "a" | "b" | "c";

/** Which look the transcript has, from `?transcript=`. */
export const useTranscriptLook = (): TranscriptLook => {
  // Read from the address itself, not the router's: the switch is set by hand and read once per open.
  const look = new URLSearchParams(window.location.search).get("transcript");
  return look === "a" || look === "c" ? look : "b";
};

/** A line where it stands in the conversation: its place is how core removes it. */
export interface Placed {
  line: InterviewLine;
  place: number;
  /** It starts a turn: the one before was the other's, or there was none. */
  starts: boolean;
}

/** A screen without a resting pointer: the bin can't wait for one, so it stays, quietly. */
const touch = "@media not ((hover: hover) and (pointer: fine))";

const styles = stylex.create({
  // The bin: hidden till a pointer rests on its line or the keyboard reaches it; quiet on touch.
  bin: {
    opacity: {
      default: 0,
      [touch]: 0.55,
      [stylex.when.ancestor(":hover", lineRow)]: 1,
      [stylex.when.ancestor(":focus-within", lineRow)]: 1,
    },
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: duration.ui,
  },
  line: {
    textWrap: "pretty",
    overflowWrap: "anywhere",
    margin: 0,
  },
  // In the sans of theirs: the transcript is a record to read, the serif is for the stage.
  his: {
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: 1.55,
    color: colors.foreground,
  },
  theirs: {
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: 1.55,
    color: colors.bodyForeground,
  },
  removed: {
    fontFamily: font.sans,
    fontSize: font.textSm,
    fontStyle: "italic",
    color: colors.mutedForeground,
  },
  who: {
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    letterSpacing: font.trackingUi,
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  },
  whoThem: { color: colors.pine },

  // a: Script.
  scriptRow: {
    display: "grid",
    gridTemplateColumns: "4.5rem minmax(0, 1fr) auto",
    columnGap: space["3"],
    alignItems: "baseline",
  },

  // b: Chat.
  chatHis: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: space["3"],
    alignItems: "start",
  },
  chatHead: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    gap: space["3"],
    paddingBlockEnd: space["1"],
  },
  // His mark: a small square of his light, seen through the system's pixel.
  mark: {
    display: "block",
    width: "1.25rem",
    height: "1.25rem",
    borderRadius: radius.xs,
    backgroundColor: colors.muted,
    backgroundImage: `linear-gradient(135deg, ${colors.mint}, ${colors.pine})`,
    maskImage: pixel.mask,
    maskSize: "3px 3px",
  },
  chatHisText: { gridColumn: "1" },
  // The bubble's tools, side by side, shown as the bin is.
  tools: { display: "inline-flex", alignItems: "center" },
  editing: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
    paddingInlineStart: "15%",
  },
  bubbleEditing: {
    width: "100%",
    boxSizing: "border-box",
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
  },
  // The words typed where they stood: no box, no ring, the bubble round them.
  field: {
    display: "block",
    width: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    resize: "none",
    outline: "none",
    fieldSizing: "content",
    caretColor: colors.foreground,
  },
  hint: {
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  chatTheirs: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: space["1"],
    paddingInlineStart: "15%",
  },
  bubble: {
    paddingInline: space["4"],
    paddingBlock: space["2"],
    borderRadius: radius.xl,
    borderEndEndRadius: radius.sm,
    // The veil of ink on the page's own ground, so nothing behind shows through it.
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(${colors.secondary}, ${colors.secondary})`,
  },

  // c: Q&A.
  exchange: {
    display: "grid",
    gridTemplateColumns: "1.75rem minmax(0, 1fr)",
    columnGap: space["3"],
    rowGap: space["3"],
    paddingBlock: space["5"],
    borderBlockStartWidth: "1px",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  exchangeFirst: { borderBlockStartWidth: 0, paddingBlockStart: space["2"] },
  number: {
    fontFamily: font.mono,
    fontSize: font.textXs,
    lineHeight: 1.9,
    color: colors.mutedForeground,
  },
  qa: {
    gridColumn: "2",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    columnGap: space["2"],
    alignItems: "start",
  },
  question: { fontWeight: font.weightMedium },
  answer: {
    paddingInlineStart: space["3"],
    borderInlineStartWidth: "2px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.mint,
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: space["4"],
    paddingBlockEnd: space["2"],
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  legendHis: {
    width: "0.75rem",
    height: "2px",
    backgroundColor: colors.foreground,
  },
  legendTheirs: {
    width: "2px",
    height: "0.9rem",
    backgroundColor: colors.mint,
  },
});

/** The small bin that removes a line, once confirmed. */
const Bin = ({ label, onRemove }: { label: string; onRemove: () => void }) => (
  <span {...stylex.props(styles.bin)}>
    <Button
      aria-label={label}
      onClick={onRemove}
      size="icon-xs"
      tooltip={label}
      variant="ghost"
    >
      <Icon icon={TrashIcon} />
    </Button>
  </span>
);

/** How many words of a line its remove button names it by. */
const namingWords = 6;

/** The first words of `text`, to name its line by. */
const startOf = (text: string): string => {
  const words = text.trim().split(/\s+/u);
  const start = words.slice(0, namingWords).join(" ");
  return words.length > namingWords ? `${start}…` : start;
};

/** The words of one line, in whose voice they are, with what he marked in theirs. */
const Words = ({
  line,
  extra,
}: {
  line: InterviewLine;
  extra?: stylex.StyleXStyles;
}) => {
  const { t } = useLingui();
  const names = useInterviewWords().tag;
  const stephen = line.from === "stephen";
  if (line.removed === true) {
    return (
      <p {...stylex.props(styles.line, styles.removed, extra)}>
        {stephen ? t`A message of mine, removed.` : t`Removed.`}
      </p>
    );
  }
  return (
    <p
      {...stylex.props(
        styles.line,
        stephen ? styles.his : styles.theirs,
        extra
      )}
    >
      {stephen ? (
        line.text
      ) : (
        <Marked marks={line.marks ?? []} names={names} text={line.text} />
      )}
    </p>
  );
};

/** The bin for a line, or nothing once it is removed. */
const BinFor = ({
  line,
  who,
  onRemove,
}: {
  line: InterviewLine;
  who: string;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  if (line.removed === true) {
    return <span />;
  }
  const words = startOf(line.text);
  return (
    <Bin
      label={
        line.from === "stephen"
          ? t`Remove ${who}’s message: ${words}`
          : t`Remove your message: ${words}`
      }
      onRemove={onRemove}
    />
  );
};

/** Who spoke, as a short label: his name, or "You". */
const Who = ({ stephen, who }: { stephen: boolean; who: string }) => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.who, !stephen && styles.whoThem)}>
      {stephen ? who : t({ message: "You", context: "the person interviewed" })}
    </span>
  );
};

/** a: a line of the script, its speaker at the start of its turn. */
export const ScriptLine = ({
  placed,
  who,
  onRemove,
}: {
  placed: Placed;
  who: string;
  onRemove: () => void;
  onEdit?: (text: string) => void;
}) => {
  const stephen = placed.line.from === "stephen";
  return (
    <div {...stylex.props(styles.scriptRow, lineRow)}>
      <span>{placed.starts ? <Who stephen={stephen} who={who} /> : null}</span>
      <Words line={placed.line} />
      <BinFor line={placed.line} onRemove={onRemove} who={who} />
    </div>
  );
};

/**
 * Their line, open to put right in its own bubble: the words as they
 * stand, Enter keeps them, Escape leaves them as they were. No ring: the
 * bubble's edge and the caret say where the words go.
 */
const LineEditor = ({
  text,
  onSave,
  onCancel,
}: {
  text: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) => {
  const { t } = useLingui();
  const [words, setWords] = useState(text);
  const save = () => {
    const kept = words.trim();
    if (kept === "") {
      onCancel();
      return;
    }
    onSave(kept);
  };
  return (
    <div {...stylex.props(styles.editing)}>
      <div {...stylex.props(styles.bubble, styles.bubbleEditing)}>
        <textarea
          aria-label={t`Your message`}
          autoFocus
          onBlur={save}
          onChange={(event) => {
            setWords(event.target.value);
          }}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Only the change is put away, not the transcript.
              event.stopPropagation();
              event.preventDefault();
              onCancel();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              save();
            }
          }}
          rows={1}
          value={words}
          {...stylex.props(styles.line, styles.theirs, styles.field)}
        />
      </div>
      <span {...stylex.props(styles.hint)}>
        {t`Enter to keep · Esc to leave it`}
      </span>
    </div>
  );
};

/** b: a line of theirs, in a bubble at the end; under a resting pointer it can be put right or removed. */
const TheirChatLine = ({
  line,
  onRemove,
  onEdit,
}: {
  line: InterviewLine;
  onRemove: () => void;
  onEdit?: ((text: string) => void) | undefined;
}) => {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  if (line.removed === true) {
    return (
      <div {...stylex.props(styles.chatTheirs)}>
        <Words line={line} />
      </div>
    );
  }
  if (editing && onEdit !== undefined) {
    return (
      <LineEditor
        onCancel={() => {
          setEditing(false);
        }}
        onSave={(text) => {
          setEditing(false);
          if (text !== line.text) {
            onEdit(text);
          }
        }}
        text={line.text}
      />
    );
  }
  const words = startOf(line.text);
  return (
    <div {...stylex.props(styles.chatTheirs, lineRow)}>
      <div {...stylex.props(styles.bubble)}>
        <Words line={line} />
      </div>
      <span {...stylex.props(styles.bin, styles.tools)}>
        {onEdit === undefined ? null : (
          <Button
            aria-label={t`Edit your message: ${words}`}
            onClick={() => {
              setEditing(true);
            }}
            size="icon-xs"
            tooltip={t({
              message: "Edit",
              context: "a message of theirs in the transcript",
            })}
            variant="ghost"
          >
            <Icon icon={PencilIcon} />
          </Button>
        )}
        <Button
          aria-label={t`Remove your message: ${words}`}
          onClick={onRemove}
          size="icon-xs"
          tooltip={t`Remove`}
          variant="ghost"
        >
          <Icon icon={TrashIcon} />
        </Button>
      </span>
    </div>
  );
};

/** b: a line of the chat, his at the start under his mark, theirs at the end in a bubble. */
export const ChatLine = ({
  placed,
  who,
  onRemove,
  onEdit,
}: {
  placed: Placed;
  who: string;
  onRemove: () => void;
  onEdit?: (text: string) => void;
}) => {
  if (placed.line.from === "stephen") {
    return (
      <div {...stylex.props(styles.chatHis, lineRow)}>
        {placed.starts ? (
          <div {...stylex.props(styles.chatHead)}>
            <Who stephen who={who} />
          </div>
        ) : null}
        <Words extra={styles.chatHisText} line={placed.line} />
        <BinFor line={placed.line} onRemove={onRemove} who={who} />
      </div>
    );
  }
  return (
    <TheirChatLine line={placed.line} onEdit={onEdit} onRemove={onRemove} />
  );
};

/** One exchange of the Q&A: what he asked, then what they answered. */
export interface Exchange {
  lines: Placed[];
}

/** c: the lines grouped as exchanges, each opened by his line. */
export const exchangesOf = (placed: Placed[]): Exchange[] => {
  const exchanges: Exchange[] = [];
  for (const one of placed) {
    const last = exchanges.at(-1);
    const opens =
      last === undefined || (one.line.from === "stephen" && one.starts);
    if (opens) {
      exchanges.push({ lines: [one] });
    } else {
      last.lines.push(one);
    }
  }
  return exchanges;
};

/** c: the key over the Q&A, so whose words are whose is never a guess. */
export const QaLegend = ({ who }: { who: string }) => {
  const { t } = useLingui();
  return (
    <div aria-hidden="true" {...stylex.props(styles.legend)}>
      <span {...stylex.props(styles.legendItem)}>
        <span {...stylex.props(styles.legendHis)} />
        <span {...stylex.props(styles.who)}>{who}</span>
      </span>
      <span {...stylex.props(styles.legendItem)}>
        <span {...stylex.props(styles.legendTheirs)} />
        <span {...stylex.props(styles.who, styles.whoThem)}>
          {t({ message: "You", context: "the person interviewed" })}
        </span>
      </span>
    </div>
  );
};

/** c: one numbered exchange. */
export const QaExchange = ({
  exchange,
  number,
  who,
  onRemove,
}: {
  exchange: Exchange;
  number: number;
  who: string;
  onRemove: (place: number) => void;
}) => (
  <div {...stylex.props(styles.exchange, number === 1 && styles.exchangeFirst)}>
    <span aria-hidden="true" {...stylex.props(styles.number)}>
      {String(number).padStart(2, "0")}
    </span>
    {exchange.lines.map((placed) => {
      const stephen = placed.line.from === "stephen";
      return (
        <div key={placed.place} {...stylex.props(styles.qa, lineRow)}>
          <Words
            extra={stephen ? styles.question : styles.answer}
            line={placed.line}
          />
          <BinFor
            line={placed.line}
            onRemove={() => {
              onRemove(placed.place);
            }}
            who={who}
          />
        </div>
      );
    })}
  </div>
);
