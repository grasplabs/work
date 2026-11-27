/**
 * Where the admin alerts staff (src/alerts/alert.ts): mail through
 * Cloudflare's Email Sending, and a Discord channel through its webhook,
 * each switched on or off on Platform's Maintenance page. Plain data, for
 * the database schema (src/db/schema.ts) and the alerts' modules alike;
 * pages take only its type.
 */
import "@tanstack/react-start/server-only";

export const alertChannelIds = ["mail", "discord"] as const;
export type AlertChannel = (typeof alertChannelIds)[number];
