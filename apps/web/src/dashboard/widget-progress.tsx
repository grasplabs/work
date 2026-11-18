import type { WidgetProgress } from "@grasp-os/shared/widgets";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Card } from "../grasp/card/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// How Grasp is getting on with a widget it makes or changes, as core
// streams it (`onProgress` of `makeWidget` and `changeWidget`): said over
// the block's dots while it works, and to a screen reader as it changes.
// What it reads of the widget being written, its title and how many
// parts it has so far, is the model's answer as far as it came, never
// kept: the widget is what core checks and keeps once it is whole.

/** What the line says of `progress`; before any comes, that Grasp is starting. */
const useProgressText = (progress: WidgetProgress | null): string => {
  const { t } = useLingui();
  if (progress === null) {
    return t`Grasp is starting on the widget…`;
  }
  if (progress.stage === "keeping") {
    return t`Putting it on your board…`;
  }
  const { attempt, attempts } = progress;
  if (progress.stage === "checking") {
    return t`Checking it against your numbers…`;
  }
  if (attempt > 1) {
    return t`Putting it right, try ${attempt} of ${attempts}…`;
  }
  const { title } = progress.draft;
  return title === null ? t`Writing the widget…` : t`Writing “${title}”…`;
};

/** How many parts the widget being written has so far, once it has any. */
const partsText = (progress: WidgetProgress | null): string | null => {
  if (progress?.stage !== "writing" || progress.draft.parts.length === 0) {
    return null;
  }
  const count = progress.draft.parts.length;
  return plural(count, { one: "# part so far", other: "# parts so far" });
};

/** Over the dots (making-dots.tsx), which stand at 10. */
const OVER_DOTS = 20;

const styles = stylex.create({
  line: {
    position: "absolute",
    insetInline: grasp.space3,
    insetBlockEnd: grasp.space3,
    zIndex: OVER_DOTS,
  },
  words: { display: "flex", flexDirection: "column", minWidth: 0 },
});

/** The line over a block while Grasp makes its widget. */
export const WidgetProgressLine = ({
  progress,
}: {
  progress: WidgetProgress | null;
}) => {
  const text = useProgressText(progress);
  const parts = partsText(progress);
  return (
    <output {...stylex.props(styles.line)}>
      <Card padding="md">
        <span {...stylex.props(styles.words)}>
          <Text element="span" size="sm" tone="ink" wrap="truncate">
            {text}
          </Text>
          {parts === null ? null : (
            <Text element="span" size="sm" tone="muted">
              {parts}
            </Text>
          )}
        </span>
      </Card>
    </output>
  );
};
