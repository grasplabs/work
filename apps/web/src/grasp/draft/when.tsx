// The event draft's when (and a task's due, DraftDue), changed in place: the when row's words are a quiet button that opens a
// popover with the day (Calendar) and the start and end times, a quarter of an hour apart. Moving
// the start keeps the event's length; the end lists only times after the start. A changed time
// keeps the draft's own offset ("+01:00"), as its times were given; the words show them in
// `timeZone`, which the host sets to the same zone.
"use client";

import * as stylex from "@stylexjs/stylex";

import { Calendar } from "../calendar";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../popover";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../select";
import { grasp } from "../tokens/tokens.stylex";
import { useDraftWords } from "./draft";

const MINUTE = 60_000;
const STEP = 15;

const styles = stylex.create({
  // The trigger stands where the words stood: its own inset taken back, its height in the line.
  trigger: {
    marginInlineStart: `calc(-1 * ${grasp.space2})`,
    marginBlock: `calc((${grasp.chatTextLine} - ${grasp.controlXs}) / 2)`,
  },
  panel: { display: "grid", gap: grasp.space3 },
  times: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: grasp.space2 },
  time: { display: "grid", gap: grasp.space1 },
  name: {
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
});

/** Whether a due is a day with no time ("2026-11-20"), not a moment. */
export const isDay = (due: string | undefined): due is string =>
  due !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(due);

/**
 * The offset an ISO time was written with ("+01:00", or UTC's letter), kept as it was written; a time
 * written with none has none, and is read in the browser's own time.
 */
const offsetOf = (iso: string) =>
  /(?<offset>Z|[+-]\d\d:\d\d)$/u.exec(iso)?.groups?.offset ?? "";

/** The offset's minutes east of UTC: none for UTC's letter or no offset. */
const minutesOf = (offset: string) => {
  if (!/^[+-]/u.test(offset)) {
    return 0;
  }
  const sign = offset.startsWith("-") ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
};

/** A moment written as ISO in the given offset ("2026-11-19T14:30:00+01:00"). */
const isoAt = (ms: number, offset: string) => {
  const local = new Date(ms + minutesOf(offset) * MINUTE).toISOString();
  return `${local.slice(0, 19)}${offset}`;
};

/** Today at 09:00 in the browser's own offset, as ISO: where a task with no due date starts. */
const localNine = () => {
  const now = new Date();
  const minutes = -now.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const offset = `${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
  const local = new Date(now.getTime() + minutes * MINUTE)
    .toISOString()
    .slice(0, 10);
  return `${local}T09:00:00${offset}`;
};

/** Every quarter of an hour of a day, as "HH:MM". */
const quarters = Array.from({ length: (24 * 60) / STEP }, (_, index) => {
  const minutes = index * STEP;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

/** The when row's words, and the popover that changes them. */
export const DraftWhen = ({
  start,
  end,
  words: shown,
  onChange,
}: {
  start: string;
  end: string;
  words: string;
  onChange: (start: string, end: string) => void;
}) => {
  const words = useDraftWords("event");
  const offset = offsetOf(start);
  const length = Date.parse(end) - Date.parse(start);
  const day = start.slice(0, 10);
  const from = start.slice(11, 16);
  const until = end.slice(11, 16);
  const at = (date: string, time: string) =>
    Date.parse(`${date}T${time}:00${offset}`);
  const moveStart = (date: string, time: string) => {
    const next = at(date, time);
    onChange(isoAt(next, offset), isoAt(next + length, offset));
  };
  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="xs" layout={styles.trigger}>
        {shown}
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverTitle>{words.when}</PopoverTitle>
        <div {...stylex.props(styles.panel)}>
          <Calendar
            value={day}
            onValueChange={(value) => {
              if (typeof value === "string") {
                moveStart(value, from);
              }
            }}
          />
          <div {...stylex.props(styles.times)}>
            <div {...stylex.props(styles.time)}>
              <span aria-hidden="true" {...stylex.props(styles.name)}>
                {words.starts}
              </span>
              <Select
                items={quarters.map((time) => ({ value: time, label: time }))}
                value={from}
                onValueChange={(value) => {
                  if (value !== null) {
                    moveStart(day, value);
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={words.starts}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </div>
            <div {...stylex.props(styles.time)}>
              <span aria-hidden="true" {...stylex.props(styles.name)}>
                {words.ends}
              </span>
              <Select
                items={quarters
                  .filter((time) => time > from)
                  .map((time) => ({ value: time, label: time }))}
                value={until}
                onValueChange={(value) => {
                  if (value !== null) {
                    onChange(start, isoAt(at(day, value), offset));
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={words.ends}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * A task's due, changed in place: the row's words open the day and one time; a day with no time
 * ("2026-11-20") opens the day alone, and stays a day.
 */
export const DraftDue = ({
  at: due,
  words: shown,
  onChange,
}: {
  at: string | undefined;
  words: string;
  onChange: (at: string) => void;
}) => {
  const words = useDraftWords("task");
  if (isDay(due)) {
    return (
      <Popover>
        <PopoverTrigger variant="ghost" size="xs" layout={styles.trigger}>
          <time dateTime={due}>{shown}</time>
        </PopoverTrigger>
        <PopoverContent align="start">
          <PopoverTitle>{words.due}</PopoverTitle>
          <Calendar
            value={due}
            onValueChange={(value) => {
              if (typeof value === "string") {
                onChange(value);
              }
            }}
          />
        </PopoverContent>
      </Popover>
    );
  }
  // With no due date yet, the picker starts on today at 09:00, in the browser's own offset.
  const start = due ?? localNine();
  const offset = offsetOf(start);
  const day = start.slice(0, 10);
  const time = start.slice(11, 16);
  const move = (date: string, clock: string) => {
    onChange(isoAt(Date.parse(`${date}T${clock}:00${offset}`), offset));
  };
  return (
    <Popover>
      <PopoverTrigger variant="ghost" size="xs" layout={styles.trigger}>
        {shown}
      </PopoverTrigger>
      <PopoverContent align="start">
        <PopoverTitle>{words.due}</PopoverTitle>
        <div {...stylex.props(styles.panel)}>
          <Calendar
            value={due === undefined ? null : day}
            onValueChange={(value) => {
              if (typeof value === "string") {
                move(value, time);
              }
            }}
          />
          <Select
            items={quarters.map((each) => ({ value: each, label: each }))}
            value={time}
            onValueChange={(value) => {
              if (value !== null) {
                move(day, value);
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={words.due}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
};
