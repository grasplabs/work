import {
  auditActionPrefixSchema,
  auditEventTypeSchema,
} from "@grasp-os/shared/audit-log";
import type { AuditEventType } from "@grasp-os/shared/audit-log";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { z } from "zod";

// Apart from audit-log.tsx, which the audit trail page's address reads with
// this before the page loads: the log's filters, its records and its
// export come with the page, not with the app.

/** The log's filters, as the page's address holds them. */
export interface LogSearch {
  type?: AuditEventType;
  action?: string;
  /** A person's, agent's, App's or run's ID. */
  actor?: string;
  target?: string;
  /** Days (`yyyy-mm-dd`), in the viewer's time zone, both included. */
  from?: string;
  to?: string;
}

const daySchema = z.iso.date();

/** A text filter as typed: trimmed, identifier-sized, and none when empty. */
const textFilter = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim().slice(0, identifierMaxLength);
  return text === "" ? undefined : text;
};

const trailingDots = /\.+$/u;

/**
 * An action filter as typed, as core takes it: lower case, without a
 * trailing dot (`Connection.` finds `connection.call`), and none for text
 * that can't start an action, rather than a search core refuses whole.
 */
const actionFilter = (value: unknown): string | undefined => {
  const text = textFilter(value)?.toLowerCase().replace(trailingDots, "");
  return auditActionPrefixSchema.safeParse(text).data;
};

/**
 * A day as the date inputs give it (`yyyy-mm-dd`), and none for anything
 * else, a day no calendar has (`2024-02-30`) included: a date rolls it on
 * into the next month, which the filter would search while showing the
 * day typed.
 */
const dayFilter = (value: unknown): string | undefined =>
  daySchema.safeParse(value).data;

/**
 * The log's filters in `search`, each one `undefined` where the address
 * has none or one that isn't a filter: every key is there, as the router
 * merges what a route validates over the address's own search, and a key
 * left out would keep the address's value.
 */
export const logSearchOf = (search: Record<string, unknown>): LogSearch => ({
  type: auditEventTypeSchema.safeParse(search.type).data,
  action: actionFilter(search.action),
  actor: textFilter(search.actor),
  target: textFilter(search.target),
  from: dayFilter(search.from),
  to: dayFilter(search.to),
});
