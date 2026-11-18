import type { BoardReport } from "@grasp-os/shared/dashboard";
import type { Programme } from "@grasp-os/shared/onboarding";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { formatDayMonth } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Download, File, Pdf } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Tabs, TabsList, TabsTrigger } from "../grasp/tabs/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { ReportView } from "./report-view.tsx";
import type { ReportLook } from "./report-view.tsx";

// The weekly report as an item in the Inbox: it stands at the head of the
// list once the report on the week that closed is ready. Opening it shows
// the report as the artifact Grasp made (report-artifact.ts), framed until
// the library's artifact viewer is installed, to download as the page or
// as a PDF. Concept branch: its three looks can be switched between.

const styles = stylex.create({
  looks: {
    marginBlockEnd: grasp.space3,
  },
  sheet: {
    borderRadius: grasp.corner,
    overflow: "hidden",
  },
});

const looks: Record<string, ReportLook> = { "1": 1, "2": 2, "3": 3 };

/**
 * The page as a file of its own: its markup, with every style the page has
 * written in, so it opens the same without Grasp.
 */
const snapshot = (page: HTMLElement, title: string): string => {
  const css = [...document.styleSheets]
    .flatMap((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText);
      } catch {
        return [];
      }
    })
    .join("\n");
  const root = document.documentElement;
  return `<!doctype html><html lang="${root.lang}" class="${root.className}" data-theme="${root.dataset.theme ?? ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><base href="${location.origin}/"><style>${css}</style></head><body>${page.outerHTML}</body></html>`;
};

/** The report, made of the library's parts, with its downloads. */
const ReportArtifact = ({
  report,
  programme,
}: {
  report: BoardReport;
  programme: Programme;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [look, setLook] = useState<ReportLook>(1);
  const [company, setCompany] = useState("");
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void core.withSession(async (session) => {
      const organization = await session.organization.get();
      setCompany(organization.name);
    });
  }, [core]);
  const name = `${company} week ${programme.week}`.trim();
  const file = (): string =>
    page.current === null ? "" : snapshot(page.current, name);
  return (
    <>
      <SheetBody>
        <Tabs
          layout={styles.looks}
          onValueChange={(value) => {
            const chosen = value === null ? undefined : looks[value];
            if (chosen !== undefined) {
              setLook(chosen);
            }
          }}
          value={String(look)}
          variant="segmented"
        >
          <TabsList aria-label={t`Look`}>
            <TabsTrigger value="1">{t`One sentence`}</TabsTrigger>
            <TabsTrigger value="2">{t`Charts`}</TabsTrigger>
            <TabsTrigger value="3">{t`A letter`}</TabsTrigger>
          </TabsList>
        </Tabs>
        {/* The artifact viewer stands round it once it is installed. */}
        <div {...stylex.props(styles.sheet)}>
          <ReportView
            company={company}
            look={look}
            programme={programme}
            ref={page}
            report={report}
          />
        </div>
      </SheetBody>
      <SheetFooter>
        <Button
          icon={Download}
          onClick={() => {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(
              new Blob([file()], { type: "text/html" })
            );
            link.download = `${name}.html`;
            link.click();
            URL.revokeObjectURL(link.href);
          }}
          variant="quiet"
        >
          {t`Download page`}
        </Button>
        <Button
          icon={Pdf}
          onClick={() => {
            // Printed from a frame of its own, so only the report is on the paper.
            const frame = document.createElement("iframe");
            frame.hidden = true;
            frame.srcdoc = file();
            frame.addEventListener("load", () => {
              frame.contentWindow?.print();
              setTimeout(() => {
                frame.remove();
              }, 1000);
            });
            document.body.append(frame);
          }}
          variant="ink"
        >
          {t`Save as PDF`}
        </Button>
      </SheetFooter>
    </>
  );
};

export const ReportItem = ({
  programme,
  report,
}: {
  programme: Programme;
  /** The weekly report, as core reads it in one call: the page waits for it. */
  report: Promise<Loaded<BoardReport>>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { nextReport: next, today } = programme;
  const { week } = next;
  const day = formatDayMonth(today);
  const title = t`Your report on week ${week} is ready`;
  return (
    <>
      <ItemGroup aria-label={t`Your weekly report`}>
        <Item
          render={
            <button
              aria-label={title}
              onClick={() => {
                // Read again first, so the report is as it stands now.
                void (async () => {
                  await router.invalidate();
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
            <ItemTitle>{title}</ItemTitle>
            <ItemDescription>{t`Report · ${day}`}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      <Sheet onOpenChange={setOpen} open={open} size="wide">
        <SheetContent>
          <SheetTitle>{t`Week ${week}`}</SheetTitle>
          <Await promise={report}>
            {(loaded) =>
              loaded.state === "ready" ? (
                <ReportArtifact programme={programme} report={loaded.data} />
              ) : null
            }
          </Await>
        </SheetContent>
      </Sheet>
    </>
  );
};
