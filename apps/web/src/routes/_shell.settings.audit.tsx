import type {
  AuditPage,
  AuditRecord,
  FullVerification,
} from "@grasp-os/shared/audit-log";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { EventInspector } from "../activity/audit-event.tsx";
import { LogBar, LogRecords, readLog } from "../activity/audit-log.tsx";
import { logSearchOf } from "../activity/log-search.ts";
import type { LogSearch } from "../activity/log-search.ts";
import type { Directory } from "../directory.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { RetentionRows } from "../settings/audit-archive.tsx";
import {
  ChainBroken,
  endedOf,
  IntegrityDialog,
} from "../settings/audit-chain.tsx";
import { SettingsError } from "../settings/settings-parts.tsx";

// Settings › Audit trail, for admins: the events are the page. A broken
// hash chain shows above them (settings/audit-chain.tsx); otherwise only
// the events card stands under the page's title, with the integrity check,
// the archive and how long events are kept behind one quiet button in its
// head. Over the table, a search, Filters and Export (activity/
// audit-log.tsx); an event's details open beside the table, in Damsko's
// Inspector, or in a Sheet where the page is narrow. Core checks the role
// on every call; every search of the log is itself recorded in it.

/**
 * How wide the page's own box must be for the details beside the table:
 * the panel, the gap, and about 600px left for the table. The Inspector
 * pattern's 72rem is a whole window with its sidebar; this is the page's.
 */
const WIDE = 64 * 16;

const styles = stylex.create({
  // The table, and the details beside it while an event is open.
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    columnGap: space["6"],
    alignItems: "start",
  },
  open: {
    gridTemplateColumns: `minmax(0, 1fr) ${size.sidePanelWidth}`,
  },
  // The details stay in view beside the table, as tall as the window
  // lets them be, and scroll inside.
  aside: {
    position: "sticky",
    insetBlockStart: space["4"],
    display: "grid",
    gridTemplateRows: "minmax(0, 1fr)",
    height: `calc(100dvh - 2 * ${space["8"]})`,
    minHeight: 0,
  },
});

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

/** Whether the element is wide enough for the details beside the table; true until measured. */
const useWide = () => {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return () => {
        // Nothing was watched.
      };
    }
    const watch = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= WIDE);
    });
    watch.observe(element);
    return () => {
      watch.disconnect();
    };
  }, []);
  return { box, wide };
};

/** The open event's details: beside the table, or in a Sheet where it is narrow. */
const Details = ({
  record,
  directory,
  wide,
  onClose,
}: {
  record: AuditRecord;
  directory: Directory;
  wide: boolean;
  onClose: () => void;
}) => {
  if (wide) {
    return (
      <div {...stylex.props(styles.aside)}>
        <EventInspector
          directory={directory}
          framed
          onClose={onClose}
          record={record}
        />
      </div>
    );
  }
  return (
    <Sheet
      onOpenChange={(open: boolean) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            <Trans>Event details</Trans>
          </SheetTitle>
        </SheetHeader>
        <EventInspector directory={directory} framed={false} record={record} />
      </SheetContent>
    </Sheet>
  );
};

const AuditTrail = () => {
  const { log, last } = Route.useLoaderData();
  const filters = Route.useSearch();
  const [own, setOwn] = useState<FullVerification | null>(null);
  const [open, setOpen] = useState<AuditRecord>();
  const { box, wide } = useWide();
  const directory = log.state === "ready" ? log.data.directory : undefined;
  const beside = open !== undefined && directory !== undefined && wide;
  return (
    <>
      <ChainBroken ended={endedOf(own, last)} />
      <div ref={box} {...stylex.props(styles.split, beside && styles.open)}>
        <Card size="sm">
          <CardHeader>
            <CardTitle level={2}>
              {filters.archive === true ? (
                <Trans>Archived events</Trans>
              ) : (
                <Trans>Events</Trans>
              )}
            </CardTitle>
            <CardAction>
              <IntegrityDialog last={last} onChecked={setOwn} own={own}>
                <RetentionRows />
              </IntegrityDialog>
            </CardAction>
          </CardHeader>
          <CardContent flush>
            {log.state === "ready" ? (
              <>
                {/* The bar starts again from new filters. */}
                <LogBar
                  directory={log.data.directory}
                  key={JSON.stringify(filters)}
                  search={filters}
                />
                <LogRecords
                  beside={beside}
                  directory={log.data.directory}
                  first={log.data.page}
                  key={logKey(filters, log.data.page)}
                  onDetails={setOpen}
                  open={open?.seq}
                  search={filters}
                />
              </>
            ) : (
              <NotLoadedState heading="h3" page={log} />
            )}
          </CardContent>
        </Card>
        {open === undefined || directory === undefined ? null : (
          <Details
            directory={directory}
            key={open.seq}
            onClose={() => {
              setOpen(undefined);
            }}
            record={open}
            wide={wide}
          />
        )}
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/audit")({
  validateSearch: (search: Record<string, unknown>): LogSearch =>
    logSearchOf(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) => {
    const [log, last] = await Promise.all([
      loadFromCore(core, async (session) => await readLog(session, deps)),
      loadFromCore(
        core,
        async (session) => await session.audit.lastVerification()
      ),
    ]);
    return { log, last };
  },
  errorComponent: SettingsError,
  component: AuditTrail,
});
