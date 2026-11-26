import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { staff } from "../db/schema.ts";

/**
 * Who is signed in to the admin, for the sidebar's foot: the name Grasp
 * keeps for them, or their address's first part when it keeps none.
 */
export const fetchStaff = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const { email } = context.staff;
    const row = await adminDatabase(env.DB)
      .select({ name: staff.name })
      .from(staff)
      .where(eq(staff.email, email))
      .get();
    const local = email.split("@")[0] ?? email;
    return {
      name: row?.name ?? local.charAt(0).toUpperCase() + local.slice(1),
    };
  }
);
