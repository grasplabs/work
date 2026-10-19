import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Separator } from "@grasp-os/ui/components/separator";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  GitMergeIcon,
  Link2Icon,
  SearchIcon,
  SearchXIcon,
  StoreIcon,
  UserCheckIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";

import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { downloadCsv } from "./download.ts";
import { FacetedFilter } from "./faceted-filter.tsx";
import type { Facet } from "./faceted-filter.tsx";
import {
  auditActorLabel,
  auditActorTypes,
  auditCategories,
  auditCategoryLabel,
  auditCsv,
  auditFileName,
  auditPageSize,
  eventDate,
  eventDetails,
  eventTime,
  groupByMonth,
  hasAuditFilters,
  matchesAudit,
  noAuditFilters,
  parentOf,
  shortHash,
  visibleCountFor,
} from "./landscape-audit.ts";
import type {
  AppAuditEvent,
  AuditCategory,
  AuditFilters,
} from "./landscape-audit.ts";
import { Facts, Section } from "./section.tsx";

// An app's audit trail, as the prototype draws it
// (`components/landscape/audit/`): every recorded access and permission
// event, newest first, grouped by month, to search, filter, open and
// export. Its events are core's audit log on the app's connections
// (landscape-audit.ts).

export const categoryIcon: Record<AuditCategory, LucideIcon> = {
  detection: EyeIcon,
  access: UserCheckIcon,
  policy: GitMergeIcon,
  ownership: UserRoundIcon,
  vendor: StoreIcon,
};

/** The DOM id of an event on the timeline, to scroll to it. */
const eventElementId = (id: string) => `audit-event-${id}`;

/** How long an event brought into view stays marked, in ms. */
const highlightFor = 2000;

/** Stops a timer that may not be running. */
const stopTimer = (timer: ReturnType<typeof setTimeout> | null) => {
  if (timer !== null) {
    clearTimeout(timer);
  }
};

/** The event's fingerprint, shortened, and a button that copies it in full. */
const CopyFingerprint = ({ hash }: { hash: string }) => {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      stopTimer(timer.current);
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
    stopTimer(timer.current);
    timer.current = setTimeout(() => {
      setCopied("no");
    }, 1500);
  };

  return (
    <Button
      onClick={() => {
        void copy();
      }}
      size="xs"
      variant="ghost"
    >
      {copied === "yes" ? (
        <CheckIcon data-icon="inline-start" />
      ) : (
        <CopyIcon data-icon="inline-start" />
      )}
      {copied === "yes" ? <Trans>Fingerprint copied</Trans> : null}
      {copied === "failed" ? (
        <Trans>Could not copy the fingerprint</Trans>
      ) : null}
      {copied === "no" ? <Trans>Copy fingerprint</Trans> : null}
      <span className="text-muted-foreground font-mono">{shortHash(hash)}</span>
    </Button>
  );
};

/**
 * One event on the timeline: what happened, what changed, who did it and
 * when. Opening it shows the full description, the recorded details, the
 * fingerprint and the event it follows from.
 */
const EventRow = ({
  event,
  parent,
  highlighted,
  onShowParent,
}: {
  event: AppAuditEvent;
  parent: AppAuditEvent | undefined;
  highlighted: boolean;
  onShowParent: (parentId: string) => void;
}) => {
  const { i18n } = useLingui();
  const Icon = categoryIcon[event.category];
  const parentTitle = parent?.title;
  const details = eventDetails(event);
  const labelId = useId();
  const time = eventTime(event.timestamp);
  return (
    <div
      className={
        highlighted
          ? "ring-ring relative scroll-mt-20 rounded-lg pl-12 ring-2 transition-shadow"
          : "relative scroll-mt-20 rounded-lg pl-12 transition-shadow"
      }
      id={eventElementId(event.id)}
    >
      <Collapsible>
        <span
          aria-hidden="true"
          className="bg-card text-muted-foreground absolute top-3 left-0 flex size-8 items-center justify-center rounded-full border"
        >
          <Icon className="size-4" />
        </span>

        <CollapsibleTrigger
          render={
            <button
              aria-labelledby={`${labelId}-title ${labelId}-when ${labelId}-by`}
              className="group/event hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full flex-wrap items-start gap-x-4 gap-y-1.5 rounded-lg py-3 pr-2 pl-3 text-left outline-none focus-visible:ring-3"
              type="button"
            />
          }
        >
          {/* What happened keeps a width of its own: on a phone when and by whom go under it, rather than squeezing it to nothing. */}
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <span className="font-medium" id={`${labelId}-title`}>
                {event.title}
              </span>
              {parent === undefined ? null : (
                <>
                  <Link2Icon
                    aria-hidden="true"
                    className="text-muted-foreground size-3 shrink-0"
                  />
                  <span className="sr-only">
                    <Trans>Follows from another event</Trans>
                  </span>
                </>
              )}
            </div>
            <p className="text-muted-foreground line-clamp-1">
              {event.description}
            </p>
            {event.oldValue === undefined &&
            event.newValue === undefined ? null : (
              <div className="flex flex-wrap items-center gap-1.5">
                {event.oldValue === undefined ? null : (
                  <span className="text-muted-foreground line-through">
                    <span className="sr-only">
                      <Trans comment="Read by screen readers before the old value.">
                        Before:
                      </Trans>{" "}
                    </span>
                    {event.oldValue}
                  </span>
                )}
                {event.oldValue !== undefined &&
                event.newValue !== undefined ? (
                  <span aria-hidden="true" className="text-muted-foreground">
                    →
                  </span>
                ) : null}
                {event.newValue === undefined ? null : (
                  <span className="font-medium">
                    <span className="sr-only">
                      <Trans comment="Read by screen readers before the new value.">
                        After:
                      </Trans>{" "}
                    </span>
                    {event.newValue}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col items-end gap-1.5">
            <span
              className="text-muted-foreground text-right tabular-nums"
              id={`${labelId}-when`}
            >
              {eventDate(event.timestamp)}
              {time === "" ? "" : ` ${time}`}
            </span>
            <div className="flex items-center gap-1.5" id={`${labelId}-by`}>
              <span className="text-muted-foreground">{event.actor}</span>
              <Badge
                variant={event.actorType === "human" ? "outline" : "secondary"}
              >
                {i18n._(auditActorLabel[event.actorType])}
              </Badge>
            </div>
          </div>

          <ChevronDownIcon
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 ml-auto size-4 shrink-0 transition-transform group-aria-expanded/event:rotate-180"
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="bg-muted/50 mt-1 mb-3 ml-3 flex flex-col gap-4 rounded-lg p-4">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                {i18n._(auditCategoryLabel[event.category])}
              </span>
              <p>{event.description}</p>
            </div>

            {details.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">
                  <Trans>Recorded details</Trans>
                </span>
                <Facts facts={details} />
              </div>
            ) : null}

            {event.hash === undefined && parent === undefined ? null : (
              <div className="flex flex-wrap items-center gap-2">
                {event.hash === undefined ? null : (
                  <CopyFingerprint hash={event.hash} />
                )}
                {parent === undefined ? null : (
                  <Button
                    onClick={() => {
                      onShowParent(parent.id);
                    }}
                    size="xs"
                    variant="ghost"
                  >
                    <ArrowUpRightIcon data-icon="inline-start" />
                    <Trans>Follows from: {parentTitle}</Trans>
                  </Button>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

/** Why the timeline is empty: nothing matches, nothing in the stretch read, or nothing yet. */
const NoEvents = ({
  appName,
  narrowed,
  older,
  onClear,
}: {
  appName: string;
  narrowed: boolean;
  older: boolean;
  onClear: () => void;
}) => {
  let title: ReactNode = <Trans>No events yet</Trans>;
  let description: ReactNode = (
    <Trans>
      Access and permission changes on {appName} show up here as they are
      recorded.
    </Trans>
  );
  if (narrowed) {
    title = <Trans>No events match</Trans>;
    description = (
      <Trans>
        Try another search, or clear the filters to see the whole trail.
      </Trans>
    );
  } else if (older) {
    title = <Trans>No events in the latest stretch of the log</Trans>;
    description = <Trans>Show older events to read further back.</Trans>;
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {narrowed ? <SearchXIcon /> : <ClipboardListIcon />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {narrowed ? (
        <EmptyContent>
          <Button onClick={onClear} size="sm" variant="outline">
            <Trans>Clear search and filters</Trans>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
};

/**
 * Below the timeline: more of what's read, then older events to read, and
 * the end of the trail once there's nothing older left.
 */
const TrailEnd = ({
  shown,
  visible,
  older,
  busy,
  failure,
  onShowMore,
  onShowOlder,
}: {
  /** How many events match. */
  shown: number;
  /** How many of those are in view. */
  visible: number;
  older: boolean;
  busy: boolean;
  failure: string | undefined;
  onShowMore: () => void;
  onShowOlder: () => void;
}) => {
  const { t } = useLingui();
  const matching = shown;
  const shownCount = formatNumber(shown);
  const showing = formatNumber(visible);
  const more = formatNumber(Math.min(auditPageSize, shown - visible));
  if (shown === 0 && !older) {
    return null;
  }
  let end: ReactNode = (
    <p className="text-muted-foreground text-center text-xs tabular-nums">
      {t`${plural(matching, { one: "End of the audit trail · # event", other: "End of the audit trail · # events" })}`}
    </p>
  );
  if (visible < shown) {
    end = (
      <div className="flex items-center justify-center gap-3">
        <span className="text-muted-foreground tabular-nums">
          <Trans>
            Showing {showing} of {shownCount}
          </Trans>
        </span>
        <Button onClick={onShowMore} size="sm" variant="outline">
          <Trans>Show {more} more</Trans>
        </Button>
      </div>
    );
  } else if (older) {
    end = (
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">
          <Trans>Older events haven&apos;t been read yet.</Trans>
        </span>
        <Button
          disabled={busy}
          onClick={onShowOlder}
          size="sm"
          variant="outline"
        >
          {busy ? <Trans>Loading…</Trans> : <Trans>Show older</Trans>}
        </Button>
      </div>
    );
  }
  return (
    <>
      <Separator />
      {end}
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/**
 * The audit trail of an app: every recorded access and permission event,
 * newest first, grouped by month, to search, filter, open and export. The
 * log is read a stretch at a time: older events show as asked for, and an
 * export reads the whole trail first.
 */
export const AuditTrail = ({
  appName,
  events,
  older,
  busy,
  failure,
  onShowOlder,
  readWhole,
}: {
  appName: string;
  /** The events read so far. */
  events: readonly AppAuditEvent[];
  /** Whether older events may be left to read. */
  older: boolean;
  /** Whether a read is under way. */
  busy: boolean;
  /** Why the last read didn't go through. */
  failure: string | undefined;
  onShowOlder: () => void;
  /** Reads the rest of the trail: all its events, or nothing when that failed. */
  readWhole: () => Promise<readonly AppAuditEvent[] | undefined>;
}) => {
  const { t, i18n } = useLingui();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<AuditFilters>(noAuditFilters);
  const [filterOpen, setFilterOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(auditPageSize);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      stopTimer(highlightTimer.current);
    },
    []
  );

  const shown = events.filter((event) => matchesAudit(event, filters, query));
  const visible = shown.slice(0, visibleCount);
  const narrowed = hasAuditFilters(filters, query);
  const total = events.length;
  const shownCount = formatNumber(shown.length);

  const changeQuery = (next: string) => {
    setQuery(next);
    setVisibleCount(auditPageSize);
  };
  const changeFilters = (next: AuditFilters) => {
    setFilters(next);
    setVisibleCount(auditPageSize);
  };
  /** Every event that matches, the whole trail read first, as a file. */
  const exportCsv = async () => {
    const all = older ? await readWhole() : events;
    if (all === undefined) {
      return;
    }
    downloadCsv(
      auditCsv(
        all.filter((event) => matchesAudit(event, filters, query)),
        all
      ),
      auditFileName(appName)
    );
  };
  const clearAll = () => {
    setQuery("");
    changeFilters(noAuditFilters);
  };

  /** Brings an event into view, clearing the filters when they hide it, and marks it for a moment. */
  const showEvent = (id: string) => {
    const inView = shown.some((event) => event.id === id);
    const list = inView ? shown : events;
    const index = list.findIndex((event) => event.id === id);
    if (index === -1) {
      return;
    }
    flushSync(() => {
      if (!inView) {
        setQuery("");
        setFilters(noAuditFilters);
      }
      setVisibleCount((current) =>
        visibleCountFor(index, inView ? current : auditPageSize)
      );
      setHighlighted(id);
    });
    document
      .querySelector(`#${CSS.escape(eventElementId(id))}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    stopTimer(highlightTimer.current);
    highlightTimer.current = setTimeout(() => {
      setHighlighted(null);
    }, highlightFor);
  };

  const countOf = (predicate: (event: AppAuditEvent) => boolean) =>
    events.filter(predicate).length;
  const facets: Facet[] = [
    {
      key: "actor",
      title: t`Recorded by`,
      selected: filters.actor,
      options: auditActorTypes.map((value) => ({
        value,
        label: i18n._(auditActorLabel[value]),
        count: countOf((event) => event.actorType === value),
      })),
    },
    {
      key: "category",
      title: t({
        message: "Category",
        context: "filter: category of an audit event",
      }),
      selected: filters.category,
      options: auditCategories.map((value) => {
        const Icon = categoryIcon[value];
        return {
          value,
          label: i18n._(auditCategoryLabel[value]),
          icon: <Icon className="text-muted-foreground" />,
          count: countOf((event) => event.category === value),
        };
      }),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Section
        description={t`Every recorded access and permission event, most recent first.`}
        title={t`Event timeline`}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-64">
              <InputGroup>
                <InputGroupInput
                  aria-label={t`Search events`}
                  onChange={(event) => {
                    changeQuery(event.target.value);
                  }}
                  placeholder={t`Search events`}
                  value={query}
                />
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
              </InputGroup>
            </div>
            <span className="text-muted-foreground tabular-nums">
              {shown.length === total
                ? t`${plural(total, { one: "# event", other: "# events" })}`
                : t`${plural(total, { one: `${shownCount} of # event`, other: `${shownCount} of # events` })}`}
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <FacetedFilter
                facets={facets}
                onChange={(key, selected) => {
                  changeFilters({ ...filters, [key]: selected });
                }}
                onClear={() => {
                  changeFilters(noAuditFilters);
                }}
                onOpenChange={setFilterOpen}
                open={filterOpen}
              />
              <Button
                disabled={busy || (shown.length === 0 && !older)}
                onClick={() => {
                  void exportCsv();
                }}
                size="sm"
                variant="ghost"
              >
                <DownloadIcon data-icon="inline-start" />
                <Trans>Export CSV</Trans>
              </Button>
            </div>
          </div>

          {shown.length === 0 ? (
            <NoEvents
              appName={appName}
              narrowed={narrowed}
              older={older}
              onClear={clearAll}
            />
          ) : (
            <div className="relative flex flex-col">
              <span
                aria-hidden="true"
                className="bg-border absolute top-0 bottom-0 left-4 w-px"
              />
              {groupByMonth(visible).map((month) => (
                <section
                  aria-label={month.label}
                  className="flex flex-col"
                  key={month.month}
                >
                  <h3 className="text-muted-foreground py-2 pl-12 text-xs">
                    {month.label}
                  </h3>
                  <ol className="flex flex-col">
                    {month.events.map((event) => (
                      <li key={event.id}>
                        <EventRow
                          event={event}
                          highlighted={highlighted === event.id}
                          onShowParent={showEvent}
                          parent={parentOf(event, events)}
                        />
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
            </div>
          )}

          <TrailEnd
            busy={busy}
            failure={failure}
            older={older}
            onShowMore={() => {
              setVisibleCount((current) => current + auditPageSize);
            }}
            onShowOlder={onShowOlder}
            shown={shown.length}
            visible={visible.length}
          />
        </div>
      </Section>
    </div>
  );
};
