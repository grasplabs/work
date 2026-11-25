import {
  colors,
  font,
  radius,
  shadow,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { pixelCursor } from "./pixel-cursor.stylex.ts";
import { between, frames, isStill } from "./pixel-cursor.tsx";

// The team step's message as a new email: a window with its title, who
// it is for, the message and, on its foot, what the step puts there (copy,
// the postmark). The first time the step opens, Stephen writes it: his
// caret carries his name on a pixel flag hanging from it, as a collaborator's does in a
// shared document (its stepped corners the documents step's visitors'
// labels', pixel-cursor.stylex.ts), and the words stream in a word at a
// time, each fading in, pausing at a comma and longer between paragraphs;
// then the flag folds away. The field holds the whole message all along, so it is read,
// copied and sent whole while he writes; a press, a key or focus in it
// and he is done at once, the words theirs to change. Not again once
// written or changed, and never under reduced motion.

const styles = stylex.create({
  window: {
    display: "grid",
    // His flag lies over the whole window, and nothing outside it.
    isolation: "isolate",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: colors.border,
      ":focus-within": colors.inputBorderFocus,
    },
    borderRadius: radius.xl,
    boxShadow: shadow.md,
    transitionProperty: "border-color",
    transitionDuration: "150ms",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: space[3],
    paddingBlock: space[2],
    paddingInline: space[4],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  // A window's three lights, as squares: pixels, as Stephen's flag is.
  lights: { display: "flex", gap: 6 },
  light: {
    width: 8,
    height: 8,
    backgroundColor: colors.border,
  },
  to: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    paddingBlock: space[2],
    paddingInline: space[4],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  toLabel: { color: colors.mutedForeground },
  who: {
    paddingBlock: 2,
    paddingInline: space[2],
    borderRadius: radius.md,
    backgroundColor: colors.muted,
    color: colors.foreground,
    fontWeight: font.weightMedium,
  },
  // The message: the field and a copy of its words under it, in one cell, so the field is as tall as its words.
  body: {
    position: "relative",
    display: "grid",
  },
  words: {
    gridArea: "1 / 1",
    margin: 0,
    paddingBlock: space[4],
    paddingInline: space[4],
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    letterSpacing: "normal",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    color: colors.foreground,
  },
  copy: { visibility: "hidden" },
  field: {
    resize: "none",
    overflow: "hidden",
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    caretColor: colors.primary,
  },
  // While he writes, the field's own words are there but unseen: the copy shows how far he is.
  writing: { color: "transparent", caretColor: "transparent" },
  rest: { visibility: "hidden" },
  caret: {
    display: "inline-block",
    width: 2,
    height: "1.15em",
    marginInlineStart: 1,
    marginInlineEnd: -3,
    verticalAlign: "-0.2em",
    position: "relative",
    color: colors.primary,
    backgroundColor: "currentColor",
  },
  // His name on a little flag hanging from the caret, as a collaborator's is in a shared document: under it, where
  // nothing is written yet, so it never hides a word.
  label: {
    position: "absolute",
    zIndex: 2,
    insetBlockStart: "100%",
    insetInlineStart: -1,
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.12))",
  },
  bubble: {
    display: "block",
    opacity: 0,
    transformOrigin: "0 0",
    paddingBlock: 2,
    paddingInline: 6,
    whiteSpace: "nowrap",
    backgroundColor: "currentColor",
    clipPath: pixelCursor.steppedCorners,
  },
  name: {
    color: colors.primaryForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
  foot: {
    paddingBlock: space[3],
    paddingInline: space[4],
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
});

/** Written once on this visit to the setup: back on the step, the message is simply there. */
let written = false;

/** What his writing moves, found by their names. */
interface Parts {
  typed: HTMLElement;
  rest: HTMLElement;
  bubble: HTMLElement;
}

const partsIn = (body: HTMLElement): Parts | null => {
  const find = (name: string) => body.querySelector(`[data-part=${name}]`);
  const typed = find("typed");
  const rest = find("rest");
  const bubble = find("bubble");
  if (
    !(typed instanceof HTMLElement) ||
    !(rest instanceof HTMLElement) ||
    !(bubble instanceof HTMLElement)
  ) {
    return null;
  }
  return { typed, rest, bubble };
};

/** The message in the pieces it streams in: each word with the spaces or lines before it, so the caret stands right after the word. */
const piecesOf = (text: string): string[] => text.match(/\s*\S+|\s+/gu) ?? [];

/** When each piece of `pieces` appears, in ms from the first: a steady pace, a breath at a comma, longer at a full stop and between paragraphs. */
const timesOf = (pieces: string[]): number[] => {
  const times: number[] = [];
  let total = 0;
  for (const [index, piece] of pieces.entries()) {
    const before = pieces[index - 1] ?? "";
    let pause = between(65, 105);
    if (piece.includes("\n\n")) {
      pause += between(350, 480);
    } else if (/[.?!]$/u.test(before)) {
      pause += between(180, 260);
    } else if (before.endsWith(",")) {
      pause += between(80, 130);
    }
    // A long word takes a little longer.
    pause += Math.min(50, piece.trim().length * 4);
    total += pause;
    times.push(total);
  }
  return times;
};

/** Stephen writes `text` into the message in `body`, until it is written or `signal` stops him. */
const write = async (
  body: HTMLElement,
  text: string,
  signal: AbortSignal
): Promise<void> => {
  const parts = partsIn(body);
  if (parts === null) {
    return;
  }
  const { typed, rest, bubble } = parts;
  const pieces = piecesOf(text);
  typed.textContent = "";
  rest.textContent = text;
  bubble.animate(
    [
      { opacity: 0, transform: "scale(0.5)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      duration: 240,
      easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)",
      fill: "forwards",
    }
  );
  await frames(between(350, 450), signal, () => {
    // The flag opens before the first word.
  });
  // The words, one at a time, each fading in.
  const times = timesOf(pieces);
  const total = times.at(-1) ?? 0;
  let count = 0;
  await frames(total, signal, (t) => {
    const next = times.filter((time) => time <= t * total).length;
    while (count < next) {
      const word = document.createElement("span");
      word.textContent = pieces[count] ?? "";
      typed.append(word);
      word.animate(
        [
          { opacity: 0, filter: "blur(2px)" },
          { opacity: 1, filter: "blur(0)" },
        ],
        { duration: 260, easing: "ease-out" }
      );
      count += 1;
      rest.textContent = pieces.slice(count).join("");
    }
  });
  await frames(between(500, 650), signal, () => {
    // A last look at the words before the flag folds.
  });
  // Done: his flag folds away.
  await bubble.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.6)" },
    ],
    { duration: 220, easing: "ease-in", fill: "forwards" }
  ).finished;
};

/** Why the writing stopped when the window itself went (or React tried its effect twice): nobody to tell. */
const gone = "gone";

/** Writes the message in `body`, then calls `done`; stopped, it calls it too, unless the window went. The returned controller stops him. */
const writeThen = (
  body: HTMLElement,
  text: string,
  done: () => void
): AbortController => {
  const stopping = new AbortController();
  const run = async () => {
    try {
      await write(body, text, stopping.signal);
    } catch {
      // Stopped: the message is theirs now.
    }
    if (stopping.signal.reason !== gone) {
      done();
    }
  };
  void run();
  return stopping;
};

export const MessageCompose = ({
  value,
  onValueChange,
  to,
  changed,
  foot,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Who it is for, as the To line shows it. */
  to: string;
  /** The admin changed the message before: it is theirs, nobody writes it again. */
  changed: boolean;
  /** What goes on the window's foot: copying it, the postmark. */
  foot: ReactNode;
}) => {
  const { t } = useLingui();
  const [writing, setWriting] = useState(
    () => !written && !changed && !isStill()
  );
  const body = useRef<HTMLDivElement>(null);
  const stopper = useRef<AbortController | null>(null);
  const text = useRef(value);
  useEffect(() => {
    const element = body.current;
    if (!writing || element === null) {
      return () => {
        // Nothing being written.
      };
    }
    written = true;
    const stopping = writeThen(element, text.current, () => {
      setWriting(false);
    });
    stopper.current = stopping;
    return () => {
      stopping.abort(gone);
    };
  }, [writing]);
  const stop = () => {
    stopper.current?.abort();
  };
  return (
    <div {...stylex.props(styles.window)}>
      <div aria-hidden="true" {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.lights)}>
          <span {...stylex.props(styles.light)} />
          <span {...stylex.props(styles.light)} />
          <span {...stylex.props(styles.light)} />
        </span>
        {t`New message`}
      </div>
      <div {...stylex.props(styles.to)}>
        <span {...stylex.props(styles.toLabel)}>
          {t({ message: "To", context: "an email's recipients" })}
        </span>
        <span {...stylex.props(styles.who)}>{to}</span>
      </div>
      <div ref={body} {...stylex.props(styles.body)}>
        {writing ? (
          <div aria-hidden="true" key="writing" {...stylex.props(styles.words)}>
            <span data-part="typed" />
            <span data-part="caret" {...stylex.props(styles.caret)}>
              <span {...stylex.props(styles.label)}>
                <span data-part="bubble" {...stylex.props(styles.bubble)}>
                  <span {...stylex.props(styles.name)}>Stephen</span>
                </span>
              </span>
            </span>
            <span data-part="rest" {...stylex.props(styles.rest)} />
            {"\n"}
          </div>
        ) : (
          <div
            aria-hidden="true"
            key="still"
            {...stylex.props(styles.words, styles.copy)}
          >
            {value}
            {"\n"}
          </div>
        )}
        <textarea
          aria-label={t`The message`}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
          onFocus={stop}
          onKeyDown={stop}
          onPointerDown={stop}
          value={value}
          {...stylex.props(
            styles.words,
            styles.field,
            writing && styles.writing
          )}
        />
      </div>
      <div {...stylex.props(styles.foot)}>{foot}</div>
    </div>
  );
};
