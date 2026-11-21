import { createElement } from "react";

import { OrgSetup } from "../src/admin/setup.tsx";
import type { SetupTab } from "../src/admin/setup.tsx";
import {
  fetchClientAiStatus,
  fetchClientSetup,
} from "../src/clients/functions.ts";
import {
  fetchClientHosting,
  fetchProvisioningProgress,
} from "../src/hosting/functions.ts";
import { fetchPinChoices } from "../src/provision/functions.ts";
import { callServerFn, rendered } from "./pages.ts";

/**
 * Client `clientId`'s Setup on `tab`, as `email` (a staff member) sees it:
 * what its route reads, through the Worker's entry as the page calls it,
 * rendered (src/routes/organizations/$clientId/setup.tsx). Null for a
 * client the admin doesn't have, whose Setup is a page that isn't there.
 */
export const setupPage = async (
  clientId: string,
  tab: SetupTab = "status",
  email = "staff@grasp.test"
): Promise<string | null> => {
  const caller = { email };
  const client = { clientId };
  const setup = await callServerFn(fetchClientSetup, client, caller);
  if (setup === null) {
    return null;
  }
  const { releases } = await callServerFn(fetchPinChoices, undefined, caller);
  const hosting = await callServerFn(fetchClientHosting, client, caller);
  const progress = await callServerFn(
    fetchProvisioningProgress,
    client,
    caller
  );
  // As the route reads it: a read that fails shows as unknown.
  const aiStatus = await callServerFn(
    fetchClientAiStatus,
    client,
    caller
  ).catch(() => null);
  return await rendered(
    createElement(OrgSetup, {
      clientId,
      setup,
      tab,
      aiStatus: Promise.resolve(aiStatus),
      releases,
      hosting,
      progress,
    })
  );
};
