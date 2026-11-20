"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { BarActions, BarClose } from "../bar-actions/bar-actions";
import { Button } from "../button";
import { Edit, Expand } from "../icons";
import { useWords, withGiven } from "../words/words";
import { styles } from "./styles";
import { askBarWords } from "./words";
import type { AskBarWords } from "./words";

/** Every prop an AskPanelHead takes. */
export interface AskPanelHeadProps {
  /** The conversation's name, on one line; cut with an ellipsis when it is longer. */
  title?: string;
  /**
   * What the head says before the conversation has a name.
   * @default "New chat"
   */
  titleFallback?: string;
  /** Starts a new conversation. */
  onNew: () => void;
  /**
   * The new chat button's name.
   * @default "New chat"
   */
  newLabel?: string;
  /** Turns the chat between beside the page and over the whole page. Without it, there is no such button. */
  onExpand?: () => void;
  /**
   * The chat lies over the whole page: the expand button docks it again.
   * @default false
   */
  expanded?: boolean;
  /**
   * The expand button's name while the chat is beside the page.
   * @default "Full screen"
   */
  expandLabel?: string;
  /**
   * Its name while the chat lies over the page.
   * @default "Dock beside the page"
   */
  dockLabel?: string;
  /** More buttons, before close: ghost, small, icon only (a list of chats, say). */
  actions?: ReactNode;
  /** Closes the chat. */
  onClose: () => void;
  /**
   * The close button's name.
   * @default "Close the chat"
   */
  closeLabel?: string;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ close: "Close the help" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<AskBarWords>;
}

/** The panel's head: its name, new chat, expand, the host's buttons, close. */
export const AskPanelHead = ({
  title,
  titleFallback,
  onNew,
  newLabel,
  onExpand,
  expanded = false,
  expandLabel,
  dockLabel,
  actions,
  onClose,
  closeLabel,
  words,
}: AskPanelHeadProps) => {
  // Its words: the product's, by its catalogue, else English; a text prop given still wins.
  const text = withGiven(useWords("askBar", askBarWords, words), {
    untitled: titleFallback,
    newChat: newLabel,
    expand: expandLabel,
    dock: dockLabel,
    close: closeLabel,
  });
  const named = title !== undefined && title !== "";
  return (
    <header data-slot="ask-panel-head" {...stylex.props(styles.head)}>
      <h2 {...stylex.props(styles.title)}>{named ? title : text.untitled}</h2>
      <BarActions close={<BarClose label={text.close} onClick={onClose} />}>
        <Button
          variant="ghost"
          size="sm"
          icon={Edit}
          aria-label={text.newChat}
          onClick={onNew}
        />
        {onExpand !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            icon={Expand}
            aria-label={expanded ? text.dock : text.expand}
            onClick={onExpand}
          />
        )}
        {actions}
      </BarActions>
    </header>
  );
};
