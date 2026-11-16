// Key and value rows: facts about one thing, each a quiet name over its value, as the Grasp product
// shows an account or a workspace's details. Stacked, the name stands above the value; side by side,
// the value stands at the end of the row and drops under the name when the row is too narrow. A
// value can be copied, and an id can be set in the mono face.
//
//   <KeyValueList items={[
//     { key: "Owner", value: "Anna de Vries" },
//     { key: "User ID", value: "usr_4f81c2", mono: true, copy: true },
//   ]} />
//
// It is a description list, so a screen reader hears each name with its value. Every value is a
// token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { CopyButton } from "../button/copy";
import { grasp } from "../tokens/tokens.stylex";

type Layout = string | number | null;

/** What a caller may style: where it sits and how wide it is. */
export type KeyValueLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  width?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginInline?: Layout;
}>;

/** One fact: its name and its value. */
export interface KeyValueItem {
  /** The name, in a few words ("Owner", "Last active"). */
  key: string;
  /** The value, as words or a node. */
  value: ReactNode;
  /** Set in the mono face, for ids, keys and codes. */
  mono?: boolean;
  /** A button at the end that copies it: `true` copies the value's words, a string copies that. */
  copy?: boolean | string;
}

/** Every prop a KeyValueList takes. */
export interface KeyValueListProps {
  /** The facts, in order. */
  items: readonly KeyValueItem[];
  /**
   * `stacked` puts each name above its value; `inline` puts the value at the end of the row, for a
   * short list in a small space.
   * @default "stacked"
   */
  layout?: "stacked" | "inline";
  /**
   * A line between the rows, for a list that stands on its own.
   * @default false
   */
  divided?: boolean;
  /**
   * What a copy button says: its name, from the fact's name, and what it says once pressed.
   * @default { copy: (name) => `Copy ${name}`, copied: "Copied", failed: "Could not copy" }
   */
  labels?: Partial<KeyValueLabels>;
  /** Layout only: where it sits and how wide it is. */
  style?: KeyValueLayoutStyle;
}

/** The words a copy button says, so the product can say them in its own language. */
export interface KeyValueLabels {
  /** The button's name, from the fact's name ("Copy owner"). */
  copy: (name: string) => string;
  /** What it says once the value is copied. */
  copied: string;
  /** What it says when it could not copy. */
  failed: string;
}

/** Its words in English: replace any of them through `labels`. */
const englishLabels: KeyValueLabels = {
  copy: (name) => `Copy ${name.toLowerCase()}`,
  copied: "Copied",
  failed: "Could not copy",
};

const styles = stylex.create({
  list: {
    display: "grid",
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
  },
  spaced: {
    rowGap: grasp.space4,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  rowDivided: {
    paddingBlock: grasp.space3,
    boxShadow: {
      default: `inset 0 -1px 0 ${grasp.line}`,
      ":last-child": "none",
    },
  },
  pair: {
    flexGrow: 1,
    minWidth: 0,
  },
  // Side by side: the value at the end, and under the name when the row is too narrow for both.
  pairInline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space1,
  },
  key: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  value: {
    margin: 0,
    marginBlockStart: grasp.space1,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  valueInline: {
    marginBlockStart: 0,
    textAlign: "end",
  },
  mono: {
    fontFamily: grasp.fontMono,
    fontSize: grasp.textXs,
  },
});

/** The copy button at the end of a row: it says Copied, or that it could not. */
const CopyValue = ({
  name,
  text,
  labels,
}: {
  name: string;
  text: string;
  labels: KeyValueLabels;
}) => (
  <CopyButton
    text={text}
    label={labels.copy(name)}
    copiedLabel={labels.copied}
    failedLabel={labels.failed}
  />
);

/** The words of a value, for copying: a string or number as it is, anything else not at all. */
const wordsOf = (value: ReactNode) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** What a row's copy button copies: its own text, its value's words, or nothing. */
const copyText = (copy: string | boolean | undefined, value: ReactNode) => {
  if (typeof copy === "string") {
    return copy;
  }
  return copy === true ? wordsOf(value) : "";
};

export const KeyValueList = ({
  items,
  layout = "stacked",
  divided = false,
  labels: given,
  style,
}: KeyValueListProps) => {
  const labels = { ...englishLabels, ...given };
  const inline = layout === "inline";
  return (
    <dl
      data-slot="key-value"
      data-layout={layout}
      {...stylex.props(styles.list, !divided && styles.spaced, style)}
    >
      {items.map((item) => {
        const text = copyText(item.copy, item.value);
        return (
          <div
            key={item.key}
            {...stylex.props(styles.row, divided && styles.rowDivided)}
          >
            <div {...stylex.props(styles.pair, inline && styles.pairInline)}>
              <dt {...stylex.props(styles.key)}>{item.key}</dt>
              <dd
                {...stylex.props(
                  styles.value,
                  inline && styles.valueInline,
                  item.mono === true && styles.mono
                )}
              >
                {item.value}
              </dd>
            </div>
            {text ? (
              <CopyValue name={item.key} text={text} labels={labels} />
            ) : null}
          </div>
        );
      })}
    </dl>
  );
};
