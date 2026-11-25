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
import {
  Arrow,
  arrowCell,
  arrowCells,
  between,
  bezier,
  easeInOut,
  frames,
  isStill,
  keysOf,
  wait,
} from "./pixel-cursor.tsx";
import type { Point } from "./pixel-cursor.tsx";

// The team step's message as a new email: a window with its title, who
// it is for, the message and, on its foot, what the step puts there (copy,
// the postmark). The first time the step opens, Stephen writes it: his
// pixel cursor, the documents step's visitors' own (pixel-cursor.tsx),
// comes in and the words stream in after a caret it follows, a key at a
// time, pausing at a comma and longer between paragraphs, and then it
// leaves. The field holds the whole message all along, so it is read,
// copied and sent whole while he writes; a press, a key or focus in it
// and he is done at once, the words theirs to change. Not again once
// written or changed, and never under reduced motion.

const styles = stylex.create({
  window: {
    display: "grid",
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
  // A window's three lights, as squares: pixels, as Stephen's cursor is.
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
    backgroundColor: colors.primary,
  },
  layer: {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
  },
  cursor: {
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    opacity: 0,
    color: colors.primary,
    willChange: "transform",
  },
  arrow: {
    display: "block",
    transformOrigin: "0 0",
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.16))",
  },
  label: {
    position: "absolute",
    insetBlockStart: 26,
    insetInlineStart: 16,
    filter: "drop-shadow(2px 2px 0 rgb(0 0 0 / 0.14))",
  },
  bubble: {
    display: "block",
    opacity: 0,
    transformOrigin: "0 0",
    paddingBlock: 4,
    paddingInline: 8,
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
  body: HTMLElement;
  typed: HTMLElement;
  caret: HTMLElement;
  rest: HTMLElement;
  cursor: HTMLElement;
  bubble: HTMLElement;
}

const partsIn = (body: HTMLElement): Parts | null => {
  const find = (name: string) => body.querySelector(`[data-part=${name}]`);
  const typed = find("typed");
  const caret = find("caret");
  const rest = find("rest");
  const cursor = find("cursor");
  const bubble = find("bubble");
  if (
    !(typed instanceof HTMLElement) ||
    !(caret instanceof HTMLElement) ||
    !(rest instanceof HTMLElement) ||
    !(cursor instanceof HTMLElement) ||
    !(bubble instanceof HTMLElement)
  ) {
    return null;
  }
  return { body, typed, caret, rest, cursor, bubble };
};

/** When each key of `keys` is down, in ms from the first: quick, a breath at a comma, longer at a full stop and between paragraphs. */
const timesOf = (keys: string[]): number[] => {
  const times: number[] = [];
  let total = 0;
  for (const [index, key] of keys.entries()) {
    const before = keys[index - 1] ?? "";
    let pause = between(9, 24);
    if (before === "\n" && key !== "\n") {
      pause += between(260, 420);
    } else if (/[.?!]/u.test(before) && key === " ") {
      pause += between(140, 240);
    } else if (before === "," && key === " ") {
      pause += between(60, 120);
    }
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
  const { typed, caret, rest, cursor, bubble } = parts;
  const keys = keysOf(text);
  typed.textContent = "";
  rest.textContent = text;
  /** Where the tip rests: just after the caret, low on its line. */
  const caretAt = (): Point => {
    const box = body.getBoundingClientRect();
    const mark = caret.getBoundingClientRect();
    return {
      x: mark.right - box.left + 3,
      y: mark.top - box.top + mark.height * 0.7,
    };
  };
  const phase = Math.random() * 6;
  // From over the window's title, near its end corner: he never leaves the window, so the page never scrolls sideways for him.
  let at: Point = {
    x: body.clientWidth - between(40, 90),
    y: -between(56, 72),
  };
  let calm = 0;
  const paint = () => {
    const now = performance.now();
    const x = at.x + Math.sin(now / 640 + phase) * 1.4 * calm;
    const y = at.y + Math.cos(now / 820 + phase) * 1.8 * calm;
    cursor.style.transform = `translate3d(${String(x)}px, ${String(y)}px, 0)`;
  };
  const glide = async (to: () => Point, ms: number, bend: number) => {
    const from = at;
    await frames(ms, signal, (t) => {
      const end = to();
      const dx = end.x - from.x;
      const dy = end.y - from.y;
      const one = {
        x: from.x + dx * 0.3 - dy * bend,
        y: from.y + dy * 0.3 + dx * bend,
      };
      const two = {
        x: from.x + dx * 0.75 - dy * bend * 0.4,
        y: from.y + dy * 0.75 + dx * bend * 0.4,
      };
      at = bezier(from, one, two, end, easeInOut(t));
      paint();
    });
  };
  paint();
  cursor.style.opacity = "1";
  // In from the window's title, to the start of the message.
  await glide(caretAt, between(800, 1000), between(-0.2, 0.2));
  calm = 1;
  bubble.animate(
    [
      { opacity: 0, transform: "scale(0.4)" },
      { opacity: 1, transform: "scale(1)" },
    ],
    {
      duration: 220,
      easing: "cubic-bezier(0.2, 0.9, 0.3, 1.25)",
      fill: "forwards",
    }
  );
  await frames(between(300, 450), signal, paint);
  // The words, a key at a time, the cursor a little behind the caret, as a hand follows its eye.
  const times = timesOf(keys);
  const total = times.at(-1) ?? 0;
  let count = 0;
  await frames(total, signal, (t) => {
    const now = t * total;
    const next = times.filter((time) => time <= now).length;
    if (next !== count) {
      count = next;
      typed.textContent = keys.slice(0, count).join("");
      rest.textContent = keys.slice(count).join("");
    }
    const target = caretAt();
    at = {
      x: at.x + (target.x - at.x) * 0.3,
      y: at.y + (target.y - at.y) * 0.3,
    };
    paint();
  });
  await wait(between(500, 700), signal);
  // Done: the label goes, and he drifts down toward the foot, fading as he goes.
  bubble.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.6)" }], {
    duration: 160,
    easing: "ease-in",
    fill: "forwards",
  });
  calm = 0;
  const away = {
    x: Math.min(body.clientWidth - 40, at.x + 120),
    y: body.clientHeight + 24,
  };
  const fade = cursor.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 700,
    delay: 300,
    easing: "ease-in",
    fill: "forwards",
  });
  await glide(() => away, 1000, between(-0.15, 0.15));
  fade.cancel();
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
            <span data-part="caret" {...stylex.props(styles.caret)} />
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
        {writing ? (
          <div aria-hidden="true" {...stylex.props(styles.layer)}>
            <div data-part="cursor" {...stylex.props(styles.cursor)}>
              <svg
                height={arrowCells.length * arrowCell}
                shapeRendering="crispEdges"
                width={10 * arrowCell}
                {...stylex.props(styles.arrow)}
              >
                <Arrow />
              </svg>
              <div {...stylex.props(styles.label)}>
                <span data-part="bubble" {...stylex.props(styles.bubble)}>
                  <span {...stylex.props(styles.name)}>Stephen</span>
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
      <div {...stylex.props(styles.foot)}>{foot}</div>
    </div>
  );
};
