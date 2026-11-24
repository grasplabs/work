import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { ModelsUnavailable } from "./global-chat.tsx";

// Why nothing can be asked yet, under the box (the chat's, and Chat's own
// page's), with the way out: core out of reach, or refusing to say which
// models there are. No AI provider is the box's own to say (composer.tsx).

const styles = stylex.create({
  notice: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    paddingInline: space["1"],
  },
});

/** Why the models can't be read, where they can't: a question held for them goes unsent with these words. */
export const unavailableText = (
  why: ModelsUnavailable | undefined
): string | undefined => (why?.why === "read" ? why.text : undefined);

/** Why nothing can be asked yet, under the box, with the way out. */
export const ModelsUnavailableNotice = ({
  why,
  onRetry,
}: {
  why: ModelsUnavailable | undefined;
  onRetry: (() => void) | undefined;
}) => {
  const text = unavailableText(why);
  if (text === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.notice)}>
      <Text color="muted" size="xs">
        {text}
      </Text>
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} size="xs" variant="ghost">
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
  );
};
