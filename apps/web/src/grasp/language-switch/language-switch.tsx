// LanguageSwitch: how a person chooses the language of a product. It chooses; it does not
// translate: the product keeps the value and reloads its words. Three looks from one set of options:
//
//   compact  a 32 or 28px button, the chosen flag and own name at a steady width, opening a menu
//            (up to eight), a popup with search and Suggested (past eight), or the Sheet on a phone
//   list     rows for a settings page: flag, own name, a quiet second name, a tick; search on top
//            and Suggested first past eight; an optional "Help translate" row
//   pair     exactly two languages on a segmented switch with flags, the pill moving
//
//   <LanguageSwitch
//     options={[{ code: "en", name: "English", flag: GB }, { code: "nl", name: "Nederlands", flag: NL }]}
//     value={language}
//     onValueChange={setLanguage}
//   />
//
// Every language is shown by its own name and carries its `lang` (and `dir="rtl"` where it runs right
// to left), so a screen reader says it in that language. A flag stands for a region: the caller says
// which one stands for each language, and one with no fair flag shows its code in a flag's shape.
// Every visible word of the switch's own is a prop with an English default. A caller may set layout only.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useState, useSyncExternalStore } from "react";

import type { LayoutStyle } from "../layout/layout";
import { Compact } from "./compact";
import { LanguageList } from "./list";
import { findOption } from "./options";
import type { LanguageOption } from "./options";
import { Pair } from "./pair";
import { styles } from "./styles";
import { defaultButtonLabel, defaultWords } from "./words";
import type { LanguageSwitchWords } from "./words";

// False on the server and while hydrating, true after: a store that never changes.
const never = () => () => {
  // Nothing to stop listening to.
};
const inBrowser = () => true;
const onServer = () => false;

/** What a caller may style: where the switch sits. Never its look. */
export type LanguageSwitchLayoutStyle = LayoutStyle;

/** Every prop a LanguageSwitch takes. */
export interface LanguageSwitchProps {
  /** The languages, each by its code, its own name and the flag of the region it stands for. */
  options: readonly LanguageOption[];
  /** The chosen language's code. Pass it with `onValueChange` to keep the choice yourself. */
  value?: string;
  /** The language chosen when the page loads, when `value` is not given. Left out, the first. */
  defaultValue?: string;
  /** Runs with the code a person chose. */
  onValueChange?: (code: string) => void;
  /**
   * `compact` in a header or footer; `list` on a settings page; `pair` for exactly two.
   * @default "compact"
   */
  look?: "compact" | "list" | "pair";
  /**
   * The button's or the pair's height: `md` 32px, `sm` 28px.
   * @default "md"
   */
  size?: "sm" | "md";
  /** Codes to show first under Suggested, past eight languages: `navigator.languages`, say. */
  suggested?: readonly string[];
  /**
   * Show the browser's own name for each language, in the chosen one, as a quiet second name.
   * @default true
   */
  secondNames?: boolean;
  /** Where "Help translate" leads: shows the row in the list. */
  helpTranslateHref?: string;
  /** What "Help translate" does, when it is not a link: shows the row in the list. */
  onHelpTranslate?: () => void;
  /**
   * Its name: the menu's, the list's and the sheet's title, and said with the button.
   * @default "Language"
   */
  label?: string;
  /**
   * The search field's placeholder and name.
   * @default "Search languages"
   */
  searchLabel?: string;
  /**
   * The search field's clear button.
   * @default "Clear search"
   */
  clearSearchLabel?: string;
  /**
   * The group of suggested languages.
   * @default "Suggested"
   */
  suggestedLabel?: string;
  /**
   * The group of the other languages, under Suggested.
   * @default "All languages"
   */
  allLabel?: string;
  /**
   * When a search finds nothing.
   * @default "No language found"
   */
  emptyLabel?: string;
  /**
   * The quiet row that asks for help with a translation.
   * @default "Help translate"
   */
  helpTranslateLabel?: string;
  /**
   * The button's name, from `label` and the chosen language's own name.
   * @default (label, current) => `${label}, ${current}`
   */
  buttonLabel?: (label: string, current: string) => string;
  /** @deprecated Use `layout`. */
  style?: LanguageSwitchLayoutStyle;
  /** Layout only: where it sits. */
  layout?: LanguageSwitchLayoutStyle;
}

export const LanguageSwitch = ({
  options,
  value,
  defaultValue,
  onValueChange,
  look = "compact",
  size = "md",
  suggested,
  secondNames = true,
  helpTranslateHref,
  onHelpTranslate,
  label = defaultWords.label,
  searchLabel = defaultWords.search,
  clearSearchLabel = defaultWords.clearSearch,
  suggestedLabel = defaultWords.suggested,
  allLabel = defaultWords.all,
  emptyLabel = defaultWords.empty,
  helpTranslateLabel = defaultWords.helpTranslate,
  buttonLabel = defaultButtonLabel,
  style: styleProp,
  layout,
}: LanguageSwitchProps) => {
  const [own, setOwn] = useState(defaultValue ?? options[0]?.code ?? "");
  const current = value ?? own;
  // The browser's second names differ from the server's (each has its own ICU), so they appear once
  // the page is in the browser: the server and the first render in the browser say the same.
  const hydrated = useSyncExternalStore(never, inBrowser, onServer);
  const choose = (code: string) => {
    if (code === current) {
      return;
    }
    setOwn(code);
    onValueChange?.(code);
  };
  const words: LanguageSwitchWords = {
    label,
    search: searchLabel,
    clearSearch: clearSearchLabel,
    suggested: suggestedLabel,
    all: allLabel,
    empty: emptyLabel,
    helpTranslate: helpTranslateLabel,
  };
  const shared = {
    options,
    value: current,
    onChoose: choose,
    words,
    suggested,
    secondNames: secondNames && hydrated,
    helpTranslateHref,
    onHelpTranslate,
  };

  const body = () => {
    if (look === "pair") {
      return (
        <Pair
          options={options}
          value={current}
          onChoose={choose}
          size={size}
          label={label}
        />
      );
    }
    if (look === "list") {
      return <LanguageList {...shared} frame="card" />;
    }
    const chosen = findOption(options, current);
    return (
      <Compact
        {...shared}
        size={size}
        buttonLabel={buttonLabel(label, chosen?.name ?? current)}
      />
    );
  };

  return (
    <div
      data-language-switch={look}
      {...stylex.props(
        look === "list" ? styles.rootList : styles.root,
        layout ?? styleProp
      )}
    >
      {body()}
    </div>
  );
};
