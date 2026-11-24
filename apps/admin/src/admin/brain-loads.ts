/**
 * How an organization's Brain section reads its Brain from its core
 * (src/clients/brain.ts): every read is in the company's audit log as the
 * staff member reading it, so a preload (a link pointed at, or focused)
 * asks nothing, and only opening the section does. Not awaited by the
 * route: a slow or unreachable core never holds up the rest of the
 * section, which shows at once, and the report when it comes.
 */
import type { BrainReport } from "@grasp-os/shared/brain-report";

/**
 * Where the section's read of its Brain stands: not asked (a preload),
 * or asked, with the report or null when its core didn't answer.
 */
export type BrainRead =
  | { state: "not_asked" }
  | { state: "read"; report: BrainReport | null };

/**
 * The section's read of client `clientId`'s Brain with `read`, unless it
 * is a preload. Never rejects: a read that fails is a core that didn't
 * answer.
 */
export const loadBrainRead = async ({
  clientId,
  preload,
  read,
}: {
  clientId: string;
  preload: boolean;
  read: (clientId: string) => Promise<BrainReport | null>;
}): Promise<BrainRead> => {
  if (preload) {
    return { state: "not_asked" };
  }
  try {
    return { state: "read", report: await read(clientId) };
  } catch {
    return { state: "read", report: null };
  }
};
