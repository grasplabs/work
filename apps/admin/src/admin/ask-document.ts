/**
 * What Ask Grasp's model reads (src/admin/ask.ts): the admin's document,
 * written in the page from the organizations it shows, as the prototype
 * writes it (`adminDocument`): the digest, then every organization in
 * numbers, never what anyone said.
 */
import { adminDocument } from "@grasp-os/shared/admin/admin-tools";

import type { ClientAdmin } from "../clients/admin.ts";
import { organizationsOf } from "./views.ts";

/** The admin's document: every organization whose core answered, on `today`. */
export const documentOf = (
  admins: readonly ClientAdmin[],
  today: string
): string =>
  adminDocument(
    organizationsOf(admins).flatMap(({ view }) =>
      view === null ? [] : [view]
    ),
    today
  );
