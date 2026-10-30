import { z } from "zod";

import { linkLimits } from "./app-link-limits.ts";
import type { LinkRefusal } from "./app-link-limits.ts";
import { defineErrorFamily } from "./errors.ts";
import type { AppId } from "./ids.ts";
import type { Json } from "./json.ts";

// A company's webhooks for an App (GRA-1208): https URLs its builders give
// it, which Grasp POSTs the App's events to, signed, through connect.
// Core keeps them and queues each delivery (app-webhooks.ts); connect
// alone sends one (webhooks.ts). What a delivery carries depends on an
// admin: until one approves the webhook's URL, IDs and the event only,
// never what someone sent through a form.

/**
 * The events an App sends its webhooks: a screen's form sent (a keyed
 * mutation or action that answered), the App published by a builder, and
 * a version of it made current.
 */
export const appWebhookEvents = ["form_sent", "published", "changed"] as const;

/** One of `appWebhookEvents`. */
export const appWebhookEventSchema = z.enum(appWebhookEvents);
export type AppWebhookEvent = z.infer<typeof appWebhookEventSchema>;

/** The limits of an App's webhooks, by what they bound. */
export const appWebhookLimits = {
  /** The most webhooks one App has. */
  perApp: 5,
  /** The most bytes of a delivery's body; past it, values are left out. */
  bodyBytes: 64 * 1024,
  /** How long connect waits for a receiver's answer, in milliseconds. */
  timeoutMs: 10_000,
  /** The most deliveries one webhook has waiting; past it, none are added. */
  waiting: 1000,
} as const;

/**
 * The headers of a delivery. The ID is its idempotency key: the same on
 * every attempt. The signature is HMAC-SHA256, with the webhook's secret,
 * of the timestamp, a dot and the body (`signedTextOf`), as `v1=` and
 * lower-case hex; a receiver checks it, and that the timestamp is recent.
 */
export const appWebhookHeaders = {
  id: "grasp-webhook-id",
  event: "grasp-webhook-event",
  timestamp: "grasp-webhook-timestamp",
  signature: "grasp-webhook-signature",
} as const;

/** The text a delivery's signature signs: its timestamp, a dot, its body. */
export const signedTextOf = (timestamp: number, body: string): string =>
  `${timestamp}.${body}`;

/** A webhook of an App, as its settings list it; never its secret. */
export interface AppWebhook {
  id: string;
  app: AppId;
  url: string;
  events: AppWebhookEvent[];
  /** Who approved its URL for the App's data, and when; null until then. */
  approved: { by: string; at: string } | null;
  createdBy: string;
  createdAt: string;
}

/**
 * What a delivery's body holds. Every one: its ID, the event, the App and
 * when it happened, and for `changed` the version, for `form_sent` the
 * submission's key. Only once an admin approved the webhook's URL does
 * `form_sent` carry the function the form sent to and its values, and
 * `valuesLeftOut` says when they didn't fit.
 */
export interface AppWebhookPayload {
  id: string;
  event: AppWebhookEvent;
  app: AppId;
  occurredAt: string;
  version?: number;
  submission?: string;
  operation?: string;
  values?: Json;
  valuesLeftOut?: true;
}

/** A webhook to add: its URL, and the events it is sent. */
export const appWebhookInputSchema = z.strictObject({
  url: z.string().min(1).max(linkLimits.urlLength),
  events: z
    .array(appWebhookEventSchema)
    .min(1)
    .max(appWebhookEvents.length)
    .refine((events) => new Set(events).size === events.length),
});
export type AppWebhookInput = z.infer<typeof appWebhookInputSchema>;

/** An App's webhooks, through `apps.webhooks`. */
export interface AppWebhooksApi {
  /** For its builders and the workspace's admins. */
  list: (app: string) => Promise<AppWebhook[]>;
  /**
   * Adds one, for its builders, never Grasp staff: answered with its
   * secret, this once and never again. It carries no App data until an
   * admin approves it.
   */
  add: (
    app: string,
    webhook: AppWebhookInput
  ) => Promise<{ webhook: AppWebhook; secret: string }>;
  /**
   * Lets the App's data go to the webhook's URL, for an admin, never
   * Grasp staff. Approving one approved changes nothing.
   */
  approve: (app: string, webhook: string) => Promise<AppWebhook>;
  /**
   * Removes one, with every delivery still waiting, for its builders and
   * the workspace's admins.
   */
  remove: (app: string, webhook: string) => Promise<void>;
}

/** Why a webhook wasn't added, approved or removed. */
export const webhookErrors = defineErrorFamily({
  "webhook.invalid":
    "A webhook needs an https address and at least one event to send it.",
  "webhook.invalid_url":
    "Grasp sends webhooks only to https addresses on the public internet, with no user name, password or IP address in them.",
  "webhook.not_found": "There's no such webhook.",
  "webhook.full": "The domain has as many webhooks as it may.",
});

/**
 * What core asks connect to send (`ConnectApi.webhookPost`): the body,
 * already signed by core, and what goes in its headers. Connect sets the
 * headers itself from these, and checks the URL again, so nothing core
 * passes on reaches the receiver but a delivery.
 */
export const webhookPostSchema = z.strictObject({
  url: z.string().min(1).max(linkLimits.urlLength),
  app: z.string().min(1).max(128),
  webhook: z.string().min(1).max(128),
  delivery: z.string().min(1).max(128),
  event: appWebhookEventSchema,
  timestamp: z.int().min(0),
  signature: z.string().regex(/^v1=[0-9a-f]{64}$/u),
  body: z.string().max(appWebhookLimits.bodyBytes),
});
export type WebhookPost = z.infer<typeof webhookPostSchema>;

/**
 * How a delivery went, as connect answers: delivered (any 2xx), failed
 * (to try again: another status, a redirect, no answer in time, or none at
 * all) or refused before anything left (a URL or a body it doesn't send).
 */
export type WebhookOutcome =
  | { outcome: "delivered"; status: number }
  | {
      outcome: "failed";
      reason: "status" | "redirect" | "timeout" | "network";
      status?: number;
    }
  | { outcome: "refused"; reason: LinkRefusal };
