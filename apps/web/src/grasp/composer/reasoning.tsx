// ComposerReasoning: how hard the agent thinks, as a quiet control beside the model in a
// composer's footer (composer.tsx), after Capy's. It shows the current level's word and opens a
// small menu: the levels as one choice, then, under a hairline, modes as switches (Fast). Built
// from Grasp's Dropdown menu parts, opened from the footer's quiet control.
//
//   <ComposerReasoning levels={levels} value={level} onValueChange={setLevel}
//     modes={[{ value: "fast", label: "Fast" }]} modesOn={on} onModesChange={setOn} />
//
// Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { MenuTrigger } from "@ui-sdk/react/menu";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuPanel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../dropdown-menu";
import { focus } from "../focus/focus";
import { ChevronDown, Icon } from "../icons";
import { useComposerDisabled } from "./context";
import { controlStyles } from "./control";

/** One level or mode. */
export interface ComposerReasoningOption {
  /** What the change handlers receive. */
  value: string;
  /** Its word, one a person who is not an engineer understands ("Thorough"). */
  label: string;
}

/** Every prop a ComposerReasoning takes. */
export interface ComposerReasoningProps {
  /** The levels, from the least effort to the most. */
  levels: ComposerReasoningOption[];
  /** The chosen level's `value`. */
  value: string;
  /** Called with the level chosen. */
  onValueChange: (value: string) => void;
  /** Modes that can each be on or off, such as Fast. */
  modes?: ComposerReasoningOption[];
  /** The `value`s of the modes that are on. */
  modesOn?: string[];
  /** Called with the modes that are on after a change. */
  onModesChange?: (on: string[]) => void;
  /**
   * The control's name for a screen reader, and the levels' group name in the menu.
   * @default "Reasoning"
   */
  label?: string;
  /**
   * The modes' group name in the menu.
   * @default "Modes"
   */
  modesLabel?: string;
}

const noModes: ComposerReasoningOption[] = [];
const noModesOn: string[] = [];

/** How hard the agent thinks: a word in the footer and a small menu of levels and modes. */
export const ComposerReasoning = ({
  levels,
  value,
  onValueChange,
  modes = noModes,
  modesOn = noModesOn,
  onModesChange,
  label = "Reasoning",
  modesLabel = "Modes",
}: ComposerReasoningProps) => {
  const disabled = useComposerDisabled();
  const current = levels.find((level) => level.value === value);
  return (
    <DropdownMenu>
      <MenuTrigger
        disabled={disabled}
        aria-label={`${label}: ${current?.label ?? ""}`}
        render={(props: Record<string, unknown>) => (
          <button
            {...props}
            type="button"
            data-slot="composer-reasoning"
            {...stylex.props(
              controlStyles.control,
              controlStyles.foldLast,
              focus.ring
            )}
          >
            <span aria-hidden="true" {...stylex.props(controlStyles.reach)} />
            <span key={value} {...stylex.props(controlStyles.value)}>
              <span {...stylex.props(controlStyles.words)}>
                {current?.label}
              </span>
            </span>
            <Icon icon={ChevronDown} />
          </button>
        )}
      />
      <DropdownMenuPanel side="top" align="start">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next !== "") {
                onValueChange(next);
              }
            }}
          >
            {levels.map((level) => (
              <DropdownMenuRadioItem key={level.value} value={level.value}>
                {level.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {modes.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{modesLabel}</DropdownMenuLabel>
              {modes.map((mode) => (
                <DropdownMenuCheckboxItem
                  key={mode.value}
                  checked={modesOn.includes(mode.value)}
                  onCheckedChange={(checked) =>
                    onModesChange?.(
                      checked
                        ? [...modesOn, mode.value]
                        : modesOn.filter((on) => on !== mode.value)
                    )
                  }
                >
                  {mode.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuPanel>
    </DropdownMenu>
  );
};
