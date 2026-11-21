// DraftDay: the day around an event draft, small (inside the draft folder; not exported until a
// second part needs it). The hours down the side, one lane per person with their face and name,
// their busy time as a quiet hatch, and the event as one block across every lane. The day's date
// is the when row's (event.tsx), not said twice. An event past midnight runs to the day's foot,
// the window reaching the hour after it ends. Where the
// event meets someone's busy time the block says "Conflicts" in words, never by colour alone.
"use client";

import * as stylex from "@stylexjs/stylex";

import { visuallyHidden } from "../hidden/hidden";
import { Alert, Icon } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";
import type { DraftPerson } from "./draft";
import { DraftFace, draftKeys, useDraftWords } from "./draft";

/** A stretch of busy time, ISO start and end. */
export interface DraftBusy {
  start: string;
  end: string;
}

/** A lane: a person and their busy time that day. */
export interface DraftLane {
  person: DraftPerson;
  busy?: readonly DraftBusy[];
}

const HOUR = 3_600_000;
/** The draft's own narrow width (draft.tsx): its body's inset is space-3 there. */
const NARROW = "@container draft (width < 30rem)";

const styles = stylex.create({
  // Flush with the card's sides, between two hairlines: part of the draft, never a card inside it.
  root: {
    display: "grid",
    minWidth: 0,
    margin: 0,
    marginInline: {
      default: `calc(-1 * ${grasp.space4})`,
      [NARROW]: `calc(-1 * ${grasp.space3})`,
    },
    borderBlockWidth: grasp.hairline,
    borderBlockStyle: "solid",
    borderBlockColor: grasp.line,
    overflow: "clip",
  },
  grid: {
    display: "grid",
    minWidth: 0,
  },
  lanes: (count: number) => ({
    gridTemplateColumns: `${grasp.draftScale} repeat(${count}, minmax(0, 1fr))`,
  }),
  // A lane's head: the person's face and name, on the lane's centre.
  laneHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: grasp.space1,
    minWidth: 0,
    paddingBlock: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.ink,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  laneName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  corner: {
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  // The hours: the scale, the lanes and the event's layer share one area.
  hours: {
    position: "relative",
    gridColumn: "1 / -1",
    display: "grid",
    gridTemplateColumns: "subgrid",
  },
  tall: (hours: number) => ({ height: `calc(${grasp.draftHour} * ${hours})` }),
  scale: { position: "relative" },
  tick: {
    position: "absolute",
    insetInlineEnd: grasp.space2,
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    transform: "translateY(-50%)",
    fontVariantNumeric: "tabular-nums",
  },
  // The first and the last hour stay inside the day, at its top and its foot.
  tickFirst: { transform: "none" },
  tickLast: { transform: "translateY(-100%)" },
  at: (fraction: number) => ({ top: `calc(${grasp.draftHour} * ${fraction})` }),
  lane: {
    position: "relative",
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  // An hour's line across the lanes.
  rule: {
    position: "absolute",
    insetInline: 0,
    height: 0,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  busy: {
    position: "absolute",
    insetInline: grasp.space1,
    borderRadius: grasp.cornerMark,
    backgroundColor: { default: grasp.soft, [media.forced]: "Canvas" },
    backgroundImage: `repeating-linear-gradient(135deg, ${grasp.line} 0 ${grasp.hairline}, transparent ${grasp.hairline} ${grasp.draftHatch})`,
    outline: { default: "none", [media.forced]: "1px dashed GrayText" },
  },
  span: (top: number, height: number) => ({
    top: `calc(${grasp.draftHour} * ${top})`,
    height: `calc(${grasp.draftHour} * ${height})`,
  }),
  // The event: one block across every lane, on the soft fill with the ink's edge at its start.
  event: {
    position: "absolute",
    insetInlineStart: `calc(${grasp.draftScale} + ${grasp.space1})`,
    insetInlineEnd: grasp.space1,
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: 0,
    paddingBlock: grasp.space1,
    paddingInline: grasp.space2,
    zIndex: 1,
    borderRadius: grasp.cornerMark,
    // Opaque: the soft fill over the card's own ground, so no lane's divider or hour shows through.
    backgroundColor: grasp.raised,
    backgroundImage: `linear-gradient(${grasp.soft}, ${grasp.soft})`,
    // The ink's mark at its start edge, which turns with the writing (a border, not a shadow).
    borderInlineStartWidth: `calc(${grasp.space1} - ${grasp.hairline})`,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.ink,
    boxShadow: grasp.edge,
    overflow: "hidden",
    outline: { default: "none", [media.forced]: "2px solid Highlight" },
  },
  // The title and its time on one line, so half an hour holds them.
  eventWords: {
    display: "flex",
    alignItems: "baseline",
    gap: grasp.space2,
    minWidth: 0,
    paddingInlineStart: grasp.space1,
  },
  eventTitle: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  eventTime: {
    flexShrink: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  // The event's old slot (a change, EventChangeDraft): a dashed outline under the new block, its
  // time quiet and struck. The new block, opaque, covers it where they meet.
  ghost: {
    position: "absolute",
    insetInlineStart: `calc(${grasp.draftScale} + ${grasp.space1})`,
    insetInlineEnd: grasp.space1,
    boxSizing: "border-box",
    paddingBlock: grasp.space1,
    paddingInline: grasp.space3,
    borderRadius: grasp.cornerMark,
    borderWidth: grasp.hairline,
    borderStyle: "dashed",
    borderColor: grasp.muted,
    overflow: "hidden",
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
    textDecorationLine: "line-through",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  },
  conflicts: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.ink,
  },
});

/** Hours since the window's start, as a fraction of hours. */
const hoursFrom = (from: number, iso: string) =>
  (Date.parse(iso) - from) / HOUR;

/** The most hours the day shows to hold an old slot beside the new: past it, the when row says it. */
const GHOST_HOURS = 8;

/** The calendar day an ISO time falls on, in the zone given ("2026-11-20"). */
const dayOf = (iso: string, timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date(iso));

/** The old slot, kept beside the new when it is the same day and the two fit a short day. */
const ghostOf = (
  start: string,
  end: string,
  was: DraftBusy | undefined,
  timeZone: string | undefined
) => {
  const span =
    was === undefined
      ? 0
      : Math.max(Date.parse(end), Date.parse(was.end)) -
        Math.min(Date.parse(start), Date.parse(was.start));
  const kept =
    was !== undefined &&
    dayOf(was.start, timeZone) === dayOf(start, timeZone) &&
    span / HOUR <= GHOST_HOURS;
  return kept ? was : undefined;
};

/**
 * The event's day, around it: from the whole hour before it to the whole hour half an hour after.
 * With `was` (a change), the old slot too, as a dashed ghost, when it is the same day.
 */
export const DraftDay = ({
  title,
  start,
  end,
  lanes,
  timeZone,
  was,
}: {
  title: string;
  start: string;
  end: string;
  lanes: readonly DraftLane[];
  timeZone?: string;
  was?: DraftBusy;
}) => {
  const words = useDraftWords("event");
  const frame = useDraftWords("frame");
  const change = useDraftWords("eventChange");
  const ghost = ghostOf(start, end, was, timeZone);
  const first =
    ghost === undefined
      ? Date.parse(start)
      : Math.min(Date.parse(start), Date.parse(ghost.start));
  const last =
    ghost === undefined
      ? Date.parse(end)
      : Math.max(Date.parse(end), Date.parse(ghost.end));
  const from = Math.floor(first / HOUR) * HOUR - HOUR;
  const to = Math.ceil((last + HOUR / 2) / HOUR) * HOUR;
  const hours = Math.round((to - from) / HOUR);
  const top = hoursFrom(from, start);
  const height = hoursFrom(from, end) - top;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  const keys = draftKeys(lanes.map((lane) => lane.person));
  const meets = lanes.some((lane) =>
    (lane.busy ?? []).some(
      (busy) =>
        Date.parse(busy.start) < Date.parse(end) &&
        Date.parse(busy.end) > Date.parse(start)
    )
  );
  return (
    <figure
      aria-label={words.day}
      data-slot="draft-day"
      {...stylex.props(styles.root)}
    >
      <div {...stylex.props(styles.grid, styles.lanes(lanes.length))}>
        <span aria-hidden="true" {...stylex.props(styles.corner)} />
        {lanes.map((lane, index) => (
          <span key={keys[index]} {...stylex.props(styles.laneHead)}>
            <DraftFace person={lane.person} />
            <span {...stylex.props(styles.laneName)}>
              {lane.person.you === true ? frame.you : lane.person.name}
            </span>
          </span>
        ))}
        <div {...stylex.props(styles.hours, styles.tall(hours))}>
          <div aria-hidden="true" {...stylex.props(styles.scale)}>
            {Array.from({ length: hours + 1 }, (_, index) => (
              <p
                key={index}
                {...stylex.props(
                  styles.tick,
                  styles.at(index),
                  index === 0 && styles.tickFirst,
                  index === hours && styles.tickLast
                )}
              >
                {words.time(
                  new Date(from + index * HOUR).toISOString(),
                  timeZone
                )}
              </p>
            ))}
          </div>
          {lanes.map((lane, laneIndex) => {
            const name =
              lane.person.you === true ? frame.you : lane.person.name;
            return (
              <div key={keys[laneIndex]} {...stylex.props(styles.lane)}>
                {Array.from({ length: hours - 1 }, (_, index) => (
                  <span
                    key={index}
                    aria-hidden="true"
                    {...stylex.props(styles.rule, styles.at(index + 1))}
                  />
                ))}
                {(lane.busy ?? []).map((busy, busyIndex) => {
                  const at = Math.max(0, hoursFrom(from, busy.start));
                  const until = Math.min(hours, hoursFrom(from, busy.end));
                  return until <= at ? null : (
                    <span
                      key={`${busy.start}#${busyIndex}`}
                      {...stylex.props(
                        styles.busy,
                        styles.span(at, until - at)
                      )}
                    >
                      <span {...stylex.props(visuallyHidden)}>
                        {words.busy(
                          name,
                          words.time(busy.start, timeZone),
                          words.time(busy.end, timeZone)
                        )}
                      </span>
                    </span>
                  );
                })}
              </div>
            );
          })}
          {ghost === undefined ? null : (
            <div
              data-slot="draft-day-was"
              {...stylex.props(
                styles.ghost,
                styles.span(
                  hoursFrom(from, ghost.start),
                  hoursFrom(from, ghost.end) - hoursFrom(from, ghost.start)
                )
              )}
            >
              <span {...stylex.props(visuallyHidden)}>{`${change.was}: `}</span>
              {words.lasts(
                ghost.start,
                Math.round(
                  (Date.parse(ghost.end) - Date.parse(ghost.start)) / 60_000
                ),
                timeZone
              )}
            </div>
          )}
          <div
            data-slot="draft-day-event"
            {...stylex.props(styles.event, styles.span(top, height))}
          >
            <span {...stylex.props(styles.eventWords)}>
              <span {...stylex.props(styles.eventTitle)}>{title}</span>
              <span {...stylex.props(styles.eventTime)}>
                {words.lasts(start, minutes, timeZone)}
              </span>
            </span>
            {meets ? (
              <span
                data-slot="draft-day-conflicts"
                {...stylex.props(styles.conflicts)}
              >
                <Icon icon={Alert} />
                {words.conflicts}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </figure>
  );
};
