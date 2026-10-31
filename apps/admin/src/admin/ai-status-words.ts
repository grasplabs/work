/**
 * A client's AI in one plain line, as its Setup says it, from what its
 * core reported (src/clients/ai-status.ts): which provider its
 * organization connected, and whether its real calls work.
 */
import { aiProviders } from "@grasp-os/shared/ai-providers";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

/** How long before `now` `at` was, in a few words: "5 min ago". */
const agoWords = (at: number, now: number): string => {
  const since = Math.max(0, now - at);
  if (since < minuteMs) {
    return "just now";
  }
  if (since < hourMs) {
    return `${String(Math.floor(since / minuteMs))} min ago`;
  }
  if (since < dayMs) {
    const hours = Math.floor(since / hourMs);
    return `${String(hours)} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(since / dayMs);
  return `${String(days)} ${days === 1 ? "day" : "days"} ago`;
};

/** When `at` was, in UTC: "14:02" today, "29 Oct, 14:02" before. */
const sinceWords = (at: number, now: number): string => {
  const when = new Date(at);
  const time = when.toISOString().slice(11, 16);
  const sameDay =
    when.toISOString().slice(0, 10) ===
    new Date(now).toISOString().slice(0, 10);
  if (sameDay) {
    return `${time} UTC`;
  }
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(when);
  return `${day}, ${time} UTC`;
};

/**
 * The client's AI in one plain line, from what its core reported (`null`:
 * it couldn't be asked), by its organization's default provider:
 * "AI: OpenAI connected · working · last used 5 min ago", "AI: OpenAI
 * connected · not answering since 14:02 UTC" when its last call failed
 * after the last that worked, "AI: OpenAI connected · not used yet", or
 * "AI: not connected yet".
 */
export const aiStatusLine = (
  report: AiStatusReport | null,
  now: number = Date.now()
): string => {
  if (report === null) {
    return "AI: couldn’t be read just now.";
  }
  const [first, ...others] = report.providers.filter(
    ({ kind }) => kind === "organization"
  );
  if (first === undefined) {
    return "AI: not connected yet";
  }
  const more =
    others.length === 0 ? "" : ` (and ${String(others.length)} more)`;
  const connected = `AI: ${aiProviders[first.provider].label}${more} connected`;
  const { lastOkAt, lastFailedAt } = first;
  if (lastFailedAt !== null && (lastOkAt === null || lastFailedAt > lastOkAt)) {
    return `${connected} · not answering since ${sinceWords(lastFailedAt, now)}`;
  }
  if (lastOkAt === null) {
    return `${connected} · not used yet`;
  }
  return `${connected} · working · last used ${agoWords(lastOkAt, now)}`;
};
