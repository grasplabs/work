/**
 * Linking an organization to its proposal's room in Grasp's Rooms, as the
 * admin's Contract does it, behind the Access check every request passes
 * (src/access.ts), as the verified staff member the request comes from.
 * A refusal is answered as its code, which the page words.
 */
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import {
  RoomsLinkError,
  roomsLinkInputSchema,
  setRoomsProject,
} from "./link.ts";
import type { RoomsLinkErrorCode } from "./link.ts";

/** What linking answers: whether it changed anything, or why it was refused. */
export type RoomsLinkChange =
  | { changed: boolean; refused: null }
  | { changed: null; refused: RoomsLinkErrorCode };

export const setRoomsProjectFn = createServerFn({ method: "POST" })
  .validator(roomsLinkInputSchema)
  .handler(async ({ data, context }): Promise<RoomsLinkChange> => {
    try {
      return {
        changed: await setRoomsProject(env, context.staff, data),
        refused: null,
      };
    } catch (error) {
      if (error instanceof RoomsLinkError) {
        return { changed: null, refused: error.code };
      }
      throw error;
    }
  });
