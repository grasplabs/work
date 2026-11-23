import { Button } from "@grasp-os/ui/components/button";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

// More about a part of a page behind an info mark beside its title: what
// it shows, who can see it, why. Said on hover and focus, in the Button's
// own tooltip, so it never makes the title's line taller. Damsko has no
// such part (its old setting row's InfoMark left for the product).

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
