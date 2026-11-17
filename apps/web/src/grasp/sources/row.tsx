// SourceRow: one source in the list (list.tsx), the same shape for every kind: its mark, its title
// with its number beside it, one quiet line of where and when, and the part the answer used. It
// lights with its marker and the words it backs. A locked source shows a lock and says what it is;
// a gone one says it could not be opened, and why. Neither is a link.
"use client";

import * as stylex from "@stylexjs/stylex";

import { focus } from "../focus/focus";
import { Icon, Lock } from "../icons";
import type { SourcesValue } from "./context";
import { SourceTile } from "./mark";
import { accessOf, hasWords, kindOf, opens } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source } from "./types";

/** The quiet line: where it lives, when, how fresh, or why it cannot be opened. */
const Where = ({
  source,
  shared,
}: {
  source: Source;
  shared: SourcesValue;
}) => {
  const access = accessOf(source);
  const parts = [source.origin, source.when].filter(hasWords).join(" · ");
  if (access === "gone") {
    return (
      <span {...stylex.props(styles.where, styles.gone)}>
        {parts}. {shared.labels.gone}
        {hasWords(source.reason) ? `: ${source.reason}` : null}
      </span>
    );
  }
  return (
    <span {...stylex.props(styles.where)}>
      {parts}
      {hasWords(source.fresh) ? (
        <>
          {" · "}
          <span {...stylex.props(styles.fresh)}>{source.fresh}</span>
        </>
      ) : null}
      {access === "locked" ? ` · ${shared.labels.locked}` : null}
    </span>
  );
};

/** The part the answer used: the passage, or a record's fields. */
const Used = ({ source }: { source: Source }) => {
  if (accessOf(source) !== "open") {
    return null;
  }
  if (hasWords(source.quote)) {
    return <p {...stylex.props(styles.used)}>{source.quote}</p>;
  }
  if (source.fields !== undefined && source.fields.length > 0) {
    const words = source.fields
      .slice(0, 3)
      .map((field) =>
        typeof field.value === "string"
          ? `${field.key}: ${field.value}`
          : field.key
      )
      .join(" · ");
    return <p {...stylex.props(styles.used)}>{words}</p>;
  }
  return null;
};

/** A row's title that opens it: a link to its address, or a button that runs the page's `onOpen`. */
const Title = ({
  source,
  n,
  shared,
}: {
  source: Source;
  n: number;
  shared: SourcesValue;
}) => {
  const { setActive, onOpen } = shared;
  const events = {
    onFocus: () => {
      setActive(n, "focus");
    },
    onBlur: () => {
      setActive(null, "focus");
    },
    // The link still goes where it goes: the page hears of it too.
    onClick: () => {
      if (onOpen !== undefined) {
        onOpen(source, n - 1);
      }
    },
  };
  if (hasWords(source.href)) {
    return (
      <a
        href={source.href}
        target="_blank"
        rel="noreferrer"
        data-slot="source-title"
        {...events}
        {...stylex.props(styles.title, focus.words)}
      >
        <span aria-hidden="true" {...stylex.props(styles.stretch)} />
        {source.title}
      </a>
    );
  }
  return (
    <button
      type="button"
      data-slot="source-title"
      {...events}
      {...stylex.props(styles.title, styles.titleButton, focus.words)}
    >
      <span aria-hidden="true" {...stylex.props(styles.stretch)} />
      {source.title}
    </button>
  );
};

/** One source's row. */
export const SourceRow = ({
  source,
  n,
  shared,
}: {
  source: Source;
  n: number;
  shared: SourcesValue;
}) => {
  const { active, setActive, rowId } = shared;
  const live = opens(source, shared.onOpen);
  return (
    <li
      id={rowId(n)}
      data-slot="source-row"
      data-kind={kindOf(source)}
      data-active={active === n || undefined}
      onPointerEnter={() => {
        setActive(n, "hover");
      }}
      onPointerLeave={() => {
        setActive(null, "hover");
      }}
      // The row itself takes focus only when a marker sends it there and it holds no link (locked,
      // gone); it lights then by its own focus.
      tabIndex={-1}
      {...stylex.props(
        styles.row,
        active === n && styles.rowLit,
        styles.rowHeld,
        focus.inside
      )}
    >
      <span data-source-tile={n}>
        <SourceTile source={source} size="row" />
      </span>
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.titleLine)}>
          {live ? (
            <Title source={source} n={n} shared={shared} />
          ) : (
            <span
              data-slot="source-title"
              {...stylex.props(
                styles.title,
                accessOf(source) !== "open" && styles.titleQuiet
              )}
            >
              {source.title}
            </span>
          )}
          {accessOf(source) === "locked" ? (
            <span {...stylex.props(styles.lock)}>
              {/* A picture only: the quiet line under it says "You cannot open this", once. */}
              <Icon icon={Lock} />
            </span>
          ) : null}
          <span aria-hidden="true" {...stylex.props(styles.number)}>
            {n}
          </span>
        </span>
        <Where source={source} shared={shared} />
        <Used source={source} />
      </span>
    </li>
  );
};
