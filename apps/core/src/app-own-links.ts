import { appErrors, appLinkSchema } from "@grasp-os/shared/apps";
import type { App } from "@grasp-os/shared/apps";
import { actorOf, createAuditEvent } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { editableApp, toApp, usableApp } from "./apps.ts";
import { auditedBatch, outboxedEventWhere } from "./audit-outbox.ts";
import { apps } from "./db/core/schema.ts";
import { requireNotStaff } from "./sharing.ts";

// An App's own link (GRA-533, as the prototype's publish dialog gives one,
// `components/apps/publish-dialog.tsx`): the last part of an address under
// the workspace's, which opens the App's page for whoever may use it. For
// the workspace's members only, signed in: the link is an address, never
// a way in. From the threat model:
//
// - Someone opening an App through its link they may not use: the link
//   opens only what `usableApp` lets the person use, read as them on
//   every open, and only while the App is published. A draft's, an
//   archived App's, or one they have no role in is answered as no App at
//   all, as is a link nobody has, so a link tells nothing of what is
//   behind it.
// - A link standing for one of the workspace's own pages, or a page later
//   taking an App's link: `appLinkSchema` refuses every first part the
//   web app and core have (`reservedAppLinks`), and the web app tries an
//   address as a link only when no page has it (its not-found route).
// - Two Apps with one link, or one taken over: the database holds each
//   link once (`apps_link`), so the second write fails as a whole, its
//   audit event with it (`app.link_taken`).
// - A link changed by someone who doesn't build the App, or by Grasp
//   staff: only its builders set it (`editableApp`), staff never, as with
//   its status (app-status.ts). An archived App's link can't change.
// - A change no one can trace: setting and taking off a link are audited
//   with the change itself, in one batch.
// - An unpublished App still reached by its link: the status is read with
//   the link on every open, so taking it back to a draft or archiving it
//   takes the link down at once, and publishing it again brings it back.

/**
 * Gives the App `input` names the link `link`, or takes its link off with
 * `null`, for one of its builders. Answered as it is when its link is that
 * already; refused with `app.invalid_link` for one it can't be, and with
 * `app.link_taken` when another App has it.
 */
export const setAppLink = async (
  env: Env,
  by: Identity,
  input: unknown,
  link: unknown
): Promise<App> => {
  requireNotStaff(by);
  const wanted = link === null ? null : appLinkSchema.safeParse(link).data;
  if (wanted === undefined) {
    throw appErrors.create("app.invalid_link");
  }
  const found = await editableApp(env, by, input);
  if (found.link === wanted) {
    return found;
  }
  const db = drizzle(env.DB);
  const event = createAuditEvent(
    {
      actor: actorOf(by),
      action: wanted === null ? "app.link_removed" : "app.link_set",
      target: { type: "app", id: found.id },
      detail: { from: found.link, to: wanted },
    },
    "core"
  );
  try {
    const [[changed]] = await auditedBatch(env, db, [
      db
        .update(apps)
        .set({ link: wanted })
        .where(and(eq(apps.id, found.id), sql`${apps.status} != 'archived'`))
        .returning(),
      outboxedEventWhere(db, event, sql`changes() > 0`),
    ]);
    if (changed === undefined) {
      // Archived since it was read: read-only until a builder restores it.
      throw appErrors.create("app.archived");
    }
    return toApp(changed);
  } catch (error) {
    if (!isExpectedError(error) && String(error).includes("UNIQUE")) {
      throw appErrors.create("app.link_taken");
    }
    throw error;
  }
};

/**
 * The App link `link` opens for `by`: one that is published and that they
 * may use now. Any other, or a link nobody has, is `app.not_found`.
 */
export const openAppLink = async (
  env: Env,
  by: Identity,
  link: unknown
): Promise<{ app: AppId }> => {
  const known = appLinkSchema.safeParse(link);
  const row = known.success
    ? await drizzle(env.DB)
        .select({ id: apps.id })
        .from(apps)
        .where(and(eq(apps.link, known.data), eq(apps.status, "published")))
        .get()
    : undefined;
  if (row === undefined) {
    throw appErrors.create("app.not_found");
  }
  try {
    const app = await usableApp(env, by, row.id);
    return { app: app.id };
  } catch (error) {
    // Whatever kept them out, a link tells nothing of what is behind it.
    if (isExpectedError(error)) {
      throw appErrors.create("app.not_found");
    }
    throw error;
  }
};
