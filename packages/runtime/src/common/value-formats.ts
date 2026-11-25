// The formats a string can be held to besides `email`: RFC 3339's
// `full-date` and `date-time`, as JSON Schema's `date` and `date-time`
// read them, and a web address as the WHATWG URL parser reads one. Each
// only checks: the value stays the text it was.

const datePattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

// RFC 3339's ABNF is case-insensitive, so `t` and `z` count as `T` and `Z`.
const dateTimePattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:[Zz]|(?<sign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u;

const minutesInDay = 24 * 60;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

const isCalendarDate = (year: number, month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

/** `YYYY-MM-DD`, a day the calendar has. */
export const isDate = (text: string): boolean => {
  const groups = datePattern.exec(text)?.groups;
  return (
    groups !== undefined &&
    isCalendarDate(
      Number(groups.year),
      Number(groups.month),
      Number(groups.day)
    )
  );
};

/**
 * A date and a time with its offset. A leap second (`:60`) only stands at
 * the last minute of a day in UTC, where RFC 3339 places them.
 */
export const isDateTime = (text: string): boolean => {
  const groups = dateTimePattern.exec(text)?.groups;
  if (groups === undefined) {
    return false;
  }
  const part = (name: string): number => Number(groups[name] ?? 0);
  const second = part("second");
  const valid =
    isCalendarDate(part("year"), part("month"), part("day")) &&
    part("hour") <= 23 &&
    part("minute") <= 59 &&
    second <= 60 &&
    part("offsetHour") <= 23 &&
    part("offsetMinute") <= 59;
  if (!valid || second < 60) {
    return valid;
  }
  const minute = part("hour") * 60 + part("minute");
  const offset = part("offsetHour") * 60 + part("offsetMinute");
  const utcMinute = groups.sign === "-" ? minute + offset : minute - offset;
  return (utcMinute + minutesInDay) % minutesInDay === minutesInDay - 1;
};

/**
 * An absolute `http` or `https` URL, as written: the parser would drop
 * spaces and control characters around and inside it, so they are refused
 * instead.
 */
export const isWebUrl = (text: string): boolean => {
  for (const char of text) {
    if (char <= " " || char === "\u007F") {
      return false;
    }
  }
  const url = URL.parse(text);
  return url?.protocol === "http:" || url?.protocol === "https:";
};
