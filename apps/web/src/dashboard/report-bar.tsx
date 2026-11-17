import type { NextReport } from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { File, Icon } from "../grasp/icons/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The weekly report as one bar across the dashboard: in how many days the
// next report is ready, or that the one on the week that closed is, with
// how far the week has come. Its one button exports the report as it
// stands today.

/** The days of a programme's week. */
const WEEK_DAYS = 7;

const styles = stylex.create({
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  words: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: grasp.space2,
    minWidth: 0,
  },
});

export const ReportBar = ({
  next,
  onExport,
}: {
  next: NextReport;
  onExport: () => void;
}) => {
  const { t } = useLingui();
  const { inDays, week } = next;
  const said =
    inDays === 0
      ? t`Your report on week ${week} is ready`
      : plural(inDays, {
          one: "Your next report is ready tomorrow",
          other: "Your next report is ready in # days",
        });
  return (
    <Card ground="soft" padding="md">
      <div {...stylex.props(styles.row)}>
        <Icon icon={File} />
        <div {...stylex.props(styles.words)}>
          <Text>{said}</Text>
          <Progress
            label={t`The week so far`}
            max={WEEK_DAYS}
            showLabel={false}
            size="sm"
            value={next.through}
          />
        </div>
        <Button onClick={onExport} size="sm" variant="ghost">
          {t`Export report`}
        </Button>
      </div>
    </Card>
  );
};
