// The list of languages: rows with the flag, the own name, a quiet second name and a tick on the
// current one; past eight, a search on top and Suggested first. One part for the List look, the
// compact button's popup when there are many, and the Sheet on a phone. UI SDK's Listbox gives the
// keys (arrows, Home, End, type-ahead) and marks the current row aria-selected.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Listbox,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxItemIndicator,
  createListboxController,
} from "@ui-sdk/react/listbox";
import type { ListboxController } from "@ui-sdk/react/listbox";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { focus } from "../focus/focus";
import { Icon, Search, Tick } from "../icons";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../input-group";
import { OptionFlag } from "./face";
import {
  MANY,
  answers,
  dirAttribute,
  secondNameOf,
  suggestedOf,
} from "./options";
import type { LanguageOption } from "./options";
import { styles } from "./styles";
import type { LanguageSwitchWords } from "./words";

export interface LanguageListProps {
  options: readonly LanguageOption[];
  value: string;
  onChoose: (code: string) => void;
  words: LanguageSwitchWords;
  suggested: readonly string[] | undefined;
  secondNames: boolean;
  frame: "card" | "popup" | "sheet";
  helpTranslateHref: string | undefined;
  onHelpTranslate: (() => void) | undefined;
}

const Row = ({
  option,
  value,
  frame,
  secondNames,
}: {
  option: LanguageOption;
  value: string;
  frame: LanguageListProps["frame"];
  secondNames: boolean;
}) => {
  const second = secondNameOf(option, value, secondNames);
  return (
    <ListboxItem
      value={option.code}
      label={option.name}
      lang={option.code}
      {...stylex.props(
        styles.choice,
        frame === "sheet" && styles.clearOfSearch
      )}
    >
      {/* The row follows the list's direction, so every flag keeps one column; only the name takes
          its own direction (an RTL row once moved its flag to the far edge). */}
      <OptionFlag option={option} size="lg" />
      <span {...stylex.props(styles.names)}>
        <span dir={dirAttribute(option)} {...stylex.props(styles.ownName)}>
          {option.name}
        </span>
        {second === undefined ? null : (
          // The browser's second name is in the chosen language, not the row's; a caller's is in a
          // language the switch does not know, so it is not marked as the row's.
          // The line keeps the row's direction, so it starts under the name above it; only the words
          // inside take their own (dir="auto"), so a name in Arabic still reads right to left.
          <span
            lang={option.secondName === undefined ? value : ""}
            {...stylex.props(styles.secondName)}
          >
            <span dir="auto">{second}</span>
          </span>
        )}
      </span>
      <ListboxItemIndicator {...stylex.props(styles.tick)}>
        <Icon icon={Tick} />
      </ListboxItemIndicator>
    </ListboxItem>
  );
};

const HelpTranslate = ({
  href,
  onPress,
  words,
  card,
}: {
  href: string | undefined;
  onPress: (() => void) | undefined;
  words: LanguageSwitchWords;
  card: boolean;
}) => {
  if (href !== undefined) {
    return (
      <a
        href={href}
        {...stylex.props(
          styles.helpRow,
          card && styles.helpUnderCard,
          focus.ring
        )}
      >
        {words.helpTranslate}
      </a>
    );
  }
  if (onPress !== undefined) {
    return (
      <button
        type="button"
        onClick={onPress}
        {...stylex.props(
          styles.helpRow,
          card && styles.helpUnderCard,
          focus.ring
        )}
      >
        {words.helpTranslate}
      </button>
    );
  }
  return null;
};

const listFrame = (frame: LanguageListProps["frame"], many: boolean) => {
  if (frame === "card") {
    return [styles.listBox, many && styles.scrolls];
  }
  if (frame === "popup") {
    return styles.inPopup;
  }
  return styles.inSheet;
};

export const LanguageList = ({
  options,
  value,
  onChoose,
  words,
  suggested,
  secondNames,
  frame,
  helpTranslateHref,
  onHelpTranslate,
}: LanguageListProps) => {
  const [query, setQuery] = useState("");
  // oxlint-disable-next-line react/hook-use-state -- made once, never set
  const [controller] = useState<ListboxController>(() =>
    createListboxController()
  );
  const many = options.length > MANY;
  const shown = options.filter((option) => answers(option, query, value));
  const first = many && query === "" ? suggestedOf(options, suggested) : [];
  const rest =
    first.length > 0
      ? shown.filter((option) => !first.includes(option))
      : shown;
  const row = (option: LanguageOption) => (
    <Row
      key={option.code}
      option={option}
      value={value}
      frame={frame}
      secondNames={secondNames}
    />
  );

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      controller.focus();
    }
    const top = first[0] ?? shown[0];
    if (event.key === "Enter" && top !== undefined) {
      event.preventDefault();
      onChoose(top.code);
    }
  };

  return (
    <div
      {...stylex.props(frame === "popup" ? styles.popupList : styles.rootList)}
    >
      {many ? (
        <div {...stylex.props(frame === "sheet" && styles.stickySearch)}>
          <InputGroup>
            <InputGroupText icon={Search} />
            <InputGroupInput
              type="search"
              aria-label={words.search}
              placeholder={words.search}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={onSearchKey}
            />
            <InputGroupClear label={words.clearSearch} />
          </InputGroup>
        </div>
      ) : null}
      {shown.length === 0 ? (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        <p role="status" {...stylex.props(styles.empty)}>
          {words.empty}
        </p>
      ) : (
        <Listbox
          aria-label={words.label}
          controller={controller}
          activation="manual"
          // In a sheet the sheet scrolls: focus brings a row into view on its own, clear of the search.
          keepInView={frame !== "sheet"}
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") {
              onChoose(next);
            }
          }}
          {...stylex.props(
            listFrame(frame, many),
            focus.within,
            frame === "popup" && styles.ringInside
          )}
        >
          {/* At the head, while rows lie above it under the search (a popup, or a card that scrolls). */}
          {frame === "sheet" ? null : (
            <span
              aria-hidden="true"
              data-slot="language-switch-more-above"
              {...stylex.props(styles.moreAbove)}
            />
          )}
          {first.length > 0 ? (
            <>
              <ListboxGroup>
                <ListboxGroupLabel {...stylex.props(styles.groupLabel)}>
                  {words.suggested}
                </ListboxGroupLabel>
                {first.map(row)}
              </ListboxGroup>
              <ListboxGroup>
                <ListboxGroupLabel {...stylex.props(styles.groupLabel)}>
                  {words.all}
                </ListboxGroupLabel>
                {rest.map(row)}
              </ListboxGroup>
            </>
          ) : (
            shown.map(row)
          )}
          {/* In a popup, or a card that scrolls, the foot fades while more lies below. A sheet
              scrolls as a whole and needs none. */}
          {frame === "sheet" ? null : (
            <span
              aria-hidden="true"
              data-slot="language-switch-more"
              {...stylex.props(styles.more)}
            />
          )}
        </Listbox>
      )}
      <HelpTranslate
        href={helpTranslateHref}
        onPress={onHelpTranslate}
        words={words}
        card={frame === "card"}
      />
    </div>
  );
};
