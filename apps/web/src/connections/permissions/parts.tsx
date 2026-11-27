import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, LockIcon } from "@grasp-os/ui/lib/icons";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { AllowedTool } from "../tool-choices.ts";
import { tally } from "./model.ts";
import type { ToolKind } from "./model.ts";

// The connect dialog's small shared parts: a kind's dot, the trust line
// with the consent as written behind it, and the count its foot says.

const styles = stylex.create({
  trust: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space[2],
    alignItems: "start",
  },
  trustIcon: {
    display: "flex",
    paddingTop: "0.2rem",
    color: colors.subtleForeground,
    [iconVars.size]: size.iconSm,
  },
  trustWords: { display: "grid", gap: space[1], justifyItems: "start" },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: "0.4375rem",
    height: "0.4375rem",
    borderRadius: radius.full,
  },
  look: { backgroundColor: colors.success },
  change: { backgroundColor: colors.warning },
  remove: { backgroundColor: colors.destructive },
});

/** A kind's dot: green, amber or red as the risk rises. */
export const KindDot = ({ kind }: { kind: ToolKind }) => (
  <span aria-hidden {...stylex.props(styles.dot, styles[kind])} />
);

/**
 * The trust line, in the page's language: where the access is kept and
 * what Grasp does with it. A consent stays word for word behind it: core
 * keeps a hash of that exact text.
 */
export const TrustLine = ({
  words,
  consent,
}: {
  words: string;
  /** The consent as core records it, when the connection takes one. */
  consent?: string;
}) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.trust)}>
      <span aria-hidden {...stylex.props(styles.trustIcon)}>
        <Icon icon={LockIcon} />
      </span>
      <div {...stylex.props(styles.trustWords)}>
        <Text color="muted" size="xs">
          {words}
        </Text>
        {consent === undefined ? null : (
          <Collapsible fitContent variant="plain">
            <CollapsibleTrigger size="sm" weight="normal">
              {t`Read the full consent`}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Text color="muted" size="xs">
                {consent}
              </Text>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
};

/** What the choice adds up to, in a line for the foot. */
export const useTallyWords = (allowed: readonly AllowedTool[]): string => {
  const { t } = useLingui();
  const { read, asks } = tally(allowed);
  if (read + asks === 0) {
    return t`Nothing turned on yet`;
  }
  if (asks === 0) {
    return t`${read} actions, all view only`;
  }
  return t`${read} view, ${asks} ask first`;
};
