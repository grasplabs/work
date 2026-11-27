import type { InterviewLine } from "@grasp-os/shared/interview-links";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, PencilIcon, TrashIcon } from "@grasp-os/ui/lib/icons";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { Marked } from "./marked.tsx";
import { useSmoothWords } from "./smooth-words.ts";
import { lineRow } from "./transcript-looks.stylex.ts";
import { useInterviewWords } from "./words.ts";

// How a line of the transcript looks: a chat. Stephen's lines at the
// start, his name over each turn, no bubble; theirs at the end in a soft
// bubble, as a message they sent. A line is removed from a small bin that
// shows under a pointer resting on the line or with the keyboard on it,
// and always, quietly, on a touch screen. Every line wraps evenly, so no
// word is left alone.

/** A line where it stands in the conversation: its place is how core removes it. */
export interface Placed {
  line: InterviewLine;
  place: number;
  /** It starts a turn: the one before was the other's, or there was none. */
  starts: boolean;
  /** His line as far as he has said it, while he says it: not to be removed yet. */
  saying?: boolean;
  /** One of his quick guide's lines: kept on this page only, not to be removed. */
  guide?: boolean;
}

/** A screen without a resting pointer: the bin can't wait for one, so it stays, quietly. */
const touch = "@media not ((hover: hover) and (pointer: fine))";

const styles = stylex.create({
  // A word's fade ends with it: a finished one holds no animation the page keeps weighing.
  word: { animationFillMode: "backwards" },
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
  // While his words come, lines break as they fill: evened out they would move as each word comes.
  coming: { textWrap: "wrap" },
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
  chatHisText: { gridColumn: "1" },
  // The bubble's tools, side by side, shown as the bin is: never squeezed by a long bubble, and
  // at its foot, where a long one ends, a little apart from it.
  tools: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    gap: space["1"],
    alignSelf: "flex-end",
    paddingBlockEnd: space["1"],
  },
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
    gap: space["2"],
    paddingInlineStart: "15%",
  },
  bubble: {
    minWidth: 0,
    paddingInline: space["4"],
    paddingBlock: space["2"],
    borderRadius: radius.xl,
    borderEndEndRadius: radius.sm,
    // The veil of ink on the page's own ground, so nothing behind shows through it.
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(${colors.secondary}, ${colors.secondary})`,
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

/** A word with the space after it. */
const WORD = /\S+\s*|\s+/gu;

/**
 * `text` as it grows: what stood there when it was first drawn stands, and
 * each word that comes after fades in once whole, as the chat's answer does
 * (Damsko's Markdown `Words`). Each keeps its place as its key, so a word
 * never fades twice.
 */
const FadingWords = ({ text }: { text: string }) => {
  const [plain, setPlain] = useState(text.length);
  // Written again shorter (his line corrected as he was talked over): what stands is not news.
  if (text.length < plain) {
    setPlain(text.length);
  }
  if (text.length <= plain) {
    return text;
  }
  const parts: ReactNode[] = [text.slice(0, plain)];
  for (const word of text.slice(plain).matchAll(WORD)) {
    const at = plain + word.index;
    parts.push(
      <span key={at} {...stylex.props(fadeIn, styles.word)}>
        {word[0]}
      </span>
    );
  }
  return parts;
};

/** The words of one line, in whose voice they are, with what he marked in theirs. */
const Words = ({
  line,
  extra,
  streaming = false,
}: {
  line: InterviewLine;
  extra?: stylex.StyleXStyles;
  /** His line as he says it: its words come in smoothly. */
  streaming?: boolean;
}) => {
  const { t } = useLingui();
  const smooth = useSmoothWords(line.text, streaming);
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
        streaming && styles.coming,
        extra
      )}
    >
      {stephen ? (
        <FadingWords text={smooth} />
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

/** A line of theirs, in a bubble at the end; under a resting pointer it can be put right or removed. */
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

/** A line of the chat, his at the start, theirs at the end in a bubble. */
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
        <Words
          extra={styles.chatHisText}
          line={placed.line}
          streaming={placed.saying === true}
        />
        {placed.saying === true || placed.guide === true ? null : (
          <BinFor line={placed.line} onRemove={onRemove} who={who} />
        )}
      </div>
    );
  }
  return (
    <TheirChatLine line={placed.line} onEdit={onEdit} onRemove={onRemove} />
  );
};
