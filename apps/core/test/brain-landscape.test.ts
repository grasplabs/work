import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { landscapeApps, policyDocuments } from "../src/db/core/schema.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The brain's landscape and policies (`brain.read`), from what the
// landscape and the policy manager keep, for everyone signed in as their
// own reads give them. It starts from the ways it can fail: an app or a
// policy that the landscape or the policy manager shows not reaching the
// brain, a reader seeing more or less there than in their own read, and an
// unverified publisher named as an app's vendor. Which apps and policies
// there are is the landscape's and the policy manager's own tests.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

describe("the brain's landscape and policies", setUpTime, () => {
  it("gives every reader the landscape's apps and the policy manager's documents, as their own reads do, with only a verified publisher as vendor", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const u = unique();
    const seen = new Date("2026-10-28T09:15:42.000Z");
    const db = drizzle(env.DB);
    await db.insert(landscapeApps).values([
      {
        connectionId: `conn-${u}`,
        appId: `verified-${u}`,
        name: `Ledger ${u}`,
        publisher: "Ledger Ltd",
        unverifiedPublisher: null,
        verified: true,
        adminScopes: null,
        adminSeenAt: null,
        firstSeen: seen,
        lastSeen: seen,
      },
      {
        connectionId: `conn-${u}`,
        appId: `unverified-${u}`,
        name: `Notes ${u}`,
        publisher: null,
        unverifiedPublisher: "Totally Legit Inc",
        verified: false,
        adminScopes: null,
        adminSeenAt: null,
        firstSeen: seen,
        lastSeen: seen,
      },
    ]);
    await db.insert(policyDocuments).values({
      id: `policy-${u}`,
      title: `Data handling ${u}`,
      fileName: "data.md",
      text: "Keep customer data in the EU.",
      status: "review",
      uploadedBy: admin.userId,
      uploadedAt: seen,
      summary: "Where customer data may live.",
      proposals: [
        {
          id: "p1",
          name: "EU only",
          description: "Apps keep data in the EU.",
          conditions: [],
          effect: "flag",
          excerpt: "Keep customer data in the EU.",
          decision: "open",
        },
      ],
      unchecked: [
        { requirement: "Train staff", excerpt: "Train staff yearly." },
      ],
    });

    const ours = <T extends { id: string }>(items: T[]): T[] =>
      items
        .filter(({ id }) => id.endsWith(u))
        .toSorted((a, b) => a.id.localeCompare(b.id));
    const brainOf = async (person: typeof admin) => {
      const read = await person.api.brain.read();
      return { landscape: ours(read.landscape), policies: ours(read.policies) };
    };
    const ownReadsOf = async (person: typeof admin) => {
      const [apps, book] = await Promise.all([
        person.api.landscape.apps(),
        person.api.policies.book(),
      ]);
      return {
        apps: apps
          .filter(({ appId }) => appId.endsWith(u))
          .map(({ appId }) => appId)
          .toSorted(),
        policies: ours(book.policies).map(({ id }) => id),
      };
    };

    const [byMember, byAdmin, memberReads] = await Promise.all([
      brainOf(member),
      brainOf(admin),
      ownReadsOf(member),
    ]);

    expect({
      member: byMember,
      // Everyone signed in reads both, as in the landscape and the policies.
      sameForAdmin: byAdmin,
      asTheirOwnReads: {
        apps: byMember.landscape.map(({ id }) => id),
        policies: byMember.policies.map(({ id }) => id),
      },
    }).toStrictEqual({
      member: {
        landscape: [
          {
            id: `unverified-${u}`,
            name: `Notes ${u}`,
            // Never the name an unverified app gives its publisher.
            vendor: "",
            category: "",
            ai: "none",
            people: 0,
            seenThrough: ["microsoftSso"],
            owner: null,
            matches: [`Notes ${u}`],
            permissions: [],
          },
          {
            id: `verified-${u}`,
            name: `Ledger ${u}`,
            vendor: "Ledger Ltd",
            category: "",
            ai: "none",
            people: 0,
            seenThrough: ["microsoftSso"],
            owner: null,
            matches: [`Ledger ${u}`],
            permissions: [],
          },
        ],
        policies: [
          {
            id: `policy-${u}`,
            title: `Data handling ${u}`,
            uploadedAt: "2026-10-28T09:15",
            status: "review",
            summary: "Where customer data may live.",
            proposals: [
              { excerpt: "Keep customer data in the EU.", decision: "open" },
            ],
            unchecked: [{ excerpt: "Train staff yearly." }],
          },
        ],
      },
      sameForAdmin: byMember,
      asTheirOwnReads: memberReads,
    });
  });
});
