// The compact look: a 28 or 32px button with the chosen language's flag and own name, at a steady
// width. Up to eight languages it opens the Dropdown menu (radio items: arrows, Home, End, type-ahead
// by the own name, Escape, the current one aria-checked); past eight a popup with a search and
// Suggested first (the list, a Listbox); on a phone, the same list in the Sheet.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import type { MenuRadioItemState } from "@ui-sdk/react/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { useEffect, useState } from "react";

import { DropdownMenu, DropdownMenuPanel, menuStyles } from "../dropdown-menu";
import { focus } from "../focus/focus";
import { ChevronDown, Icon, Tick } from "../icons";
import { Sheet, SheetBody, SheetPanel, SheetTitle } from "../sheet";
import { popup, px } from "../tokens/tokens.values";
import { OptionFlag, SteadyFace } from "./face";
import { LanguageList } from "./list";
import type { LanguageListProps } from "./list";
import { MANY, dirAttribute, secondNameOf } from "./options";
import type { LanguageOption } from "./options";
import { styles } from "./styles";

export interface CompactProps extends Omit<
  LanguageListProps,
  "frame" | "onChoose"
> {
  size: "sm" | "md";
  buttonLabel: string;
  onChoose: (code: string) => void;
}

// A phone: narrow, or a touch screen not much wider. The list opens in the Sheet there.
const PHONE = `(width < ${px.phone}px), (pointer: coarse) and (width < 768px)`;

const usePhone = () => {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const update = () => {
      setPhone(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);
  return phone;
};

const itemClass = (state: MenuRadioItemState) =>
  stylex.props(menuStyles.item, state.highlighted && menuStyles.highlighted)
    .className ?? "";

const Face = ({
  options,
  value,
  size,
}: {
  options: readonly LanguageOption[];
  value: string;
  size: "sm" | "md";
}) => (
  <>
    <SteadyFace options={options} value={value} size={size} />
    <span aria-hidden {...stylex.props(styles.chevron)}>
      <Icon icon={ChevronDown} />
    </span>
  </>
);

const Menu = ({
  options,
  value,
  onChoose,
  size,
  buttonLabel,
  words,
  secondNames,
}: CompactProps) => (
  <DropdownMenu>
    <MenuTrigger
      aria-label={buttonLabel}
      {...stylex.props(styles.trigger, styles[size], focus.ring)}
    >
      <Face options={options} value={value} size={size} />
    </MenuTrigger>
    <DropdownMenuPanel align="start" aria-label={words.label}>
      <MenuRadioGroup
        value={value}
        onValueChange={(next) => {
          onChoose(next);
        }}
      >
        {options.map((option) => {
          const second = secondNameOf(option, value, secondNames);
          return (
            <MenuRadioItem
              key={option.code}
              value={option.code}
              label={option.name}
              lang={option.code}
              closeOnSelect
              className={itemClass}
            >
              <OptionFlag option={option} size="md" />
              {/* The row keeps the menu's direction; the name its own. */}
              <span {...stylex.props(styles.menuName)}>
                <span dir={dirAttribute(option)}>{option.name}</span>
                {second === undefined ? null : (
                  <span
                    lang={option.secondName === undefined ? value : ""}
                    {...stylex.props(styles.menuSecond)}
                  >
                    {second}
                  </span>
                )}
              </span>
              <MenuItemIndicator {...stylex.props(menuStyles.tick)}>
                <Icon icon={Tick} />
              </MenuItemIndicator>
            </MenuRadioItem>
          );
        })}
      </MenuRadioGroup>
    </DropdownMenuPanel>
  </DropdownMenu>
);

const Many = ({ onChoose, size, buttonLabel, ...list }: CompactProps) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <PopoverTrigger
        aria-label={buttonLabel}
        {...stylex.props(styles.trigger, styles[size], focus.ring)}
      >
        <Face options={list.options} value={list.value} size={size} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={popup.menuGap}
        collisionPadding={popup.gutter}
        aria-label={list.words.label}
        {...stylex.props(
          menuStyles.panel,
          menuStyles.motion,
          styles.popupFrame
        )}
      >
        <LanguageList
          {...list}
          frame="popup"
          onChoose={(code) => {
            onChoose(code);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
};

const OnPhone = ({ onChoose, size, buttonLabel, ...list }: CompactProps) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={() => {
          setOpen(true);
        }}
        {...stylex.props(styles.trigger, styles[size], focus.ring)}
      >
        <Face options={list.options} value={list.value} size={size} />
      </button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
        }}
      >
        <SheetPanel>
          <SheetTitle>{list.words.label}</SheetTitle>
          <SheetBody>
            <LanguageList
              {...list}
              frame="sheet"
              onChoose={(code) => {
                onChoose(code);
                setOpen(false);
              }}
            />
          </SheetBody>
        </SheetPanel>
      </Sheet>
    </>
  );
};

/** The compact look: a menu for a few, a popup with search for many, the Sheet on a phone. */
export const Compact = (props: CompactProps) => {
  const phone = usePhone();
  if (phone) {
    return <OnPhone {...props} />;
  }
  if (props.options.length > MANY) {
    return <Many {...props} />;
  }
  return <Menu {...props} />;
};
