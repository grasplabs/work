import type { BoardReport } from "@grasp-os/shared/board-report";
import type { Programme } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { ReportBar } from "./report-bar.tsx";
import { programmeLine } from "./report.ts";

// The weekly report while the company has a programme with Grasp: its bar
// (report-bar.tsx), and the dialog that exports it (report-dialog.tsx),
// made of what core has. The inbox shows it above what waits.

// The report and its export, with their Markdown, load once it is first
// asked for.
const ReportDialog = lazy(async () => {
  const { ReportDialog: dialog } = await import("./report-dialog.tsx");
  return { default: dialog };
});

export const WeeklyReport = ({
  programme,
  report,
}: {
  /** The programme with Grasp, with its plan. */
  programme: Programme;
  /** Core's read of the report: the dialog waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { i18n } = useLingui();
  const router = useRouter();
  const [exporting, setExporting] = useState(false);
  // Kept once opened, so it closes as a dialog does, not all at once.
  const [exported, setExported] = useState(false);
  const line = programmeLine(programme, i18n);
  const { nextReport: next, today } = programme;
  return (
    <>
      <ReportBar
        line={line}
        next={next}
        onExport={() => {
          // Read again first, so the report is as it stands now, not as
          // it stood when the page was opened.
          void (async () => {
            await router.invalidate();
            setExported(true);
            setExporting(true);
          })();
        }}
      />
      {exported ? (
        <Suspense fallback={null}>
          <ReportDialog
            line={line}
            next={next}
            onOpenChange={setExporting}
            open={exporting}
            reads={report}
            today={today}
          />
        </Suspense>
      ) : null}
    </>
  );
};
