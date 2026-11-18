import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { programmeLine } from "../dashboard/report.ts";
import { Button } from "../grasp/button/index.ts";
import { File, Icon } from "../grasp/icons/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";

// The weekly report as one quiet row at the foot of the Inbox's list: in
// how many days the next report is ready, or that the one on the week
// that closed is, with how far the week has come, and Export report, which
// opens the report as it stands today (report-dialog.tsx). Only with a
// programme.

/** The days of a programme's week. */
const WEEK_DAYS = 7;

// The report and its export, with their Markdown, load once it is first asked for.
const ReportDialog = lazy(async () => {
  const { ReportDialog: dialog } =
    await import("../dashboard/report-dialog.tsx");
  return { default: dialog };
});

const styles = stylex.create({
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
    paddingInline: grasp.space2,
  },
  words: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: grasp.space2,
    minWidth: 0,
  },
});

export const ReportRow = ({
  programme,
  report,
}: {
  programme: Programme;
  /** The weekly report, as core reads it in one call: the dialog waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  // Kept once opened, so it closes as a dialog does, not all at once.
  const [exported, setExported] = useState(false);
  const { nextReport: next, today } = programme;
  const { inDays, week } = next;
  const said =
    inDays === 0
      ? t`Your report on week ${week} is ready`
      : plural(inDays, {
          one: "Your next report is ready tomorrow",
          other: "Your next report is ready in # days",
        });
  return (
    <div {...stylex.props(styles.row)}>
      <Icon icon={File} />
      <div {...stylex.props(styles.words)}>
        <Text size="sm">{said}</Text>
        <Progress
          label={t`The week so far`}
          max={WEEK_DAYS}
          showLabel={false}
          size="sm"
          value={next.through}
        />
      </div>
      <Button
        onClick={() => {
          // Read again first, so the report is as it stands now, not as
          // it stood when the page was opened.
          void (async () => {
            await router.invalidate();
            setExported(true);
            setExporting(true);
          })();
        }}
        size="sm"
        variant="ghost"
      >
        {t`Export report`}
      </Button>
      {exported ? (
        <Suspense fallback={null}>
          <ReportDialog
            line={programmeLine(programme, i18n)}
            next={next}
            onOpenChange={setExporting}
            open={exporting}
            reads={report}
            today={today}
          />
        </Suspense>
      ) : null}
    </div>
  );
};
