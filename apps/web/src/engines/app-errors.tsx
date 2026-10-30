import type { AppErrorEntry, AppErrorLog } from "@grasp-os/shared/screens";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Plural, Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { formatDateTime, formatNumber } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// A domain's error log on its page, for its builders (`screens.errors`,
// which core lets only them read: admins, its owner and who it is shared
// with as a builder): what its screens reported, uncaught errors and
// `console.error` calls among them, and what its server code wrote with
// `console`. Core keeps each problem once per screen or method and
// version, with how often it came and when last, so the log reads as a
// list of problems, not of reports. It is read when the tab opens and
// again on asking: reports keep coming while people use the App. All of
// it is written by App code, so it shows as text and nothing more.

/** One entry's kind, in words. */
const KindBadge = ({ entry }: { entry: AppErrorEntry }) => {
  if (entry.source === "server") {
    if (entry.level === "error") {
      return (
        <Badge variant="attention">
          <Trans>Server error</Trans>
        </Badge>
      );
    }
    if (entry.level === "warn") {
      return (
        <Badge variant="attention">
          <Trans>Server warning</Trans>
        </Badge>
      );
    }
    return (
      <Badge>
        <Trans>Server log</Trans>
      </Badge>
    );
  }
  if (entry.kind === "warning") {
    return (
      <Badge>
        <Trans>Warning</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="attention">
      {entry.kind === "error" ? <Trans>Uncaught error</Trans> : null}
      {entry.kind === "rejection" ? <Trans>Unhandled rejection</Trans> : null}
      {entry.kind === "console" ? <Trans>Logged error</Trans> : null}
    </Badge>
  );
};

/** Where an entry came from: its screen, or the server method that wrote it. */
const Where = ({ entry }: { entry: AppErrorEntry }) => {
  if (entry.source === "screen") {
    return <span className="font-mono text-xs">{entry.screen}</span>;
  }
  if (entry.method === null) {
    return <Trans>Server</Trans>;
  }
  return <span className="font-mono text-xs">{entry.method}</span>;
};

/** What was reported: its message, and its stack when a screen sent one. */
const Problem = ({ entry }: { entry: AppErrorEntry }) => {
  const message = <span className="break-words">{entry.message}</span>;
  if (entry.source === "server" || entry.stack === undefined) {
    return message;
  }
  return (
    <details>
      <summary>{message}</summary>
      <pre className="bg-muted mt-2 overflow-x-auto rounded-md p-3 text-xs">
        <code className="font-mono">{entry.stack}</code>
      </pre>
    </details>
  );
};

/** One entry as core keeps it apart from the others. */
const entryKey = (entry: AppErrorEntry): string =>
  entry.source === "screen"
    ? `screen/${entry.version}/${entry.screen}/${entry.kind}/${entry.message}`
    : `server/${entry.version}/${entry.method ?? ""}/${entry.level}/${entry.message}`;

/** The error log as core last gave it. */
export const ErrorLogView = ({ log }: { log: AppErrorLog }) => {
  const { entries, suppressed } = log;
  return (
    <div className="flex flex-col gap-3">
      {suppressed > 0 ? (
        <p className="text-muted-foreground">
          <Plural
            one="At least # more report was dropped: the app reported more than it may in a minute."
            other="At least # more reports were dropped: the app reported more than it may in a minute."
            value={suppressed}
          />
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>
            Nothing went wrong in its apps or its server code so far.
          </Trans>
        </p>
      ) : (
        <div className="bg-card overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">
                  <Trans>Problem</Trans>
                </TableHead>
                <TableHead variant="card">
                  <Trans>Where</Trans>
                </TableHead>
                <TableHead className="w-24" variant="card">
                  <Trans>Version</Trans>
                </TableHead>
                <TableHead className="w-24" variant="card">
                  <Trans>Times</Trans>
                </TableHead>
                <TableHead className="w-44" variant="card">
                  <Trans>Last</Trans>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entryKey(entry)}>
                  <TableCell className="whitespace-normal" variant="card">
                    <div className="flex flex-col items-start gap-1">
                      <KindBadge entry={entry} />
                      <Problem entry={entry} />
                    </div>
                  </TableCell>
                  <TableCell variant="card">
                    <Where entry={entry} />
                  </TableCell>
                  <TableCell variant="card">{entry.version}</TableCell>
                  <TableCell variant="card">
                    <span className="tabular-nums">
                      {formatNumber(entry.count)}
                    </span>
                  </TableCell>
                  <TableCell variant="card">
                    {formatDateTime(entry.at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
};

/** The domain's error log, read when its tab opens and on asking. */
export const AppErrors = ({ app }: { app: { id: string } }) => {
  const core = useCore();
  const [log, setLog] = useState<Loaded<AppErrorLog>>();
  // Counts each read asked for, so asking again reads again.
  const [asked, setAsked] = useState(0);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      setReading(true);
      const loaded = await loadFromCore(
        core,
        async (session) => await session.screens.errors(app.id),
        left.signal
      );
      if (!left.signal.aborted) {
        setLog(loaded);
        setReading(false);
      }
    };
    void read();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `asked` says when to read again
  }, [app.id, asked, core]);
  if (log === undefined) {
    return <LoadingLines lines={3} />;
  }
  return (
    <div className="flex flex-col items-start gap-3">
      <Button
        disabled={reading}
        onClick={() => {
          setAsked((count) => count + 1);
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Refresh</Trans>
      </Button>
      <div className="w-full">
        {log.state === "ready" ? (
          <ErrorLogView log={log.data} />
        ) : (
          <NotLoaded page={log} />
        )}
      </div>
    </div>
  );
};
