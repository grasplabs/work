import type { BrainSyncConnection } from "@grasp-os/shared/brain-report";
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { BrainHealth } from "../src/admin/brain-health.tsx";
import { loadBrainRead } from "../src/admin/brain-loads.ts";
import { answerKept, answerShown } from "../src/admin/erasure-answer.ts";
import type { LookupAnswer } from "../src/admin/erasure-answer.ts";
import {
  brainActionFn,
  brainErasureFn,
  fetchBrainReport,
} from "../src/clients/brain-functions.ts";
import { readBrainReport } from "../src/clients/brain.ts";
import { mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn, rendered } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { brainReport, heardSnapshot, noOwnStores } from "./snapshots.ts";

const token = "test-deployer-token-admin-brain-5c2d90";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

/** An active client running a new release, as a deploy made it live. */
const liveClient = async () => {
  const release = await placedRelease("feat(core): the brain");
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const { core } = await livePlacedClient(cloudflare, release, {
    id: clientId,
    name: `Acme ${clientId}`,
    signIn: null,
  });
  return { clientId, name: `Acme ${clientId}`, core };
};

/** A read of a client's Brain from its core, as the section's server function makes it. */
const read = async (clientId: string) =>
  await readBrainReport(env, { email: "grace@grasp.test" }, clientId);

/**
 * How client `clientId`'s Brain is doing, as `email` (a staff member)
 * sees it: its report, read through the Worker's entry as the section
 * reads it, rendered (`BrainHealth`). The rest of the section, worked out
 * of its snapshot, is in src/admin/brain.test.tsx.
 */
const brainPage = async (
  clientId: string,
  email = "staff@grasp.test"
): Promise<{ html: string }> => {
  const report = await callServerFn(
    fetchBrainReport,
    { clientId },
    { email }
  ).catch(() => null);
  return {
    html: await rendered(
      createElement(BrainHealth, {
        clientId,
        read: Promise.resolve({ state: "read" as const, report }),
      })
    ),
  };
};

/** The text of `html`, its tags gone and its spaces one. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll("&#x27;", "'");

/** The Recall section of a page's HTML: from its title to the next section's. */
const recallPartOf = (html: string): string =>
  html.slice(html.indexOf(">Recall<"), html.indexOf(">Model spend<"));

/** The Model spend section of a page's HTML. */
const spendPartOf = (html: string): string =>
  html.slice(html.indexOf(">Model spend<"), html.indexOf(">Erasures<"));

/** The Upkeep section of a page's HTML. */
const upkeepPartOf = (html: string): string =>
  html.slice(
    html.indexOf(">Upkeep<"),
    html.indexOf(">People&#x27;s own stores<")
  );

/** The Synced connections section of a page's HTML. */
const syncedPartOf = (html: string): string =>
  html.slice(html.indexOf(">Synced connections<"), html.indexOf(">Recall<"));

/** One sync of one connection, as core reports it: fine unless `more` says otherwise. */
const syncRow = (
  connection: string,
  more: Partial<BrainSyncConnection> = {}
): BrainSyncConnection => ({
  connection,
  provider: "google",
  feed: "gmail",
  phase: "changes",
  items: 1200,
  syncedAt: "2026-11-12T09:58:00.000Z",
  behindSince: null,
  relistOverdue: false,
  error: null,
  failing: false,
  ...more,
});

/** The part of `html` that shows people's own stores. */
const ownStoresPartOf = (html: string): string =>
  html.slice(
    html.indexOf(">People&#x27;s own stores<"),
    html.indexOf(">Engine<")
  );

describe("how an organization's Brain is doing", () => {
  useStoreSecrets({ deployer: token });

  it("shows its queue, parked items with their error, its store and its ledger, asked of its core as the staff member", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    acme.core.brain = brainReport(1_200_000_000);

    const { html } = await brainPage(acme.clientId, "grace@grasp.test");
    const text = textOf(html);

    expect({
      waiting: text.includes(
        "Waiting 12 brain.embed: oldest added 1 hour ago, 2 running"
      ),
      parked: text.includes("What it works on can't be read. unreadable"),
      requeue: html.includes(">Requeue</button>"),
      store: text.includes("1.2 GB 12% of 10.0 GB"),
      near: text.includes("Near its limit"),
      ledger: text.includes("Read through"),
      embedding: [
        text.includes("Embedding model test-model@0a1b"),
        text.includes("Embedded 38 of 40 passages"),
        html.includes(">Re-embed</button>"),
      ],
      erased: text.includes(
        "3 deleted for good, 0 past their retention, 0 people erased, and 1 withdrawn"
      ),
      askedBy: acme.core.brainAsks.map((asked) => asked.staff.email),
    }).toStrictEqual({
      waiting: true,
      parked: true,
      requeue: true,
      store: true,
      near: false,
      ledger: true,
      embedding: [true, true, true],
      erased: true,
      askedBy: ["grace@grasp.test"],
    });
  });

  it("flags a store near its limit before writes fail, and a ledger not read through", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(8_000_000_000);
    acme.core.brain = {
      ...report,
      ledger: { ...report.ledger, replay: "replaying" },
      queue: {
        ...report.queue,
        paused: {
          reason: "rate_limited",
          since: "2026-11-12T09:50:00.000Z",
          until: "2026-11-12T10:05:00.000Z",
        },
      },
    };

    const { html } = await brainPage(acme.clientId);
    const text = textOf(html);

    expect({
      near: text.includes(
        "Near its limit of 10.0 GB: writes fail once it is full"
      ),
      ledger: text.includes(
        "Replaying after a restore The Brain answers nothing until it is read through"
      ),
      paused: text.includes(
        "Since 10 min ago: the model is limiting its calls. It tries again in 5 min."
      ),
    }).toStrictEqual({ near: true, ledger: true, paused: true });
  });

  it("says when its core doesn't answer how its Brain is doing", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");

    const { html } = await brainPage(acme.clientId);
    const text = textOf(html);

    expect(
      text.includes("The company’s Grasp didn’t answer how its Brain is doing.")
    ).toBeTruthy();
  });

  it("requeues a parked item and rebuilds the word indexes as the staff member, and sends nothing for a caller Access doesn't vouch for", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);
    const requeue = {
      clientId: acme.clientId,
      action: { type: "requeue", item: 41 },
    } as const;

    const refused = await callServerFn(brainActionFn, requeue, {
      email: null,
    }).then(
      () => "answered",
      () => "refused"
    );
    const asksBefore = acme.core.brainAsks.length;
    const requeued = await callServerFn(brainActionFn, requeue, {
      email: "grace@grasp.test",
    });
    acme.core.brainOutcome = "nothing";
    const rebuilt = await callServerFn(
      brainActionFn,
      { clientId: acme.clientId, action: { type: "rebuild_words" } },
      { email: "grace@grasp.test" }
    );

    expect({
      refused,
      asksBefore,
      requeued,
      rebuilt,
      asked: acme.core.brainAsks.map((asked) =>
        "action" in asked ? [asked.staff.email, asked.action] : null
      ),
    }).toStrictEqual({
      refused: "refused",
      asksBefore: 0,
      requeued: { outcome: "done" },
      rebuilt: { outcome: "nothing" },
      asked: [
        ["grace@grasp.test", { type: "requeue", item: 41 }],
        ["grace@grasp.test", { type: "rebuild_words" }],
      ],
    });
  });

  it("asks its core nothing on a preload, and reads it once the section is opened", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);

    const preloaded = await loadBrainRead({
      clientId: acme.clientId,
      preload: true,
      read,
    });
    const asksAfterPreload = acme.core.brainAsks.length;
    const opened = await loadBrainRead({
      clientId: acme.clientId,
      preload: false,
      read,
    });

    expect({
      preloaded,
      asksAfterPreload,
      opened: opened.state,
      asks: acme.core.brainAsks.length,
    }).toStrictEqual({
      preloaded: { state: "not_asked" },
      asksAfterPreload: 0,
      opened: "read",
      asks: 1,
    });
  });

  it("reads nothing of its core for a caller Access doesn't vouch for", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);

    const outcome = await callServerFn(
      fetchBrainReport,
      { clientId: acme.clientId },
      { email: null }
    ).then(
      () => "answered",
      () => "refused"
    );

    expect({ outcome, asks: acme.core.brainAsks.length }).toStrictEqual({
      outcome: "refused",
      asks: 0,
    });
  });

  it("offers a re-embed while a rebuild waits on parked items, and points at them", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(1_000_000);
    acme.core.brain = {
      ...report,
      embedding: { ...report.embedding, rebuilding: true },
    };

    const { html } = await brainPage(acme.clientId);
    const text = textOf(html);
    const button = /<button[^>]*>Re-embed<\/button>/u.exec(html)?.[0] ?? "";

    expect({
      shown: button !== "",
      disabled: button.includes(' disabled=""'),
      pointer: text.includes(
        "It waits on what it put on the queue, parked items included: see Parked above."
      ),
      // Passed over is the embedder's verdict on the text: shown, not flagged.
      passedOver: text.includes("found by words only, until a re-embed. 2 "),
    }).toStrictEqual({
      shown: true,
      disabled: false,
      pointer: true,
      passedOver: true,
    });
  });

  it("says in one line that no embedding model runs, and offers no re-embed", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(1_000_000);
    acme.core.brain = {
      ...report,
      embedding: {
        model: null,
        chunks: 40,
        embedded: 0,
        passedOver: 0,
        rebuilding: false,
      },
    };

    const { html } = await brainPage(acme.clientId);
    const text = textOf(html);

    expect({
      line: text.includes(
        "No embedding model runs yet, so the Brain recalls by words alone."
      ),
      counts: text.includes("Embedded 0 of 40"),
      reembed: html.includes(">Re-embed</button>"),
    }).toStrictEqual({ line: true, counts: false, reembed: false });
  });

  it("re-embeds as the staff member", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);

    const answered = await callServerFn(
      brainActionFn,
      { clientId: acme.clientId, action: { type: "reembed" } },
      { email: "grace@grasp.test" }
    );

    expect({
      answered,
      asked: acme.core.brainAsks.map((asked) =>
        "action" in asked ? [asked.staff.email, asked.action] : null
      ),
    }).toStrictEqual({
      answered: { outcome: "done" },
      asked: [["grace@grasp.test", { type: "reembed" }]],
    });
  });

  it("shows an embedding step that failed in its Upkeep, in amber", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(1_000_000);
    acme.core.brain = {
      ...report,
      stepsFailed: {
        ...report.stepsFailed,
        embedding: { at: "2026-11-12T09:55:00.000Z", reason: "failed" },
      },
    };

    const { html } = await brainPage(acme.clientId);
    const label = "Putting passages on the queue to embed";
    const row = html.slice(
      html.indexOf(label),
      html.indexOf("</div>", html.indexOf("Failed 5 min ago"))
    );

    expect({
      shown: textOf(row).includes(`${label} Failed 5 min ago`),
      amber: row.includes("text-status-attention"),
    }).toStrictEqual({ shown: true, amber: true });
  });

  it("shows recall by each way since the store started, a way that failed in amber, and recalls without meaning by reason", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(1_000_000);
    const calm = await liveClient();
    calm.core.admin = heardSnapshot("Calm");
    calm.core.brain = report;
    acme.core.brain = {
      ...report,
      recall: {
        since: "2026-11-12T08:00:00.000Z",
        ways: {
          words: { recalls: 40, failed: 0 },
          exact: { recalls: 8, failed: 0 },
          entities: { recalls: 0, failed: 0 },
          meaning: { recalls: 30, failed: 2 },
        },
        withoutMeaning: { timed_out: 3, failed: 0, refused: 1, unusable: 0 },
      },
    };

    const { html: acmeHtml } = await brainPage(acme.clientId);
    const { html: calmHtml } = await brainPage(calm.clientId);
    const failing = recallPartOf(acmeHtml);
    const fine = recallPartOf(calmHtml);
    const text = textOf(failing);

    expect({
      since: text.includes("Since the store last started, 2 hours ago."),
      ways: [
        text.includes("Words 40 0"),
        text.includes("Exact parts 8 0"),
        text.includes("Meaning 30 2"),
      ],
      without: text.includes(
        "3 timed out, 0 failed, 1 refused, and 0 unusable"
      ),
      amber: failing.includes("text-status-attention"),
      notYet: textOf(fine).includes("Meaning 0 0"),
      calm: fine.includes("text-status-attention"),
    }).toStrictEqual({
      since: true,
      ways: [true, true, true],
      without: true,
      amber: true,
      notYet: true,
      calm: false,
    });
  });

  it("asks its core whether a source or a person was erased as the staff member, says what it answered, and sends nothing for a caller Access doesn't vouch for", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);
    const source = {
      clientId: acme.clientId,
      lookup: { kind: "source", key: "upload:0193-report" },
    } as const;

    const refused = await callServerFn(brainErasureFn, source, {
      email: null,
    }).then(
      () => "answered",
      () => "refused"
    );
    const asksBefore = acme.core.brainAsks.length;
    acme.core.brainErasure = {
      state: "erased",
      at: "2026-11-10T09:30:00.000Z",
    };
    const erased = await callServerFn(brainErasureFn, source, {
      email: "grace@grasp.test",
    });
    acme.core.brainErasure = { state: "not_erased" };
    const someone = await callServerFn(
      brainErasureFn,
      { clientId: acme.clientId, lookup: { kind: "person", id: "user-17" } },
      { email: "grace@grasp.test" }
    );
    const { html } = await brainPage(acme.clientId);

    expect({
      refused,
      asksBefore,
      erased,
      someone,
      asked: acme.core.brainAsks.flatMap((asked) =>
        "lookup" in asked ? [[asked.staff.email, asked.lookup]] : []
      ),
      offered: textOf(html).includes("Was it erased?"),
    }).toStrictEqual({
      refused: "refused",
      asksBefore: 0,
      erased: { state: "erased", at: "2026-11-10T09:30:00.000Z" },
      someone: { state: "not_erased" },
      asked: [
        ["grace@grasp.test", { kind: "source", key: "upload:0193-report" }],
        ["grace@grasp.test", { kind: "person", id: "user-17" }],
      ],
      offered: true,
    });
  });

  it("reads a skipped erasure as such, and an erasure state it doesn't name, or one without what it needs, as not answered", async () => {
    const acme = await liveClient();
    acme.core.brain = brainReport(1_000_000);
    const asked = async (answered: { state: string; at?: string }) => {
      acme.core.brainErasure = answered;
      return await callServerFn(
        brainErasureFn,
        { clientId: acme.clientId, lookup: { kind: "person", id: "user-17" } },
        { email: "grace@grasp.test" }
      );
    };

    expect({
      skipped: await asked({ state: "skipped" }),
      unnamed: await asked({ state: "withheld_by_policy" }),
      erasedWithoutWhen: await asked({ state: "erased" }),
    }).toStrictEqual({
      skipped: { state: "skipped" },
      unnamed: { state: "not_answered" },
      erasedWithoutWhen: { state: "not_answered" },
    });
  });

  it("shows an erasure lookup's answer only for the lookup submitted last, while it is still what is typed", () => {
    const yesForA: LookupAnswer = {
      kind: "source",
      name: "upload:a",
      asked: 1,
      text: "Yes",
      wrong: false,
    };
    // Looked up A, answered yes; then B typed, not yet submitted.
    const forA = answerShown(yesForA, "source", "upload:a", 1);
    const afterTypingB = answerShown(yesForA, "source", "upload:b", 1);
    const afterKindChanged = answerShown(yesForA, "person", "upload:a", 1);
    // A slow answer for A arriving once B was typed and submitted (2): kept
    // apart from B's, never shown for B.
    const slowA = answerShown(
      answerKept(null, yesForA),
      "source",
      "upload:b",
      2
    );
    // B's answer came first; A's slow one doesn't replace it.
    const noForB: LookupAnswer = {
      ...yesForA,
      name: "upload:b",
      asked: 2,
      text: "No",
    };
    const keptB = answerShown(
      answerKept(noForB, yesForA),
      "source",
      "upload:b",
      2
    );

    expect({
      forA: forA?.text,
      afterTypingB,
      afterKindChanged,
      slowA,
      keptB: keptB?.text,
    }).toStrictEqual({
      forA: "Yes",
      afterTypingB: null,
      afterKindChanged: null,
      slowA: null,
      keptB: "No",
    });
  });

  it("shows what the Brain's model calls spent this month by purpose, and a month without any as such", async () => {
    const report = brainReport(1_000_000);
    const spent = await liveClient();
    spent.core.admin = heardSnapshot("Spent");
    spent.core.brain = {
      ...report,
      modelSpend: {
        month: "2026-11",
        purposes: [
          {
            purpose: "brain.extract",
            calls: 120,
            inputTokens: 2_400_000,
            outputTokens: 36_000,
            cost: 4.218,
          },
          {
            purpose: "brain.recall_analysis",
            calls: 900,
            inputTokens: 312_000,
            outputTokens: 9000,
            cost: 0.004,
          },
        ],
      },
    };
    const none = await liveClient();
    none.core.admin = heardSnapshot("None");
    none.core.brain = report;

    const { html: spentHtml } = await brainPage(spent.clientId);
    const { html: noneHtml } = await brainPage(none.clientId);
    const text = textOf(spendPartOf(spentHtml));

    expect({
      month: text.includes("Nov 2026, as the model gateway recorded"),
      purposes: [
        text.includes("brain.extract 120 2.4 million 36 thousand $4.22"),
        text.includes(
          "brain.recall_analysis 900 312 thousand 9 thousand under $0.01"
        ),
      ],
      dearestFirst:
        text.indexOf("brain.extract ") < text.indexOf("brain.recall_analysis"),
      none: textOf(spendPartOf(noneHtml)).includes(
        "No model calls in Nov 2026 $0.00"
      ),
    }).toStrictEqual({
      month: true,
      purposes: [true, true],
      dearestFirst: true,
      none: true,
    });
  });

  it("shows people's own stores as totals across them, a failing one in amber", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const report = brainReport(1_000_000);
    const calm = await liveClient();
    calm.core.admin = heardSnapshot("Calm");
    calm.core.brain = {
      ...report,
      ownStores: { ...noOwnStores, stores: 1 },
    };
    acme.core.brain = {
      ...report,
      ownStores: {
        stores: 12,
        waiting: 30,
        oldestWaitingAt: "2026-11-12T09:00:00.000Z",
        parked: 2,
        failing: 1,
        notRebuilt: 3,
        nearLimit: 0,
      },
    };

    const { html: acmeHtml } = await brainPage(acme.clientId);
    const { html: calmHtml } = await brainPage(calm.clientId);
    const failing = ownStoresPartOf(acmeHtml);
    const fine = ownStoresPartOf(calmHtml);
    const text = textOf(failing);

    expect({
      stores: text.includes(
        "Stores Stores holding anything, as their own upkeep last found them. 12 people"
      ),
      waiting: text.includes("Oldest added 1 hour ago. 30"),
      parked: text.includes("Parked"),
      notRebuilt: text.includes("Embedding not done"),
      amber: failing.includes("text-status-attention"),
      one: textOf(fine).includes("1 person"),
      calm: fine.includes("text-status-attention"),
    }).toStrictEqual({
      stores: true,
      waiting: true,
      parked: true,
      notRebuilt: true,
      amber: true,
      one: true,
      calm: false,
    });
  });

  it("shows the rest of the report of a core on an older release, which sends no totals of people's own stores, model spend, recall by entities nor the step judging memories, and says they aren't available yet", async () => {
    const older = await liveClient();
    older.core.admin = heardSnapshot("Older");
    const {
      ownStores: _left,
      modelSpend: _spend,
      ...report
    } = brainReport(1_000_000);
    const { entities: _entities, ...ways } = report.recall.ways;
    const { quotes: _quotes, ...steps } = report.stepsFailed;
    older.core.brain = {
      ...report,
      recall: { ...report.recall, ways },
      stepsFailed: {
        ...steps,
        embedding: { at: "2026-11-12T09:55:00.000Z", reason: "failed" },
      },
    };

    const { html } = await brainPage(older.clientId);
    const own = textOf(ownStoresPartOf(html));
    const spend = textOf(spendPartOf(html));

    const upkeep = textOf(upkeepPartOf(html));

    expect({
      rest: textOf(recallPartOf(html)).includes("Words 40 0"),
      failedStep: upkeep.includes(
        "Putting passages on the queue to embed Failed 5 min ago"
      ),
      // A step the core doesn't report shows as neither failed nor fine.
      judging: upkeep.includes("Judging memories against their sources"),
      entitiesNotYet: textOf(recallPartOf(html)).includes(
        "Entities Not available yet"
      ),
      notYet: own.includes(
        "This client’s release doesn’t report people’s own stores yet."
      ),
      totals: own.includes("Waiting"),
      spendNotYet: spend.includes(
        "This client’s release doesn’t report model spend yet."
      ),
    }).toStrictEqual({
      rest: true,
      failedStep: true,
      judging: false,
      entitiesNotYet: true,
      notYet: true,
      totals: false,
      spendNotYet: true,
    });
  });

  it("shows each synced connection by its hash, what needs someone in amber first with its error's code and when, and what is fine folded", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    const calm = await liveClient();
    calm.core.admin = heardSnapshot("Calm");
    const report = brainReport(1_000_000);
    acme.core.brain = {
      ...report,
      sync: {
        overdueRelists: 1,
        connections: [
          syncRow("0a1b2c3d4e5f"),
          syncRow("1b2c3d4e5f60", {
            feed: "drive",
            phase: "listing",
            items: 0,
            syncedAt: null,
            error: {
              code: "sync.provider_failed",
              at: "2026-11-12T09:55:00.000Z",
            },
            failing: true,
          }),
          syncRow("2c3d4e5f6071", {
            feed: "calendar",
            behindSince: "2026-11-12T08:00:00.000Z",
            relistOverdue: true,
          }),
        ],
      },
    };
    calm.core.brain = {
      ...report,
      sync: {
        overdueRelists: 0,
        connections: [
          syncRow("0a1b2c3d4e5f", {
            error: { code: "sync.throttled", at: "2026-11-12T09:00:00.000Z" },
          }),
        ],
      },
    };

    const { html } = await brainPage(acme.clientId);
    const synced = syncedPartOf(html);
    const text = textOf(synced);
    const { html: calmHtml } = await brainPage(calm.clientId);
    const calmPart = syncedPartOf(calmHtml);
    const calmText = textOf(calmPart);

    expect({
      needSomeone: text.includes("Need someone"),
      count: text.includes("2 of 3"),
      failing: text.includes(
        "google · drive 1b2c3d4e5f60 · Listing everything 0 Never sync.provider_failed 5 min ago Failing"
      ),
      behind: text.includes(
        "google · calendar 2c3d4e5f6071 · Following changes 1,200 2 min ago None Behind since 2 hours ago Relist past its day"
      ),
      // The fine one after them, folded under Details.
      fineLast: text.indexOf("0a1b2c3d4e5f") > text.indexOf("2c3d4e5f6071"),
      details: synced.includes(">Details</button>"),
      amber: synced.includes("text-status-attention"),
      calm: {
        none: calmText.includes("its daily relist past its day. None"),
        keptError: calmText.includes("sync.throttled 1 hour ago Fine"),
        amber: calmPart.includes("text-status-attention"),
      },
    }).toStrictEqual({
      needSomeone: true,
      count: true,
      failing: true,
      behind: true,
      fineLast: true,
      details: true,
      amber: true,
      calm: { none: true, keptError: true, amber: false },
    });
  });

  it("reads the report of a core that counts overdue relists but lists no connections, and says its synced connections aren't available yet", async () => {
    const between = await liveClient();
    between.core.admin = heardSnapshot("Between");
    between.core.brain = {
      ...brainReport(1_000_000),
      sync: { overdueRelists: 2 },
    };

    const { html } = await brainPage(between.clientId);

    expect({
      rest: textOf(recallPartOf(html)).includes("Words 40 0"),
      notYet: textOf(syncedPartOf(html)).includes(
        "This client’s release doesn’t report its synced connections yet."
      ),
    }).toStrictEqual({ rest: true, notYet: true });
  });

  it("says a core on an older release doesn't report its synced connections yet", async () => {
    const older = await liveClient();
    older.core.admin = heardSnapshot("Older");
    older.core.brain = brainReport(1_000_000);

    const { html } = await brainPage(older.clientId);

    expect(textOf(syncedPartOf(html))).toContain(
      "This client’s release doesn’t report its synced connections yet."
    );
  });

  it("shows the report of a core on a newer release, which reports a step this admin doesn't know, with the steps it knows", async () => {
    const newer = await liveClient();
    newer.core.admin = heardSnapshot("Newer");
    const report = brainReport(1_000_000);
    const stepsFailed = {
      ...report.stepsFailed,
      later: { at: "2026-11-12T09:55:00.000Z", reason: "failed" } as const,
      quotes: { at: "2026-11-12T09:55:00.000Z", reason: "timed_out" } as const,
    };
    newer.core.brain = { ...report, stepsFailed };

    const { html } = await brainPage(newer.clientId);

    expect({
      rest: textOf(recallPartOf(html)).includes("Words 40 0"),
      upkeep: textOf(upkeepPartOf(html)).includes(
        "Judging memories against their sources Timed out 5 min ago"
      ),
    }).toStrictEqual({ rest: true, upkeep: true });
  });
});
