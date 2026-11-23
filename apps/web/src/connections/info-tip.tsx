import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Icon, InfoIcon } from "@grasp-os/ui/lib/icons";
import { font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// More about a title or a setting behind a small info mark beside it, as
// the Integrations pages have it where one sentence would crowd the row
// (who may read what agents read, HTTP connections, access to remove by
// hand). Damsko has no such part: the plan puts it in the product
// (frame/info-tip.tsx), so it stands here until the frame takes it.

const styles = stylex.create({
  // In a box one line of small words tall: its button may be taller, the row never is.
  box: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textSmLine,
    verticalAlign: "middle",
  },
});

/** A title or a setting, and more about it behind an info mark. */
export const InfoTip = ({
  label,
  children,
}: {
  /** The mark's name for a screen reader ("More about HTTP connections"). */
  label: string;
  /** What the tooltip says. */
  children: ReactNode;
}) => (
  <span {...stylex.props(styles.box)}>
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon-xs"
          tooltip={false}
          variant="ghost"
        >
          <Icon icon={InfoIcon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  </span>
);
