import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { NextReport } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFile, ExportFormat } from "../export/export-file.tsx";
import { FigureTiles } from "../export/figure-tiles.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Doc, Pdf } from "../grasp/icons/index.ts";
import {
  Sheet,
  SheetBody,
  SheetDescription,
  SheetFooter,
  SheetPanel,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { PlainMarkdown } from "../knowledge/markdown.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  readsOf,
  reportBody,
  reportFigures,
  reportFileName,
  reportMarkdown,
  reportTitle,
} from "./report.ts";

// The weekly report, as the prototype's dialog (`components/metrics/
// report-dialog.tsx`): the report itself, to read through before taking
// it, as Markdown or as a PDF from the print window, the two ways every
// export in Grasp offers (export/export-file.tsx). It is made from core's
// read of it (`dashboard.report()`), as it stands when the dialog opens. The prototype's
// printer and sheet of paper aren't here: the report shows as the page it
// prints from, its key figures in tiles over its text, as the PDF has them.
// The prototype's hours bars aren't either: core keeps no hours.

const styles = stylex.create({
  report: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
  },
});

/** The report, once its reads came: what it says, and the two ways to take it. */
const ReportSheet = ({
  reads,
  title,
  line,
  week,
  today,
  onTaken,
}: {
  reads: Loaded<BoardReport>;
  title: string;
  line: string;
  week: number;
  today: string;
  onTaken: () => void;
}) => {
  const { i18n, t } = useLingui();
  const parts = readsOf(reads);
  const body = reportBody(parts, { line, today }, i18n);
  const figures = reportFigures(parts.runs, i18n);
  const file: ExportFile = {
    name: reportFileName(week, today),
    title,
    markdown: () => reportMarkdown(title, body),
    figures,
  };
  // While the page to print is being made, and whether an export failed.
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const take = async (format: ExportFormat): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await exportAs(file, format, i18n.locale);
      onTaken();
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };
  return (
    <>
      <SheetBody>
        <Card element="article" ground="soft">
          <div aria-label={t`Report`} {...stylex.props(styles.report)}>
            <FigureTiles figures={figures} />
            <PlainMarkdown text={body} />
          </div>
        </Card>
        <ErrorText>
          {failed ? t`The export didn't work. Try again.` : undefined}
        </ErrorText>
      </SheetBody>
      <SheetFooter>
        <Button
          disabled={busy}
          icon={Doc}
          onClick={() => {
            void take("md");
          }}
        >
          {t`Download Markdown`}
        </Button>
        <Button
          disabled={busy}
          icon={Pdf}
          onClick={() => {
            void take("pdf");
          }}
          variant="ink"
        >
          {t`Save as PDF`}
        </Button>
      </SheetFooter>
    </>
  );
};

export const ReportDialog = ({
  reads,
  next,
  line,
  today,
  open,
  onOpenChange,
}: {
  reads: Promise<Loaded<BoardReport>>;
  next: NextReport;
  /** The programme's line: "Week 3 of 8 · Under way". */
  line: string;
  today: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { i18n, t } = useLingui();
  const { week } = next;
  const title = reportTitle(next, i18n);
  return (
    <Sheet onOpenChange={onOpenChange} open={open} size="wide">
      <SheetPanel closeLabel={t`Close`}>
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          {t`What ran, the decisions it asked for, every workflow and what could be better. Keep it as Markdown, or save it as a PDF from the print window.`}
        </SheetDescription>
        {/* Only while open, so each opening shows the report as it stands. */}
        {open ? (
          <Await fallback={<LoadingLines lines={6} />} promise={reads}>
            {(loaded) => (
              <ReportSheet
                line={line}
                onTaken={() => {
                  onOpenChange(false);
                }}
                reads={loaded}
                title={title}
                today={today}
                week={week}
              />
            )}
          </Await>
        ) : null}
      </SheetPanel>
    </Sheet>
  );
};
