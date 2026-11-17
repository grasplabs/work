import type { AuditActor } from "@grasp-os/shared/audit";
import {
  auditExportPath,
  auditEventTypeSchema,
} from "@grasp-os/shared/audit-log";
import type {
  AuditExportFormat,
  AuditFilter,
  AuditPage,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { i18n } from "@lingui/core";
import { msg, ph, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { appName, personName, readDirectory } from "../directory.ts";
import type { Directory } from "../directory.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import { CopyField } from "../grasp/copy-field/index.ts";
import { DateRangePicker } from "../grasp/date-range-picker/index.ts";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Download } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { RowAlert } from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { actionWords } from "./audit-words.ts";
import { logSearchOf } from "./log-search.ts";
import type { LogSearch } from "./log-search.ts";
import { typeLabels } from "./type-labels.ts";

// The audit log, for admins, on Grasp UI: its events newest first, narrowed
// by the filters in the page's address (a toolbar over them), 25 a page,
// each with its details in a Dialog and whether it verified, and an export
// of everything the filters match, alone or with the archive. Core records
// every search and export in the log itself.

/** Midnight starting `day`, `days` later, in the viewer's time zone. */
const midnight = (day: string, days = 0): string => {
  const date = new Date(`${day}T00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

/** The filters as core takes them: `to` up to the end of its day. */
export const auditFilterOf = ({
  type,
  action,
  actor,
  target,
  from,
  to,
}: LogSearch): AuditFilter => ({
  type,
  action,
  actorId: actor,
  targetId: target,
  from: from === undefined ? undefined : midnight(from),
  to: to === undefined ? undefined : midnight(to, 1),
});

/** The first page of events that match, with the names to show. */
export interface LogPage {
  page: AuditPage;
  directory: Directory;
}

export const readLog = async (
  session: Session,
  search: LogSearch
): Promise<LogPage> => {
  const [page, directory] = await Promise.all([
    session.audit.search(auditFilterOf(search)),
    readDirectory(session),
  ]);
  return { page, directory };
};

const anyType = "any";

/** The types to filter by, in the page's language. */
const typeItems = (): { label: string; value: string }[] => [
  { label: i18n._(msg`Any type`), value: anyType },
  ...auditEventTypeSchema.options.map((type) => ({
    label: i18n._(typeLabels[type]),
    value: type,
  })),
];

const styles = stylex.create({
  // The filters in one row over the events, wrapping on a phone.
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    paddingInline: grasp.tableCellInline,
    paddingBlock: grasp.space3,
  },
  type: { width: "11rem" },
  more: {
    display: "grid",
    gap: grasp.space3,
    width: "16rem",
  },
  pager: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space2,
    paddingInline: grasp.tableCellInline,
    paddingBlock: grasp.space2,
    borderTopStyle: "solid",
    borderTopWidth: grasp.hairline,
    borderTopColor: grasp.line,
  },
  empty: {
    paddingInline: grasp.tableCellInline,
    paddingBlock: grasp.space4,
  },
  // On one line: on a phone the table scrolls sideways rather than grow tall.
  marks: {
    display: "flex",
    flexWrap: "nowrap",
    justifyContent: "flex-end",
    gap: grasp.space1,
  },
  details: { display: "grid", gap: grasp.space3 },
  // Named for a screen reader alone: the actions' column has no words to show.
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** The filters as the page holds them while they are set. */
interface Shown {
  type: string;
  action: string;
  actor: string;
  target: string;
  from: string | undefined;
  to: string | undefined;
}

/** The filters as the address has them, ready to set. */
const shownOf = (search: LogSearch): Shown => ({
  type: search.type ?? anyType,
  action: search.action ?? "",
  actor: search.actor ?? "",
  target: search.target ?? "",
  from: search.from,
  to: search.to,
});

/**
 * The action as recorded, and who and what an event is about, by ID,
 * behind a button of the toolbar: set most often from an event itself,
 * its person or its target.
 */
const MoreFilters = ({
  shown,
  onChange,
}: {
  shown: Shown;
  onChange: (shown: Shown) => void;
}) => {
  const { t } = useLingui();
  const set = [shown.action, shown.actor, shown.target].filter(
    (value) => value !== ""
  ).length;
  return (
    <Popover>
      <PopoverTrigger size="sm" variant="ghost">
        {set === 0
          ? t`More filters`
          : t`${plural(set, { one: "More filters, # set", other: "More filters, # set" })}`}
      </PopoverTrigger>
      <PopoverContent align="start">
        <div {...stylex.props(styles.more)}>
          <Field name="action">
            <FieldLabel>{t`Action`}</FieldLabel>
            <Input
              maxLength={identifierMaxLength}
              onValueChange={(action: string) => {
                onChange({ ...shown, action });
              }}
              placeholder="audit.search"
              size="sm"
              value={shown.action}
            />
          </Field>
          <Field name="actor">
            <FieldLabel>{t`Person or agent ID`}</FieldLabel>
            <Input
              maxLength={identifierMaxLength}
              onValueChange={(actor: string) => {
                onChange({ ...shown, actor });
              }}
              size="sm"
              value={shown.actor}
            />
          </Field>
          <Field name="target">
            <FieldLabel>{t`Target ID`}</FieldLabel>
            <Input
              maxLength={identifierMaxLength}
              onValueChange={(target: string) => {
                onChange({ ...shown, target });
              }}
              size="sm"
              value={shown.target}
            />
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * The filters, as the address has them, in one row over the events.
 * Filtering puts them in the address, which reads the log again.
 */
export const LogFilters = ({ search }: { search: LogSearch }) => {
  const navigate = useNavigate();
  const { t } = useLingui();
  const [shown, setShown] = useState<Shown>(() => shownOf(search));
  const types = typeItems();
  const period: [string, string] | null =
    shown.from === undefined || shown.to === undefined
      ? null
      : [shown.from, shown.to];
  return (
    <form
      aria-label={t`Filters`}
      onSubmit={(event) => {
        event.preventDefault();
        void navigate({
          to: "/settings/audit",
          search: logSearchOf({ ...shown }),
        });
      }}
      {...stylex.props(styles.toolbar)}
    >
      <Select
        items={types}
        onValueChange={(type) => {
          setShown({ ...shown, type: type ?? anyType });
        }}
        value={shown.type}
      >
        <SelectTrigger size="sm" aria-label={t`Type`} layout={styles.type}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent />
      </Select>
      <DateRangePicker
        aria-label={t`When`}
        onValueChange={(range) => {
          setShown({ ...shown, from: range?.[0], to: range?.[1] });
        }}
        rangeLabels={[t`From`, t`To`]}
        size="sm"
        value={period}
      />
      <MoreFilters onChange={setShown} shown={shown} />
      <Button size="sm" type="submit">
        {t`Filter`}
      </Button>
      <Button
        onClick={() => {
          void navigate({ to: "/settings/audit", search: {} });
        }}
        size="sm"
        variant="ghost"
      >
        {t`Clear`}
      </Button>
    </form>
  );
};

/**
 * Where the browser downloads what `search` matches as `format`: core's
 * export route, which it writes to disk as it arrives, however long.
 */
export const exportHref = (
  search: LogSearch,
  format: AuditExportFormat,
  archive = false
): string => {
  const params = new URLSearchParams();
  params.set("format", format);
  if (archive) {
    // With what retention archived, in the chain's order (`AuditApi.export`).
    params.set("archive", "1");
  }
  for (const [name, value] of Object.entries(auditFilterOf(search) ?? {})) {
    if (typeof value === "string") {
      params.set(name, value);
    }
  }
  return `${auditExportPath}?${params.toString()}`;
};

/**
 * Everything the filters match, oldest first, as a download, alone or with
 * the archive: CSV or JSON, the formats core writes it in. Core records the
 * export before it sends anything, and checks the session again as it
 * reads each page.
 */
export const LogExport = ({ search }: { search: LogSearch }) => {
  const { t } = useLingui();
  const download = (format: AuditExportFormat, archive: boolean) => () => {
    // Core sends it as a file to save: the page stays.
    window.location.assign(exportHref(search, format, archive));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger chevron icon={Download} size="sm" variant="ghost">
        {t`Export`}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={download("csv", false)}>
          {t`Export CSV`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={download("json", false)}>
          {t`Export JSON`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={download("csv", true)}>
          {t`Export CSV with the archive`}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={download("json", true)}>
          {t`Export JSON with the archive`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Who did it, by name where the page knows it, and the ID to filter by. */
export const actorOf = (
  actor: AuditActor,
  directory: Directory
): { label: string; id?: string } => {
  if (actor.type === "person") {
    const name = personName(directory, actor.userId);
    if (actor.via !== undefined) {
      const app = chatPlatformName(actor.via);
      return { label: i18n._(msg`${name}, in ${app}`), id: actor.userId };
    }
    return { label: name, id: actor.userId };
  }
  if (actor.type === "staff") {
    const name = personName(directory, actor.userId);
    return { label: i18n._(msg`${name} (Grasp staff)`), id: actor.userId };
  }
  if (actor.type === "agent") {
    const { agentId } = actor;
    const person = personName(directory, actor.onBehalfOf);
    if (actor.via !== undefined) {
      const app = chatPlatformName(actor.via);
      return {
        label: i18n._(msg`Agent ${agentId} for ${person}, in ${app}`),
        id: actor.agentId,
      };
    }
    return {
      label: i18n._(msg`Agent ${agentId} for ${person}`),
      id: actor.agentId,
    };
  }
  if (actor.type === "app") {
    return {
      label: `${appName(directory, actor.appId)} (${actor.part})`,
      id: actor.appId,
    };
  }
  if (actor.type === "workflow") {
    const app = appName(directory, actor.appId);
    const { workflowId } = actor;
    return {
      label: i18n._(msg`${ph({ app })}: run of ${workflowId}`),
      id: actor.runId,
    };
  }
  if (actor.type === "guest") {
    const app = appName(directory, actor.appId);
    const person = personName(directory, actor.invitedBy);
    return {
      label: i18n._(msg`Guest of ${ph({ app })}, invited for ${person}`),
      id: actor.chatId,
    };
  }
  if (actor.type === "visitor") {
    const app = appName(directory, actor.appId);
    return {
      label: i18n._(msg`Visitor of ${ph({ app })}`),
      id: actor.sessionId ?? actor.appId,
    };
  }
  // The platform itself: a name, the same in every language.
  return { label: "Grasp" };
};

/** The event as stored, laid out to read; the stored text if it isn't JSON. */
const readable = (json: string): string => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

/**
 * When an entry was received, short, as the page's language writes it:
 * "3 Oct, 14:05", with its year where it isn't this one.
 */
const entryTime = (iso: string): string => {
  const at = new Date(iso);
  return new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === new Date().getFullYear()
      ? {}
      : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
};

/** What the entry did, in words; the action as recorded where there are none. */
const entryWords = (action: string | undefined): string => {
  if (action === undefined) {
    return i18n._(msg`Unreadable event`);
  }
  const text = actionWords(action);
  return text === undefined ? action : i18n._(text);
};

/** Who did it, a link to the events of the same where it has an ID. */
const EntryWho = ({
  record,
  directory,
}: {
  record: AuditRecord;
  directory: Directory;
}) => {
  const { event } = record;
  const actor = event === null ? undefined : actorOf(event.actor, directory);
  if (actor?.id === undefined) {
    return <span>{actor?.label ?? "–"}</span>;
  }
  return (
    <RouterLink search={{ actor: actor.id }} to="/settings/audit">
      {actor.label}
    </RouterLink>
  );
};

/**
 * An event's position, check, who and what it was about, and the event as
 * stored, for whoever needs more than its sentence.
 */
const RecordDetails = ({
  record,
  directory,
  onClose,
}: {
  record: AuditRecord;
  directory: Directory;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const target = record.event?.target;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{entryWords(record.event?.action)}</DialogTitle>
        <DialogDescription>{entryTime(record.receivedAt)}</DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.details)}>
            <KeyValueList
              items={[
                {
                  key: t`By`,
                  value: <EntryWho directory={directory} record={record} />,
                },
                ...(target === undefined
                  ? []
                  : [
                      {
                        key: t`About`,
                        value: (
                          <RouterLink
                            search={{ target: target.id }}
                            to="/settings/audit"
                          >
                            {`${target.type} ${target.id}`}
                          </RouterLink>
                        ),
                      },
                    ]),
                { key: t`Action`, value: record.event?.action ?? "–" },
                { key: t`Position`, value: String(record.seq) },
                {
                  key: t`Verified`,
                  value: record.verified
                    ? t`Yes: its hash matches, and it links to the event before it.`
                    : t`No: its hash or its link to the event before it doesn't match.`,
                },
                {
                  key: t`Hash`,
                  value: (
                    <CopyField
                      aria-label={t`Copy the hash`}
                      value={record.hash}
                    />
                  ),
                },
              ]}
            />
            <CodeBlock
              code={readable(record.eventJson)}
              copiedLabel={t`Copied`}
              copyLabel={t`Copy the event`}
              language="json"
              lineNumbers={false}
              maxLines={14}
              lessLabel={t`Show less`}
              moreLabel={t`Show more`}
            />
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

/** How many events a page shows. */
const pageSize = 25;

/**
 * The events that match, newest first, 25 a page with Newer and Older:
 * the first of core's pages as the page read it, then each older one asked
 * for once Older reaches past what is here. Keyed by the filters and the
 * first page where it's used, so every new read starts from its own first
 * page. Each event's details open in a Dialog.
 */
export const LogRecords = ({
  first,
  search,
  directory,
  archive = false,
}: {
  first: AuditPage;
  search: LogSearch;
  directory: Directory;
  /** Pages of the archive, where retention moved older events, not of the log. */
  archive?: boolean;
}) => {
  const [older, setOlder] = useState<AuditRecord[]>([]);
  const [next, setNext] = useState(first.next);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState<AuditRecord>();
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const records = [...first.records, ...older];
  const shown = records.slice(at * pageSize, (at + 1) * pageSize);
  // Whether a page lies past this one: one here already, or more in core.
  const hasOlder = records.length > (at + 1) * pageSize || next !== null;
  const goOlder = async (): Promise<void> => {
    // Core's pages hold what it holds (fewer than 25 may match): read on
    // until there is a page past this one, or core has no more. What comes
    // meanwhile fills this page.
    let count = records.length;
    let cursor = next;
    const read: AuditRecord[] = [];
    while (count <= (at + 1) * pageSize && cursor !== null) {
      const before = cursor;
      // oxlint-disable-next-line no-await-in-loop -- one page after the other, by design
      const page = await run(async ({ audit }) =>
        archive
          ? await audit.searchArchive(auditFilterOf(search), before)
          : await audit.search(auditFilterOf(search), before)
      );
      if (page === undefined) {
        break;
      }
      read.push(...page.records);
      count += page.records.length;
      cursor = page.next;
    }
    setOlder((kept) => [...kept, ...read]);
    setNext(cursor);
    if (count > (at + 1) * pageSize) {
      setAt(at + 1);
    }
  };
  if (records.length === 0) {
    return (
      <div {...stylex.props(styles.empty)}>
        <Text size="sm" tone="muted">
          {next === null
            ? t`No events match.`
            : t`No events match in the latest stretch of the log.`}
        </Text>
      </div>
    );
  }
  const firstShown = at * pageSize + 1;
  const lastShown = at * pageSize + shown.length;
  return (
    <>
      <Table density="compact" aria-label={t`Events`}>
        <TableHeader>
          <TableRow>
            <TableHead>{t`When`}</TableHead>
            <TableHead>{t`Event`}</TableHead>
            <TableHead>{t`By`}</TableHead>
            <TableHead align="end">
              <span {...stylex.props(styles.hidden)}>{t`Actions`}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((record) => {
            const { seq } = record;
            return (
              <TableRow key={record.seq}>
                <TableCell>{entryTime(record.receivedAt)}</TableCell>
                <TableCell lead>{entryWords(record.event?.action)}</TableCell>
                <TableCell>
                  <EntryWho directory={directory} record={record} />
                </TableCell>
                <TableCell align="end">
                  <span {...stylex.props(styles.marks)}>
                    {record.verified ? null : (
                      <Badge tone="attention">{t`Not verified`}</Badge>
                    )}
                    {record.type === null ? null : (
                      <Badge>{i18n._(typeLabels[record.type])}</Badge>
                    )}
                    <Button
                      aria-label={t`Details of event ${seq}`}
                      onClick={() => {
                        setOpen(record);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Details`}
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <nav aria-label={t`Pages of events`} {...stylex.props(styles.pager)}>
        <Text size="sm" tone="muted">
          {t`${firstShown}–${lastShown}`}
        </Text>
        <Button
          disabled={at === 0}
          onClick={() => {
            setAt(at - 1);
          }}
          size="sm"
          variant="ghost"
        >
          {t`Newer`}
        </Button>
        <Button
          disabled={!hasOlder || busy}
          onClick={() => {
            void goOlder();
          }}
          size="sm"
          variant="ghost"
        >
          {busy ? t`Loading…` : t`Older`}
        </Button>
      </nav>
      {failure === undefined ? null : (
        <RowAlert variant="danger">{failure}</RowAlert>
      )}
      {open === undefined ? null : (
        <RecordDetails
          directory={directory}
          onClose={() => {
            setOpen(undefined);
          }}
          record={open}
        />
      )}
    </>
  );
};
