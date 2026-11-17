// ComposerQueue: messages written while an answer was still coming, waiting their turn above a
// composer's card (composer.tsx), after Palermo's "Queued" list. It folds open and shut (Grasp's
// Collapsible); each row can be sent now, edited or taken off.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";

import { Button } from "../button";
import { Collapsible } from "../collapsible";
import { ArrowUp, Edit, Trash } from "../icons";
import type { IconData } from "../icons";
import { grasp } from "../tokens/tokens.stylex";

/** One waiting message. */
export interface ComposerQueued {
  /** Its own key. */
  id: string;
  /** The message, as written. */
  text: string;
}

/** Every prop a ComposerQueue takes. */
export interface ComposerQueueProps {
  /** The waiting messages, the next one first. */
  items: ComposerQueued[];
  /**
   * The words on the fold, with the count ("2 queued").
   * @default count + " queued"
   */
  title?: string;
  /**
   * The words on the fold when no `title` is given, from how many wait.
   * @default (count) => `${count} queued`
   */
  queuedLabel?: (count: number) => string;
  /**
   * The names of a row's buttons, each from the message it acts on.
   * @default (text) => `Edit: ${text}`, `Send now: ${text}`, `Remove: ${text}`
   */
  editLabel?: (text: string) => string;
  /** The name of a message's button that sends it now, ahead of the queue, from the message's words. */
  sendNowLabel?: (text: string) => string;
  /** The name of a message's button that takes it out of the queue, from the message's words. */
  removeLabel?: (text: string) => string;
  /** Sends this one now, ahead of the rest. Without it, there is no send button on the rows. */
  onSendNow?: (id: string) => unknown;
  /** Puts this one back into the composer to change it. */
  onEdit?: (id: string) => unknown;
  /** Takes this one off the queue. */
  onRemove?: (id: string) => unknown;
  /**
   * Open at first.
   * @default true
   */
  defaultOpen?: boolean;
}

const styles = stylex.create({
  panel: {
    // In from the card's sides by space-2, as the band under the card, so its side lies inside the
    // card's rounded corner and never runs beside it. Its words still start where the card's do:
    // the header, each row and the composer's text share one left edge; the row actions end where
    // send ends.
    marginInline: grasp.space2,
    paddingInlineStart: `calc(${grasp.space4} - ${grasp.space2})`,
    // The row actions end where send ends: the footer's inset, space-2, less the panel's own.
    paddingInlineEnd: 0,
    paddingBlockStart: grasp.space1,
    // The card overlaps the panel's foot, so the queue reads as tucked behind it.
    marginBlockEnd: `calc(-1 * ${grasp.composerCorner})`,
    paddingBlockEnd: grasp.composerCorner,
    borderStartStartRadius: grasp.corner,
    borderStartEndRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftLow,
  },
  list: {
    display: "grid",
    gap: grasp.space1,
    paddingBlockEnd: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
  },
  text: {
    flexGrow: 1,
    minWidth: 0,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    overflowWrap: "anywhere",
  },
});

const RowAction = ({
  icon,
  label,
  onPress,
}: {
  icon: IconData;
  label: string;
  onPress: () => unknown;
}) => (
  <PressPrimitive
    onClick={onPress}
    pendingAnnouncement=""
    render={(props: Record<string, unknown>) => (
      <Button
        {...props}
        variant="ghost"
        size="sm"
        icon={icon}
        aria-label={label}
      />
    )}
  />
);

// The default words, in English; each is a prop, so a product can translate it.
const queued = (count: number) => `${count} queued`;
const edit = (text: string) => `Edit: ${text}`;
const sendNow = (text: string) => `Send now: ${text}`;
const remove = (text: string) => `Remove: ${text}`;

/** Messages waiting their turn, above the card. */
export const ComposerQueue = ({
  items,
  title,
  queuedLabel = queued,
  editLabel = edit,
  sendNowLabel = sendNow,
  removeLabel = remove,
  onSendNow,
  onEdit,
  onRemove,
  defaultOpen = true,
}: ComposerQueueProps) => {
  if (items.length === 0) {
    return null;
  }
  return (
    <div data-slot="composer-queue" {...stylex.props(styles.panel)}>
      <Collapsible
        title={title ?? queuedLabel(items.length)}
        defaultOpen={defaultOpen}
      >
        <ul {...stylex.props(styles.list)}>
          {items.map((item) => (
            <li key={item.id} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.text)}>{item.text}</span>
              {onEdit && (
                <RowAction
                  icon={Edit}
                  label={editLabel(item.text)}
                  onPress={() => onEdit(item.id)}
                />
              )}
              {onSendNow && (
                <RowAction
                  icon={ArrowUp}
                  label={sendNowLabel(item.text)}
                  onPress={() => onSendNow(item.id)}
                />
              )}
              {onRemove && (
                <RowAction
                  icon={Trash}
                  label={removeLabel(item.text)}
                  onPress={() => onRemove(item.id)}
                />
              )}
            </li>
          ))}
        </ul>
      </Collapsible>
    </div>
  );
};
