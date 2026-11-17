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
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import { DateRangePicker } from "../grasp/date-range-picker/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import {
  Agent,
  AppWindow,
  ChevronRight,
  Download,
  Icon,
  Person,
  Search,
  Sliders,
  System,
  Workflow,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Popover,
  PopoverAction,
  PopoverContent,
  PopoverFooter,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { RowAlert } from "../settings/section.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { actionWords } from "./audit-words.ts";
import { logSearchOf } from "./log-search.ts";
import type { LogSearch } from "./log-search.ts";
import { typeLabels } from "./type-labels.ts";

// The audit log, for admins, on Grasp UI: its events newest first in a
// Data table, 25 a page, narrowed by the filters in the page's address.
// Over the table, the Data table's own kind of bar: one search (a person
// by name, or any ID), one Filters control that holds the rest (type,
// dates, action, what it was about, and the archive in place of the log),
// and Export at the end. Each event's details open beside the table
// (audit-event.tsx). Core records every search and export in the log
// itself.

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

/** The first page of what `search` matches: in the log, or in the archive where it asks for that. */
export const readLog = async (
  session: Session,
  search: LogSearch
): Promise<LogPage> => {
  const filter = auditFilterOf(search);
  const [page, directory] = await Promise.all([
    search.archive === true
      ? session.audit.searchArchive(filter)
      : session.audit.search(filter),
    readDirectory(session),
  ]);
  return { page, directory };
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
  // The bar over the table, as the Data table's own: the search, then
  // Filters, then Export at the end; it wraps on a phone.
  bar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space3,
    paddingInline: grasp.tableCellInline,
    paddingBlock: grasp.space3,
  },
  search: { flexGrow: 1, maxWidth: "20rem", minWidth: "12rem" },
  end: { marginInlineStart: "auto" },
  filters: { display: "grid", gap: grasp.space4 },
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
  // What the event did, and its mark where it didn't verify, on one line.
  event: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  // Who did it: a face (or what kind of actor it is) before the name.
  who: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  // The kind's icon, in the room a face takes.
  kind: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: grasp.avatarXs,
    height: grasp.avatarXs,
    color: grasp.muted,
    [iconVars.size]: grasp.iconSm,
  },
});

/** The filters as the Filters control holds them while they are set. */
interface Shown {
  type: string;
  action: string;
  target: string;
  from: string | undefined;
  to: string | undefined;
  archive: boolean;
}

/** The filters as the address has them, ready to set. */
const shownOf = (search: LogSearch): Shown => ({
  type: search.type ?? anyType,
  action: search.action ?? "",
  target: search.target ?? "",
  from: search.from,
  to: search.to,
  archive: search.archive === true,
});

/** How many of the Filters control's filters the address sets. */
const filtersSet = (search: LogSearch): number =>
  [
    search.type,
    search.from ?? search.to,
    search.action,
    search.target,
    search.archive,
  ].filter((value) => value !== undefined).length;

/**
 * The person `text` names, by their whole name or the one name it is part
 * of; otherwise the text itself, as an ID (a person's, an agent's, an
 * App's or a run's), which is what core filters by.
 */
const actorFor = (text: string, directory: Directory): string | undefined => {
  const wanted = text.trim().toLocaleLowerCase(i18n.locale);
  if (wanted === "") {
    return undefined;
  }
  const people = [...directory.people];
  const named = (part: boolean) =>
    people.filter(([, name]) => {
      const own = name.toLocaleLowerCase(i18n.locale);
      return part ? own.includes(wanted) : own === wanted;
    });
  const [whole] = named(false);
  if (whole !== undefined) {
    return whole[0];
  }
  const parts = named(true);
  const [only] = parts;
  return parts.length === 1 && only !== undefined ? only[0] : text.trim();
};

/**
 * The search: who did it, by a person's name or any ID. Enter searches;
 * clearing it shows everyone's events again.
 */
const LogSearchField = ({
  search,
  directory,
}: {
  search: LogSearch;
  directory: Directory;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const known =
    search.actor === undefined ? undefined : directory.people.get(search.actor);
  const [text, setText] = useState(known ?? search.actor ?? "");
  const go = (next: string): void => {
    void navigate({
      to: "/settings/audit",
      search: logSearchOf({ ...search, actor: actorFor(next, directory) }),
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        go(text);
      }}
      {...stylex.props(styles.search)}
    >
      <InputGroup>
        <InputGroupText>
          <Icon icon={Search} />
        </InputGroupText>
        <InputGroupInput
          aria-label={t`Search events by person or ID`}
          maxLength={identifierMaxLength}
          onValueChange={(value: string) => {
            setText(value);
            // Cleared: everyone's events again.
            if (value === "" && search.actor !== undefined) {
              go("");
            }
          }}
          placeholder={t`Person or ID`}
          type="search"
          value={text}
        />
        <InputGroupClear aria-label={t`Clear the search`} />
      </InputGroup>
    </form>
  );
};

/**
 * Filters: the type, the dates and the archive in place of the log, set
 * together and shown at once; its trigger counts those set. The action
 * and what an event was about are set from an event's details, and show
 * here while they are set, to change or clear.
 */
const LogFiltersControl = ({ search }: { search: LogSearch }) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [shown, setShown] = useState<Shown>(() => shownOf(search));
  const set = filtersSet(search);
  const period: [string, string] | null =
    shown.from === undefined || shown.to === undefined
      ? null
      : [shown.from, shown.to];
  const show = (next?: Shown): void => {
    void navigate({
      to: "/settings/audit",
      search: logSearchOf(
        next === undefined
          ? { actor: search.actor }
          : {
              actor: search.actor,
              type: next.type === anyType ? undefined : next.type,
              action: next.action,
              target: next.target,
              from: next.from,
              to: next.to,
              archive: next.archive ? true : undefined,
            }
      ),
    });
  };
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          setShown(shownOf(search));
        }
      }}
    >
      <PopoverTrigger icon={Sliders} size="md" variant="quiet">
        {set === 0
          ? t`Filters`
          : t`${plural(set, { one: "Filters, # set", other: "Filters, # set" })}`}
      </PopoverTrigger>
      <PopoverContent align="start">
        <div {...stylex.props(styles.filters)}>
          <Field name="type">
            <FieldLabel>{t`Type`}</FieldLabel>
            <Select
              items={typeItems()}
              onValueChange={(type) => {
                setShown({ ...shown, type: type ?? anyType });
              }}
              value={shown.type}
            >
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </Field>
          <Field name="when">
            <FieldLabel>{t`When`}</FieldLabel>
            <DateRangePicker
              onValueChange={(range) => {
                setShown({ ...shown, from: range?.[0], to: range?.[1] });
              }}
              rangeLabels={[t`From`, t`To`]}
              formatLabels={[
                t({ message: "dd", context: "a date's day, as typed" }),
                t({ message: "mm", context: "a date's month, as typed" }),
                t({ message: "yyyy", context: "a date's year, as typed" }),
              ]}
              presetLabels={[
                t`Today`,
                t`Last 7 days`,
                t`Last 30 days`,
                t`This month`,
              ]}
              presetsLabel={t`Presets`}
              previousLabel={t`Previous month`}
              nextLabel={t`Next month`}
              triggerLabel={t`Choose dates`}
              size="sm"
              value={period}
            />
          </Field>
          {/* Set from an event's details ("Find similar"): shown only while set. */}
          {search.action === undefined ? null : (
            <Field name="action">
              <FieldLabel>{t`Action`}</FieldLabel>
              <Input
                maxLength={identifierMaxLength}
                onValueChange={(action: string) => {
                  setShown({ ...shown, action });
                }}
                size="sm"
                value={shown.action}
              />
            </Field>
          )}
          {/* Set from an event's details ("Events about this"): shown only while set. */}
          {search.target === undefined ? null : (
            <Field name="target">
              <FieldLabel>{t`About, by ID`}</FieldLabel>
              <Input
                maxLength={identifierMaxLength}
                onValueChange={(target: string) => {
                  setShown({ ...shown, target });
                }}
                size="sm"
                value={shown.target}
              />
            </Field>
          )}
          <Switch
            checked={shown.archive}
            label={t`Search the archive`}
            onCheckedChange={(archive: boolean) => {
              setShown({ ...shown, archive });
            }}
          />
        </div>
        <PopoverFooter>
          <PopoverAction
            action={() => {
              show();
            }}
            failedLabel={t`Could not clear`}
            variant="ghost"
          >
            {t`Clear`}
          </PopoverAction>
          <PopoverAction
            action={() => {
              show(shown);
            }}
            failedLabel={t`Could not show them`}
            variant="ink"
          >
            {t`Show events`}
          </PopoverAction>
        </PopoverFooter>
      </PopoverContent>
    </Popover>
  );
};

/**
 * Everything the filters match, oldest first, as a download: CSV or JSON,
 * the formats core writes it in, with the archive where the filters search
 * it. Core records the export before it sends anything, and checks the
 * session again as it reads each page.
 */
const LogExport = ({ search }: { search: LogSearch }) => {
  const { t } = useLingui();
  const archive = search.archive === true;
  const download = (format: AuditExportFormat) => () => {
    // Core sends it as a file to save: the page stays.
    window.location.assign(exportHref(search, format, archive));
  };
  return (
    <span {...stylex.props(styles.end)}>
      <DropdownMenu>
        <DropdownMenuTrigger chevron icon={Download} size="md" variant="quiet">
          {t`Export`}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={download("csv")}>
            {archive ? t`CSV, with the archive` : t`CSV`}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={download("json")}>
            {archive ? t`JSON, with the archive` : t`JSON`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
};

/** The bar over the events: the search, Filters, and Export at the end. */
export const LogBar = ({
  search,
  directory,
}: {
  search: LogSearch;
  directory: Directory;
}) => (
  <div {...stylex.props(styles.bar)}>
    <LogSearchField directory={directory} search={search} />
    <LogFiltersControl search={search} />
    <LogExport search={search} />
  </div>
);

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
export const readable = (json: string): string => {
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
export const entryTime = (iso: string): string => {
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
export const entryWords = (action: string | undefined): string => {
  if (action === undefined) {
    return i18n._(msg`Unreadable event`);
  }
  const text = actionWords(action);
  return text === undefined ? action : i18n._(text);
};

/** The icon for who did it, where they have no face: an agent, an App, a run, Grasp. */
export const actorIcon = (actor: AuditActor): IconData => {
  switch (actor.type) {
    case "agent": {
      return Agent;
    }
    case "app":
    case "visitor": {
      return AppWindow;
    }
    case "workflow": {
      return Workflow;
    }
    case "system": {
      return System;
    }
    case "person":
    case "staff":
    case "guest": {
      return Person;
    }
    default: {
      return actor satisfies never;
    }
  }
};

/** Who did it: a person's face, or their kind's icon, before the name. */
const EntryWho = ({
  record,
  directory,
}: {
  record: AuditRecord;
  directory: Directory;
}) => {
  const { event } = record;
  if (event === null) {
    return <span>–</span>;
  }
  const { actor } = event;
  const { label } = actorOf(actor, directory);
  const face =
    actor.type === "person" || actor.type === "staff"
      ? personName(directory, actor.userId)
      : undefined;
  return (
    <span {...stylex.props(styles.who)}>
      {face === undefined ? (
        <span {...stylex.props(styles.kind)}>
          <Icon icon={actorIcon(actor)} />
        </span>
      ) : (
        <Avatar name={face} size="xs">
          <AvatarFallback />
        </Avatar>
      )}
      <span>{label}</span>
    </span>
  );
};

/** How many events a page shows. */
const pageSize = 25;

/** The words the columns say, translated where they are made. */
interface EventColumnWords {
  when: string;
  event: string;
  by: string;
  type: string;
  details: string;
  notVerified: string;
  detailsOf: (seq: number) => string;
}

/** What kind of event it is (a read, an action, a decision…): words, not a badge, so nothing in the row looks pressable but its button. */
const typeColumn = (header: string): DataTableColumn<AuditRecord> => ({
  key: "type",
  header,
  value: (record) => record.type ?? "",
  cell: (record) =>
    record.type === null ? (
      "–"
    ) : (
      <Text element="span" size="sm" tone="muted">
        {i18n._(typeLabels[record.type])}
      </Text>
    ),
});

/**
 * The events table's columns, as Data table takes them: when, what (with
 * a mark where it didn't verify), by whom, its type, and a way to its
 * details.
 */
const columns = ({
  directory,
  onDetails,
  withType,
  words,
}: {
  directory: Directory;
  onDetails: (record: AuditRecord) => void;
  /** Without it while the details stand beside the table, which say the type. */
  withType: boolean;
  words: EventColumnWords;
}): DataTableColumn<AuditRecord>[] => [
  {
    key: "when",
    header: words.when,
    value: (record) => record.receivedAt,
    cell: (record) => entryTime(record.receivedAt),
  },
  {
    key: "event",
    header: words.event,
    value: (record) => record.event?.action ?? "",
    cell: (record) => (
      <span {...stylex.props(styles.event)}>
        {entryWords(record.event?.action)}
        {record.verified ? null : (
          <Badge size="sm" tone="attention">
            {words.notVerified}
          </Badge>
        )}
      </span>
    ),
  },
  {
    key: "by",
    header: words.by,
    value: (record) => record.event?.actor.type ?? "",
    cell: (record) => <EntryWho directory={directory} record={record} />,
  },
  ...(withType ? [typeColumn(words.type)] : []),
  {
    key: "details",
    header: words.details,
    align: "end",
    control: true,
    value: () => "",
    cell: (record) => (
      <Button
        aria-label={words.detailsOf(record.seq)}
        icon={ChevronRight}
        onClick={() => {
          onDetails(record);
        }}
        size="xs"
        variant="ghost"
      />
    ),
  },
];

/**
 * The events that match, newest first, 25 a page with Newer and Older:
 * the first of core's pages as the page read it, then each older one asked
 * for once Older reaches past what is here. Keyed by the filters and the
 * first page where it's used, so every new read starts from its own first
 * page. An event's details open beside the table (`onDetails`).
 */
export const LogRecords = ({
  first,
  search,
  directory,
  onDetails,
  beside = false,
}: {
  first: AuditPage;
  search: LogSearch;
  directory: Directory;
  onDetails: (record: AuditRecord) => void;
  /** The details stand beside the table, so it leaves out what they say. */
  beside?: boolean;
}) => {
  const [older, setOlder] = useState<AuditRecord[]>([]);
  const [next, setNext] = useState(first.next);
  const [at, setAt] = useState(0);
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const records = [...first.records, ...older];
  const shown = records.slice(at * pageSize, (at + 1) * pageSize);
  // Whether a page lies past this one: one here already, or more in core.
  const hasOlder = records.length > (at + 1) * pageSize || next !== null;
  const archive = search.archive === true;
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
  const eventColumns = columns({
    directory,
    onDetails,
    withType: !beside,
    words: {
      when: t`When`,
      event: t`Event`,
      by: t`By`,
      type: t`Type`,
      details: t`Details`,
      notVerified: t`Not verified`,
      detailsOf: (seq) => t`Details of event ${seq}`,
    },
  });
  const firstShown = at * pageSize + 1;
  const lastShown = at * pageSize + shown.length;
  return (
    <>
      {/* One page of the log at a time: Newer and Older below page through core's. */}
      <DataTable
        columns={eventColumns}
        density="compact"
        label={archive ? t`Archived events` : t`Events`}
        rowKey={(record) => String(record.seq)}
        rows={shown}
      />
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
    </>
  );
};
