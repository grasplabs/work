import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// More about a part of a page behind an info mark beside its title or a
// setting's label: what it shows, who can see it, why. An icon-only ghost
// Button named by `aria-label`, its words in a Tooltip that opens on hover,
// focus and a press (`toggleable`), so a tap on a phone shows them too, as
// Damsko's Tooltip docs compose an info mark. The mark stands after the
// title, never inside it: a heading's or a label's name is all the words in
// it, so a mark inside would join the card's heading ("Owner More about the
// owner") or the control's name ("Made for More about this section"). The
// Apps, workflows, settings, agents and Integrations pages share this one.

const styles = stylex.create({
  // The title and its mark on one line, centred on each other; where the
  // title takes the line's width (a card beside the docked chat), the mark
  // goes under it, as #2503's, and the title keeps its words whole.
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[1],
    rowGap: space[2],
    minWidth: 0,
  },
  // Beside a card's title, a space-2 from it, as #2503's section header
  // sets its title row; beside a label, a space-1, as its setting row.
  ofTitle: { columnGap: space[2] },
  // A box no taller than the title's line: the button may be taller, the
  // row never is.
  mark: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
  },
});

/** The info mark: `children` said on hover, focus and a press; `label` names it for a screen reader. */
export const InfoTip = ({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Tooltip toggleable>
      <TooltipTrigger asChild>
        <Button
          aria-label={label ?? t`More about this section`}
          size="icon-xs"
          variant="ghost"
        >
          <Icon icon={InfoIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  );
};

/**
 * A title or a label (`children`: a CardTitle, a FieldLabel) with its info
 * mark after it (`info`, `label` as `InfoTip`'s), outside it, so the
 * heading or the control it names keeps its own words.
 */
export const WithInfo = ({
  children,
  info,
  label,
  of = "label",
}: {
  children: ReactNode;
  info: ReactNode;
  label?: string;
  /** What it stands beside: a label's (a field's, a setting's), or a card's title. */
  of?: "label" | "title";
}) => (
  <div {...stylex.props(styles.row, of === "title" && styles.ofTitle)}>
    {children}
    <span {...stylex.props(styles.mark)}>
      <InfoTip {...(label === undefined ? {} : { label })}>{info}</InfoTip>
    </span>
  </div>
);
