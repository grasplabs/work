import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  deliver,
  intake,
  invoiceMail,
  readByRun,
  storedName,
} from "./email-triggers.ts";
import { mockIdp } from "./idp.ts";
import { runQuarterHourTasks } from "./maintenance.ts";
import { endLiveRuns } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith } from "./workflow-apps.ts";

// The attachments of mail an email trigger received (email-triggers.ts):
// kept for the App's runs alone, read by them, and deleted in time.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

describe("attachments of mail", () => {
  afterEach(endLiveRuns);

  it("are deleted once 30 days have passed since the day they were kept", async () => {
    const builder = await personApi("builder");
    const app = await appWith(builder, intake("kept"));
    await deliver("kept@grasp.test", invoiceMail({ to: "kept@grasp.test" }));
    const { id, stored } = await readByRun(builder, app);
    const day = storedName.exec(stored ?? "")?.groups?.day ?? "";
    const key = `inbound-email/${day}/${app}/${id}`;
    const dayEnded = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;
    const kept = async (): Promise<boolean> =>
      (await env.FILES.head(key)) !== null;

    // Up to 30 days after its day ended, it stays.
    await runQuarterHourTasks(
      {},
      new Date(dayEnded + 30 * 24 * 60 * 60 * 1000 - 1)
    );
    await expect(kept()).resolves.toBeTruthy();
    // Then the next run deletes it.
    await runQuarterHourTasks(
      {},
      new Date(dayEnded + 30 * 24 * 60 * 60 * 1000)
    );
    await expect(kept()).resolves.toBeFalsy();
  });
});
