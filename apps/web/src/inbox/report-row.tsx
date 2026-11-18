import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";

import { programmeLine } from "../dashboard/report.ts";
import { formatDayMonth } from "../format.ts";
import { File } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import type { Loaded } from "../load-from-core.tsx";

// The weekly report as an item in the Inbox: it stands at the head of the
// list once the report on the week that closed is ready, and opening it
// shows the report with its two downloads, Markdown and PDF
// (report-dialog.tsx). Before that day it isn't there at all.

// The report and its export, with their Markdown, load once it is first opened.
const ReportDialog = lazy(async () => {
  const { ReportDialog: dialog } =
    await import("../dashboard/report-dialog.tsx");
  return { default: dialog };
});

export const ReportItem = ({
  programme,
  report,
}: {
  programme: Programme;
  /** The weekly report, as core reads it in one call: the dialog waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Kept once opened, so it closes as a dialog does, not all at once.
  const [opened, setOpened] = useState(false);
  const { nextReport: next, today } = programme;
  const { week } = next;
  const day = formatDayMonth(today);
  return (
    <>
      <ItemGroup aria-label={t`Your weekly report`}>
        <Item
          render={
            <button
              aria-label={t`Your report on week ${week} is ready`}
              onClick={() => {
                // Read again first, so the report is as it stands now.
                void (async () => {
                  await router.invalidate();
                  setOpened(true);
                  setOpen(true);
                })();
              }}
              type="button"
            />
          }
          size="xs"
        >
          <ItemMedia icon={File} iconLook="inline" />
          <ItemContent>
            <ItemTitle>{t`Your report on week ${week} is ready`}</ItemTitle>
            <ItemDescription>{t`Report · ${day}`}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      {opened ? (
        <Suspense fallback={null}>
          <ReportDialog
            line={programmeLine(programme, i18n)}
            next={next}
            onOpenChange={setOpen}
            open={open}
            reads={report}
            today={today}
          />
        </Suspense>
      ) : null}
    </>
  );
};
