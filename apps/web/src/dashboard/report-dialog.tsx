import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await } from "@tanstack/react-router";
import { FileTextIcon, PrinterIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFile, ExportFormat } from "../export/export-file.tsx";
import { LoadingLines } from "../frame/page-states.tsx";
import { PlainMarkdown } from "../knowledge/markdown.tsx";
import type { NextReport } from "./programme.ts";
import {
  reportBody,
  reportFileName,
  reportMarkdown,
  reportTitle,
} from "./report.ts";
import type { ReportReads } from "./report.ts";

// The weekly report, as the prototype's dialog (`components/metrics/
// report-dialog.tsx`): the report itself, to read through before taking
// it, as Markdown or as a PDF from the print window, the two ways every
// export in Grasp offers (export/export-file.tsx). It is made from what
// the dashboard read, as it stands when the dialog opens. The prototype's
// printer and sheet of paper aren't here: the report shows as the page it
// prints from.

/** The report, once its reads came: what it says, and the two ways to take it. */
const ReportSheet = ({
  reads,
  title,
  line,
  week,
  today,
  onTaken,
}: {
  reads: ReportReads;
  title: string;
  line: string;
  week: number;
  today: string;
  onTaken: () => void;
}) => {
  const { i18n, t } = useLingui();
  const body = reportBody(reads, { line, today }, i18n);
  const file: ExportFile = {
    name: reportFileName(week, today),
    title,
    markdown: () => reportMarkdown(title, body),
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
      <article
        aria-label={t`Report`}
        className="bg-card rounded-lg border px-5 py-4"
      >
        <PlainMarkdown text={body} />
      </article>
      <ErrorText>
        {failed ? t`The export didn't work. Try again.` : undefined}
      </ErrorText>
      <DialogFooter className="sm:*:flex-1">
        <Button
          disabled={busy}
          onClick={() => {
            void take("md");
          }}
          variant="secondary"
        >
          <FileTextIcon data-icon="inline-start" />
          <Trans>Download Markdown</Trans>
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void take("pdf");
          }}
        >
          {busy ? <Spinner /> : <PrinterIcon data-icon="inline-start" />}
          <Trans>Save as PDF</Trans>
        </Button>
      </DialogFooter>
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
  reads: Promise<ReportReads>;
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
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-h-svh overflow-y-auto sm:max-w-2xl"
        closeLabel={t`Close`}
      >
        <header className="flex flex-col gap-1 pr-8">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <Trans>
              What ran, the decisions it asked for, every workflow and what
              could be better. Keep it as Markdown, or save it as a PDF from the
              print window.
            </Trans>
          </DialogDescription>
        </header>
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
      </DialogContent>
    </Dialog>
  );
};
