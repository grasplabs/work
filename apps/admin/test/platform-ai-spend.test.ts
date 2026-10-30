import type { PlatformSpendRow } from "@grasp-os/shared/ai-status-report";
import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { fetchPlatformSpend } from "../src/platform-ai-functions.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { aiStatusOf, emptyAdminSnapshot, monthBack } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

// What Grasp's own AI features cost on its keys, read only: on an
// organization's AI use, this month and last by feature and by model, as
// its core reports them; on Platform → AI, every active organization's
// summed, with those that cost the most. Each client's core is the fake
// account's (test/cloudflare-api.ts), answering the signed AI status
// request as core does. How it can go wrong, tried below: another month's
// spend counted in this one, an organization ordered wrongly or one that
// cost nothing listed, and anything there to cap or change.

const token = "test-deployer-token-platform-ai-spend-9b31e2";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);

/** A live organization named `name`, whose core reports `spend` on Grasp's keys. */
const liveClient = async (
  name: string,
  spend: { thisMonth?: PlatformSpendRow[]; lastMonth?: PlatformSpendRow[] }
) => {
  const release = await placedRelease("feat(core): platform AI spend");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, release, {
    id: clientId,
    name,
    signIn: null,
  });
  account.admin = emptyAdminSnapshot(name);
  account.ai = aiStatusOf([], spend);
  return clientId;
};

const conversion = (micros: number): PlatformSpendRow => ({
  feature: "conversion",
  model: "openai/gpt-5.4-mini",
  micros,
});
const transcription = (micros: number): PlatformSpendRow => ({
  feature: "transcription",
  model: "openai/gpt-4o-transcribe",
  micros,
});
const speech = (micros: number): PlatformSpendRow => ({
  feature: "speech",
  model: "openai/gpt-4o-mini-tts",
  micros,
});

/** The table labelled `label` on a page, its tags left out. */
const tableText = (html: string, label: string): string => {
  const at = html.indexOf(`aria-label="${label}"`);
  return at === -1
    ? ""
    : html
        .slice(html.indexOf(">", at) + 1, html.indexOf("</table>", at))
        .replaceAll(/<[^>]+>/gu, " ")
        .replaceAll(/\s+/gu, " ")
        .trim();
};

/** "2026-10" as the pages say it: "Oct 2026". */
const monthWords = (period: string): string =>
  new Date(`${period}-01T00:00:00Z`).toLocaleString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

describe("what Grasp's own AI features cost", () => {
  useStoreSecrets({ deployer: token });
  // Each test's organizations are its own: an earlier test's are offboarded.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("shows an organization's spend on Grasp's keys this month and last, by feature and by model, read only", async () => {
    const clientId = await liveClient("Noordkade", {
      thisMonth: [
        transcription(2_000_000),
        conversion(1_250_000),
        speech(300_000),
      ],
      lastMonth: [speech(500_000)],
    });

    const { status, html } = await page(`/organizations/${clientId}/ai-use`);
    const [thisMonth, lastMonth] = [
      monthWords(monthBack(0)),
      monthWords(monthBack(1)),
    ];

    expect({
      status,
      byFeature: tableText(html, "By feature"),
      byModel: tableText(html, "By model"),
      dollars: html.includes("US dollars at list prices"),
      // Nothing to cap or change.
      controls: ["<input", "<select", "<button"].some((tag) =>
        html.slice(html.indexOf("Grasp’s own AI features")).includes(tag)
      ),
    }).toStrictEqual({
      status: 200,
      byFeature: `By feature ${thisMonth} ${lastMonth} Transcription $2.00 $0.00 Document conversion $1.25 $0.00 Speech $0.30 $0.50`,
      byModel: `By model ${thisMonth} ${lastMonth} OpenAI gpt-4o-transcribe $2.00 $0.00 OpenAI gpt-5.4-mini $1.25 $0.00 OpenAI gpt-4o-mini-tts $0.30 $0.50`,
      dollars: true,
      controls: false,
    });
  });

  it("sums every active organization's on Platform → AI, this month and last, with those that cost the most this month first and none that cost nothing", async () => {
    const thisPeriod = monthBack(0);
    const lastPeriod = monthBack(1);
    await liveClient("Acme", {
      thisMonth: [
        conversion(1_250_000),
        speech(300_000),
        transcription(2_000_000),
      ],
      lastMonth: [speech(500_000)],
    });
    // Nothing this month: after every organization that spent this month.
    await liveClient("Brightline", { lastMonth: [conversion(9_000_000)] });
    await liveClient("Calder", { thisMonth: [transcription(5_000_000)] });
    // Nothing either month: not listed.
    await liveClient("Dunmore", {});

    const spend = await callServerFn(fetchPlatformSpend);
    const { html } = await page("/platform/ai");
    const [thisMonth, lastMonth] = [
      monthWords(thisPeriod),
      monthWords(lastPeriod),
    ];

    expect({
      thisMonth: spend.thisMonth,
      lastMonth: spend.lastMonth,
      top: spend.top.map(({ name, thisMonth: now, lastMonth: before }) => ({
        name,
        now,
        before,
      })),
      organizations: spend.organizations,
      unread: spend.unread,
      shown: tableText(html, "Top organizations"),
    }).toStrictEqual({
      thisMonth: {
        period: thisPeriod,
        micros: 8_550_000,
        byFeature: [
          { feature: "transcription", micros: 7_000_000 },
          { feature: "conversion", micros: 1_250_000 },
          { feature: "speech", micros: 300_000 },
        ],
        byModel: [
          { model: "openai/gpt-4o-transcribe", micros: 7_000_000 },
          { model: "openai/gpt-5.4-mini", micros: 1_250_000 },
          { model: "openai/gpt-4o-mini-tts", micros: 300_000 },
        ],
      },
      lastMonth: {
        period: lastPeriod,
        micros: 9_500_000,
        byFeature: [
          { feature: "conversion", micros: 9_000_000 },
          { feature: "speech", micros: 500_000 },
        ],
        byModel: [
          { model: "openai/gpt-5.4-mini", micros: 9_000_000 },
          { model: "openai/gpt-4o-mini-tts", micros: 500_000 },
        ],
      },
      top: [
        { name: "Calder", now: 5_000_000, before: 0 },
        { name: "Acme", now: 3_550_000, before: 500_000 },
        { name: "Brightline", now: 0, before: 9_000_000 },
      ],
      organizations: 4,
      unread: [],
      shown: `Organization ${thisMonth} ${lastMonth} Calder $5.00 $0.00 Acme $3.55 $0.50 Brightline $0.00 $9.00`,
    });
  });
});
