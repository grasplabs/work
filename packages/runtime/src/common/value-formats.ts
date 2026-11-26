// The formats a string can be held to besides `email`: RFC 3339's
// `full-date` and `date-time`, as JSON Schema's `date` and `date-time`
// read them, a web address as the WHATWG URL parser reads one, and one
// segment of a URL's path as connect's egress sends it. Each only checks:
// the value stays the text it was.

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

// `//` and then a host: the parser reads `https:///host` as `https://host`.
const webUrlStart = /^https?:\/\/[^/]/iu;

// What IDNA drops from a host without a word (a zero-width space, a soft
// hyphen), so the text would name another host than the one it reads as.
// Written percent-encoded, the host parser decodes them first. Elsewhere the
// parser percent-encodes them, as it does an emoji's selector.
const invisible = /\p{Default_Ignorable_Code_Point}/u;

// Half of a surrogate pair alone, which the parser replaces. Checked so, not
// with `isWellFormed` (nor the URL with `URL.canParse`), because pages run
// it too, in browsers older than those.
const loneSurrogate = /\p{Cs}/u;

/**
 * The characters a path parameter's value may not decode to, as a regex
 * character class's contents: path and query delimiters, matrix and
 * custom-method separators (`;`, `:`), a percent sign (so it isn't decoded
 * a second time), a backslash, and controls.
 */
export const forbiddenInValue = String.raw`/\\?#%;:\u0000-\u001F\u007F`;

/** A path parameter's value, decoded: text with none of `forbiddenInValue`. */
export const segmentValuePattern = new RegExp(`^[^${forbiddenInValue}]+$`, "u");

/**
 * Batch endpoints (Graph's `/$batch`, Google's `/batch/...`) carry any
 * number of requests to any path in one body, past the path allowlist: no
 * route declares one, and no value stands for one.
 */
export const isBatchSegment = (segment: string): boolean => {
  const lower = segment.toLowerCase();
  return lower === "batch" || lower.startsWith("$batch");
};

/**
 * One whole segment of a URL's path, as a route's `{name}` takes it: text
 * with none of `forbiddenInValue`, not a dot segment (`.`, `..`), not a
 * batch endpoint, and no lone surrogate, which no URL can encode. Connect's
 * egress sends a value standing alone in a segment only if this holds
 * (`pathMatches`), so `v.string().segment()` takes exactly the values it
 * sends.
 */
export const isPathSegment = (text: string): boolean =>
  segmentValuePattern.test(text) &&
  text !== "." &&
  text !== ".." &&
  !isBatchSegment(text) &&
  !loneSurrogate.test(text);

/**
 * An absolute `http` or `https` URL, read as the WHATWG URL parser reads
 * it: as an App's `new URL` and connect's fetch do, a host included
 * (percent-decoded, IDNA-mapped, IPv4 in its short forms). Of what that
 * parser would quietly mend in how the address is written, this is refused:
 * spaces and control characters, which it drops; a backslash, which it
 * reads as `/`; a character IDNA drops unseen from the host; a lone
 * surrogate, which it replaces; and a scheme without `//` and a host after
 * it. So is any user name or password, even an empty one (`@` before the
 * host: `https://good.example@evil.example`), which fetch refuses anyway.
 */
export const isWebUrl = (text: string): boolean => {
  for (const char of text) {
    if (char <= " " || char === "\u007F" || char === "\\") {
      return false;
    }
  }
  const [authority = ""] = text.slice(text.indexOf("//") + 2).split(/[/?#]/u);
  try {
    return (
      webUrlStart.test(text) &&
      !authority.includes("@") &&
      !invisible.test(decodeURIComponent(authority)) &&
      !loneSurrogate.test(text) &&
      new URL(text).host !== ""
    );
  } catch {
    return false;
  }
};
