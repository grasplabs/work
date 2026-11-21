// The small parts every look shares: an option's flag (or its code in a flag's shape), its own name
// in its own language, and the button's face, which keeps a steady width.
"use client";

import * as stylex from "@stylexjs/stylex";

import { Flag } from "../flags";
import type { FlagSize } from "../flags";
import { dirAttribute, primaryOf } from "./options";
import type { LanguageOption } from "./options";
import { styles } from "./styles";

/** The region's flag the caller named, or the code tile for a language with no fair flag. */
export const OptionFlag = ({
  option,
  size,
}: {
  option: LanguageOption;
  size: FlagSize;
}) =>
  option.flag === undefined ? (
    <Flag
      code={option.flagCode ?? primaryOf(option.code).toUpperCase()}
      size={size}
    />
  ) : (
    <Flag flag={option.flag} size={size} />
  );

/** The language's own name, marked with its language and direction so it is said and set right. */
export const OwnName = ({
  option,
  style,
}: {
  option: LanguageOption;
  style?: stylex.StyleXStyles;
}) => (
  <span lang={option.code} dir={dirAttribute(option)} {...stylex.props(style)}>
    {option.name}
  </span>
);

/**
 * The button's flag and name. Every option is stacked in one cell, only the chosen one seen, so the
 * button is as wide as the widest and nothing moves when the choice changes; the change itself is
 * the Button's blur and fade.
 */
export const SteadyFace = ({
  options,
  value,
  size,
}: {
  options: readonly LanguageOption[];
  value: string;
  size: "sm" | "md";
}) => (
  <span {...stylex.props(styles.stack)}>
    {options.map((option) => (
      <span
        key={option.code}
        aria-hidden={option.code === value ? undefined : true}
        data-language-face={option.code === value ? "shown" : undefined}
        {...stylex.props(
          styles.layer,
          option.code === value ? styles.shown : styles.gone
        )}
      >
        <OptionFlag option={option} size={size === "sm" ? "sm" : "md"} />
        <OwnName option={option} />
      </span>
    ))}
  </span>
);
