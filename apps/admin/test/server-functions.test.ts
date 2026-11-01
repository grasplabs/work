import { env } from "cloudflare:workers";
import { and, eq, ne, or } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  applySettingsFn,
  rotateSecretsFn,
  setSealedSecretFn,
  setSignInFn,
} from "../src/clients/functions.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { auditEvents, channels, clients } from "../src/db/schema.ts";
import { releaseToEdge } from "../src/rollout/channels.ts";
import {
  pinClientFn,
  promoteReleaseFn,
  setChannelFn,
} from "../src/rollout/functions.ts";
import { adminWorkflows } from "../src/workflow-runs.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { ended, followAdminRuns } from "./runs.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-functions-6a2f90";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);

/** Who sets each test up, acting on the admin directly. */
const setup = { email: "setup@grasp.test", sub: "sub-setup" };

/** Who makes each change, through the admin's entry: the staff member Access vouches for. */
const caller = "ops@grasp.test";

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

/** A release a placed client runs, imported. */
const importedRelease = async (notes: string): Promise<string> =>
  await placedRelease(notes);

/** An active client, recorded on a new account in the fake. */
const recordClient = async (): Promise<string> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    setup,
    [
      db.insert(clients).values({
        id: clientId,
        name: clientId,
        status: "active",
        signIn: JSON.stringify(signIn),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return clientId;
};

/** An active client running `releaseId`, placed and provisioned. */
const activeClient = async (releaseId: string): Promise<string> => {
  const { clientId } = await livePlacedClient(cloudflare, releaseId);
  return clientId;
};

/** What a change leaves in the audit log, besides who made it. */
interface Audited {
  action: string;
  clientId: string | null;
  target: string | null;
}

/**
 * The audit events of `audited`'s action about its client, or else its
 * target, that someone made: none of the admin's own (actor `system`).
 */
const eventsOf = async ({ action, clientId, target }: Audited) =>
  await db
    .select({
      actor: auditEvents.actor,
      clientId: auditEvents.clientId,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, action),
        ne(auditEvents.actor, "system"),
        or(
          eq(auditEvents.clientId, clientId ?? target ?? ""),
          eq(auditEvents.target, target ?? clientId ?? "")
        )
      )
    );

/** A change as a test makes it, once the admin is set up for it. */
interface Arranged {
  /** Makes the change through the admin's entry, as `caller`. */
  make: () => Promise<{ refused: string | null }>;
  /** What it should leave in the audit log. */
  audited: Audited;
  /** Waits until the run it touched is where the change leaves it. */
  settled?: () => Promise<unknown>;
}

/**
 * Every change staff make from the admin's pages, each with what sets
 * the admin up for it.
 */
const changes: {
  name: string;
  arrange: () => Promise<Arranged>;
}[] = [
  {
    name: "promoting a release to a channel",
    arrange: async () => {
      const releaseId = await importedRelease("feat(core): promoted");
      // On Edge first, as the admin puts each new release there itself.
      await releaseToEdge(env, [releaseId]);
      return {
        make: async () =>
          await callServerFn(
            promoteReleaseFn,
            { channel: "beta", releaseId },
            { email: caller }
          ),
        audited: {
          action: "channel.promote",
          clientId: null,
          target: releaseId,
        },
      };
    },
  },
  {
    name: "pinning a client to a release",
    arrange: async () => {
      const releaseId = await importedRelease("feat(core): pinned to");
      const clientId = await recordClient();
      return {
        make: async () =>
          await callServerFn(
            pinClientFn,
            { clientId, releaseId },
            { email: caller }
          ),
        audited: { action: "client.pin", clientId, target: releaseId },
      };
    },
  },
  {
    name: "moving a client to another channel",
    arrange: async () => {
      const clientId = await recordClient();
      return {
        make: async () =>
          await callServerFn(
            setChannelFn,
            { clientId, channel: "edge" },
            { email: caller }
          ),
        audited: { action: "client.channel", clientId, target: null },
      };
    },
  },
  {
    name: "changing a client's sign-in",
    arrange: async () => {
      const clientId = await recordClient();
      return {
        make: async () =>
          await callServerFn(
            setSignInFn,
            {
              clientId,
              signIn: { ...signIn, admins: ["bo@acme.test"] },
            },
            { email: caller }
          ),
        audited: { action: "client.sign_in", clientId, target: null },
      };
    },
  },
  {
    name: "setting a client's Teams bot secret",
    arrange: async () => {
      const clientId = await recordClient();
      return {
        make: async () =>
          await callServerFn(
            setSealedSecretFn,
            {
              clientId,
              name: "TEAMS_BOT_SECRET",
              value: "bot~secret.Value_0123456789",
            },
            { email: caller }
          ),
        audited: {
          action: "client.sealed_secret",
          clientId,
          target: "TEAMS_BOT_SECRET",
        },
      };
    },
  },
  {
    name: "rotating a client's secrets",
    arrange: async () => {
      const clientId = await recordClient();
      return {
        make: async () =>
          await callServerFn(rotateSecretsFn, { clientId }, { email: caller }),
        audited: { action: "client.rotate_secrets", clientId, target: null },
      };
    },
  },
  {
    name: "applying a client's settings now",
    arrange: async () => {
      const release = await importedRelease("feat(core): applied to");
      const clientId = await activeClient(release);
      return {
        make: async () =>
          await callServerFn(applySettingsFn, { clientId }, { email: caller }),
        audited: { action: "client.apply_settings", clientId, target: null },
        // Its run, on Workerflow: the one its claim's record names.
        settled: async () => {
          const [claim] = await db
            .select({ detail: auditEvents.detail })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.clientId, clientId),
                eq(auditEvents.action, "client.apply_settings")
              )
            );
          const run = z
            .object({ run: z.string() })
            .parse(JSON.parse(claim?.detail ?? "null"));
          // Ended, and done: an apply that failed doesn't pass this test.
          const settledRun = await ended(adminWorkflows.applyClient, run.run);
          expect(settledRun.status).toBe("complete");
          return settledRun;
        },
      };
    },
  },
];

describe("the admin's changes, through its entry", () => {
  useStoreSecrets({ deployer: token });
  // The database outlives each test: each test's change reaches only its
  // own clients, and no earlier test's channel stands in the way.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
    await db.delete(channels);
  });

  it.each(changes.map(({ name, arrange }) => [name, arrange] as const))(
    "%s is audited as the staff member Access vouches for, about its client and target",
    async (_name, arrange) => {
      // A change may start runs: their retries and sleeps going at once.
      await using _runs = followAdminRuns();
      const { make, audited, settled } = await arrange();

      const { refused } = await make();
      await settled?.();

      expect({ refused, events: await eventsOf(audited) }).toStrictEqual({
        refused: null,
        events: [
          {
            actor: caller,
            clientId: audited.clientId,
            target: audited.target,
          },
        ],
      });
    }
  );

  it("refuses a change sent from another site's page, or by no one Access vouches for, changing and auditing nothing", async () => {
    const clientId = await recordClient();
    const change = { clientId, channel: "edge" as const };

    await expect(
      callServerFn(setChannelFn, change, {
        email: caller,
        from: "https://elsewhere.test",
      })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(setChannelFn, change, { email: null })
    ).rejects.toThrow("The server function answered 403");

    const [client] = await db
      .select({ channel: clients.channel })
      .from(clients)
      .where(eq(clients.id, clientId));
    expect({
      channel: client?.channel,
      events: await eventsOf({
        action: "client.channel",
        clientId,
        target: null,
      }),
    }).toStrictEqual({ channel: "stable", events: [] });
  });
});
