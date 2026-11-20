// One person in a picker's list, as Owner picker and Share access's picker both draw them: their
// avatar (or a team's or project's face), their name with the letters typed marked, a muted line
// under it (a role, an email, "Has access") that a screen reader reads after the name, and the
// tick when chosen. On UI SDK's Combobox, drawn from the list Combobox, Select and these pickers
// share (list.styles.ts). Internal: the pickers' own part, not exported from Combobox.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  ComboboxItem,
  ComboboxItemIcon,
  ComboboxItemIndicator,
  ComboboxItemText,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxItemState,
  ComboboxItemTextState,
} from "@ui-sdk/react/combobox";
import type { ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { Icon, Tick } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import { listStyles } from "./list.styles";

/** Every prop a PersonOption takes. */
export interface PersonOptionProps {
  /** What choosing it gives the picker: the person's id. */
  value: string;
  /** Their name: the row's words and its name for a screen reader. */
  name: string;
  /** Their picture. Without it, their initials. */
  src?: string;
  /** In place of the avatar: a team's or a project's face. */
  face?: ReactNode;
  /** The muted line under the name, read after it. */
  line?: string;
  /** The line's id, unique in the page, so the row can be described by it. */
  lineId: string;
  /** More words a search also finds (their line). */
  keywords?: string[];
  /** Offered but not to be chosen (someone who already has access). */
  disabled?: boolean;
}

const styles = stylex.create({
  row: { paddingBlock: grasp.space1 },
  icon: { display: "flex", flexShrink: 0 },
  person: { display: "grid", minWidth: 0, flexGrow: 1 },
  line: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    // In forced colours it takes the highlighted row's own colour.
    color: { default: grasp.muted, [media.forced]: "inherit" },
    overflowWrap: "anywhere",
  },
});

/** A name in the list, the letters the typed words matched a step heavier. */
export const MatchedWords = () => (
  <ComboboxItemText {...stylex.props(listStyles.itemWords)}>
    {(state: ComboboxItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} {...stylex.props(listStyles.mark)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </ComboboxItemText>
);

/** One person in a picker's list: their face, their name and line, the tick when chosen. */
export const PersonOption = ({
  value,
  name,
  src,
  face,
  line,
  lineId,
  keywords,
  disabled,
}: PersonOptionProps) => {
  const lined = line !== undefined && line !== "";
  return (
    <ComboboxItem
      value={value}
      label={name}
      keywords={keywords}
      disabled={disabled}
      // Its name is the person's; their line is read after it, not run into it.
      aria-label={name}
      aria-describedby={lined ? lineId : undefined}
      className={(state: ComboboxItemState) =>
        stylex.props(
          listStyles.item,
          styles.row,
          state.highlighted && listStyles.itemHighlighted,
          state.disabled && listStyles.itemDisabled
        ).className
      }
    >
      <ComboboxItemIcon {...stylex.props(styles.icon)}>
        {face ?? (
          <Avatar name={name} size="xs" decorative>
            <AvatarImage src={src} />
            <AvatarFallback />
          </Avatar>
        )}
      </ComboboxItemIcon>
      <span {...stylex.props(styles.person)}>
        <MatchedWords />
        {lined && (
          <span id={lineId} {...stylex.props(styles.line)}>
            {line}
          </span>
        )}
      </span>
      <ComboboxItemIndicator {...stylex.props(listStyles.tick)}>
        <Icon icon={Tick} />
      </ComboboxItemIndicator>
    </ComboboxItem>
  );
};
