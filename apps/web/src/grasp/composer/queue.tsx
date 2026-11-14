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
    // As wide as the card, and its words start where the card's do: the header, each row and the
    // composer's text share one left edge; the row actions end where send ends.
    paddingInlineStart: grasp.space4,
    paddingInlineEnd: grasp.space3,
    paddingBlockStart: grasp.space1,
    // The card overlaps the panel's foot, so the queue reads as tucked behind it.
    marginBlockEnd: `calc(-1 * ${grasp.corner})`,
    paddingBlockEnd: grasp.corner,
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
      <Button {...props} variant="ghost" size="sm" icon={icon} label={label} />
    )}
  />
);

/** Messages waiting their turn, above the card. */
export const ComposerQueue = ({
  items,
  title,
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
        title={title ?? `${items.length} queued`}
        defaultOpen={defaultOpen}
      >
        <ul {...stylex.props(styles.list)}>
          {items.map((item) => (
            <li key={item.id} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.text)}>{item.text}</span>
              {onEdit && (
                <RowAction
                  icon={Edit}
                  label={`Edit: ${item.text}`}
                  onPress={() => onEdit(item.id)}
                />
              )}
              {onSendNow && (
                <RowAction
                  icon={ArrowUp}
                  label={`Send now: ${item.text}`}
                  onPress={() => onSendNow(item.id)}
                />
              )}
              {onRemove && (
                <RowAction
                  icon={Trash}
                  label={`Remove: ${item.text}`}
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
