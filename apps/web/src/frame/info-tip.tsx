import { Button } from "@grasp-os/ui/components/button";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// More about a part of a page behind an info mark beside its title or a
// setting's label: what it shows, who can see it, why. An icon-only ghost
// Button named by `aria-label`, its words in the Button's own tooltip, said
// on hover and focus. The mark stands after the title, never inside it: a
// heading's or a label's name is all the words in it, so a mark inside would
// join the card's heading ("Owner More about the owner") or the control's
// name ("Made for More about this section"). Damsko has no info mark (its
// old setting row's `info` left for the product); the Apps, workflows and
// Integrations pages share this one.

const styles = stylex.create({
  // The title and its mark on one line, centred on each other.
  row: { display: "flex", alignItems: "center", gap: space[1], minWidth: 0 },
  // No height of its own: the button may be taller than the title's line,
  // the row never is.
  mark: { display: "inline-flex", alignItems: "center", height: 0 },
});

/** The info mark: `children` said on hover and focus; `label` names it for a screen reader. */
export const InfoTip = ({
  label,
  children,
}: {
  label?: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={label ?? t`More about this section`}
      size="icon-xs"
      tooltip={children}
      variant="ghost"
    >
      <Icon icon={InfoIcon} />
    </Button>
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
}: {
  children: ReactNode;
  info: ReactNode;
  label?: string;
}) => (
  <div {...stylex.props(styles.row)}>
    {children}
    <span {...stylex.props(styles.mark)}>
      <InfoTip {...(label === undefined ? {} : { label })}>{info}</InfoTip>
    </span>
  </div>
);
