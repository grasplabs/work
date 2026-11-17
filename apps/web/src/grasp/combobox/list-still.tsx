// ListItemStill: draws one item of a popup list standing still, for the docs only: the every-state
// rows of Command, Context menu and Menubar. It wears the real item's styles (list.styles.ts), so
// it shows exactly what a product shows; only UI SDK's behaviour is left out, so it is inert. Not
// part of any component: never in a product.
//
//   <ListItemStill state="highlighted" label="Duplicate" icon={Copy} end="Ctrl+D" />
import * as stylex from "@stylexjs/stylex";

import { Icon, Spinner, Tick } from "../icons";
import type { IconData } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { listStyles } from "./list.styles";

// A picture, not a control: inert, and no pointer over it or hover on it, so nothing in it reads as
// pressable (Ruben pressed a still's buttons, 15 November).
const picture = stylex.create({ still: { pointerEvents: "none" } });

export type ListItemStillState =
  | "rest"
  | "highlighted"
  | "disabled"
  | "danger"
  | "danger-highlighted"
  | "chosen"
  | "working"
  | "failed";

export interface ListItemStillProps {
  /** The state it stands in. */
  state: ListItemStillState;
  /** The item's words. */
  label: string;
  /** An icon before the words. */
  icon?: IconData;
  /** What stands at the end at rest: a shortcut's keys. */
  end?: string;
  /** A menu's item (text-sm in ink) rather than a search list's (text-xs, quiet). */
  menu?: boolean;
  /** The words a failed item shows. */
  failedLabel?: string;
}

const styles = stylex.create({
  // A piece of the popup round the item, so it stands on the popup's own fill.
  surface: {
    boxSizing: "border-box",
    width: grasp.popupWidth,
    maxWidth: "100%",
    padding: grasp.popupPadding,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    fontFamily: grasp.fontSans,
  },
  failed: { color: grasp.danger },
});

/** What stands at the end: the tick, the spinner, the failure, or at rest its keys. */
const StillEnd = ({
  state,
  failedLabel,
  end,
}: {
  state: ListItemStillState;
  failedLabel: string;
  end: string | undefined;
}) => {
  if (state === "chosen") {
    return (
      <span aria-hidden="true" {...stylex.props(listStyles.tick)}>
        <Icon icon={Tick} />
      </span>
    );
  }
  if (state === "working") {
    return (
      <span aria-hidden="true" {...stylex.props(listStyles.itemEnd)}>
        <Icon icon={Spinner} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span {...stylex.props(listStyles.itemEnd, styles.failed)}>
        {failedLabel}
      </span>
    );
  }
  return (
    end !== undefined &&
    end !== "" && <span {...stylex.props(listStyles.itemEnd)}>{end}</span>
  );
};

export const ListItemStill = ({
  state,
  label,
  icon,
  end,
  menu = false,
  failedLabel = "Failed",
}: ListItemStillProps) => {
  const danger = state === "danger" || state === "danger-highlighted";
  const lit = state === "highlighted" || state === "danger-highlighted";
  return (
    <div
      inert
      data-list-still={state}
      {...stylex.props(styles.surface, picture.still)}
    >
      <div
        {...stylex.props(
          listStyles.item,
          menu && listStyles.menuItem,
          lit && listStyles.itemHighlighted,
          danger && listStyles.itemDanger,
          state === "disabled" && listStyles.itemDisabled
        )}
      >
        {icon && (
          <span
            aria-hidden="true"
            {...stylex.props(
              listStyles.itemIcon,
              danger && listStyles.itemIconDanger
            )}
          >
            <Icon icon={icon} />
          </span>
        )}
        <span {...stylex.props(listStyles.itemWords)}>{label}</span>
        <StillEnd state={state} failedLabel={failedLabel} end={end} />
      </div>
    </div>
  );
};
