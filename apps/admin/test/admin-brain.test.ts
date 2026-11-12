import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import type { BrainReport } from "@grasp-os/shared/brain-report";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadBrainRead } from "../src/admin/brain-loads.ts";
import {
  brainActionFn,
  fetchBrainReport,
} from "../src/clients/brain-functions.ts";
import { readBrainReport } from "../src/clients/brain.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn, page } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

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

/** An interview `person` agreed to, with `facts` kept and none taken out. */
const agreedInterview = (
  person: string,
  kind: "own" | "lead",
  facts: number,
  at: string
): AdminSnapshot["interviews"][number] => ({
  person,
  kind,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  agreed: true,
  phase: "readback",
  stoppedAt: null,
  minutes: 30,
  facts,
  out: 0,
  confirmed: facts,
  rating: null,
  typed: false,
  interviewer: null,
});

/** When the interviews started, and every link went out. */
const started = "2026-10-05T07:00:00.000Z";

/** Someone in `team`. */
const person = (id: string, team: string) => ({
  id,
  name: `Person ${id}`,
  email: `${id}@acme.test`,
  team,
  title: "",
  away: false,
});

/** The link `id` was sent at the interviews' start, and where they stand. */
const link = (id: string, state: "completed" | "opened") => ({
  person: id,
  sentAt: started,
  openedAt: started,
  remindedAt: null,
  deletedAt: null,
  failedMail: null,
  state,
});

/**
 * A company told about its interviews, with two teams taking part and one
 * that doesn't: in Sales two people agreed to theirs (6 and 4 facts), in
 * Operations nobody has yet.
 */
const heardSnapshot = (name: string): AdminSnapshot => {
  const empty = emptyAdminSnapshot(name);
  const at = "2026-10-06T09:00:00.000Z";
  return {
    ...empty,
    roster: {
      teams: [
        { id: "sales", name: "Sales", lead: "lisa", does: "", off: false },
        { id: "ops", name: "Operations", lead: "otto", does: "", off: false },
        { id: "legal", name: "Legal", lead: null, does: "", off: true },
      ],
      people: [
        person("lisa", "sales"),
        person("tom", "sales"),
        person("otto", "ops"),
        person("lena", "legal"),
      ],
    },
    plan: { start: "2026-10-05", days: 14, at: started },
    agreed: true,
    told: true,
    mapped: ["sales", "ops"],
    links: [
      link("lisa", "completed"),
      link("tom", "completed"),
      link("otto", "opened"),
    ],
    interviews: [
      agreedInterview("lisa", "lead", 6, at),
      agreedInterview("tom", "own", 4, at),
    ],
    gate: { ...empty.gate, known: 42 },
  };
};

describe("an organization's brain", () => {
  useStoreSecrets({ deployer: token });

  it("says the brain itself isn't shared, and makes up no source's share", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");

    const { status, html } = await page(
      `/organizations/${acme.clientId}/brain`
    );

    expect({
      status,
      toCome: html.includes("This section isn’t in the admin yet."),
      notShared: html.includes(
        `${acme.name} doesn’t share its brain with Grasp’s staff, so only its counts show here.`
      ),
      // Core counts what is known as one number: no source's share is made up.
      sources: html.includes("How much of each source is in"),
      sourcesWhy: html.includes(
        "The company’s own Grasp counts what is known as one number"
      ),
    }).toStrictEqual({
      status: 200,
      toCome: false,
      notShared: true,
      sources: false,
      sourcesWhy: true,
    });
  });
});

/** The Brain as a core reports it: a parked item, a store of `bytes`, a ledger through. */
/** Totals of people's own stores while none holds anything. */
const noOwnStores = {
  stores: 0,
  waiting: 0,
  oldestWaitingAt: null,
  parked: 0,
  failing: 0,
  notRebuilt: 0,
  nearLimit: 0,
};

const brainReport = (bytes: number): BrainReport => ({
  now: "2026-11-12T10:00:00.000Z",
  queue: {
    waiting: [
      {
        kind: "brain.embed",
        count: 12,
        oldestAddedAt: "2026-11-12T09:00:00.000Z",
      },
    ],
    running: 2,
    overdue: 0,
    paused: null,
    parked: [
      {
        item: 41,
        kind: "brain.extract",
        attempts: 5,
        parks: 1,
        final: false,
        error: "unreadable",
        message: "What it works on can't be read.",
        parkedAt: "2026-11-12T08:00:00.000Z",
      },
    ],
    parkedCount: 1,
  },
  store: { bytes, limitBytes: 10_000_000_000 },
  words: "current",
  embedding: {
    model: "test-model@0a1b",
    chunks: 40,
    embedded: 38,
    passedOver: 2,
    rebuilding: false,
  },
  ledger: {
    replay: "through",
    erasing: 0,
    sourcesWithoutCurrent: 0,
    source: { written: 3, unwritten: 0 },
    person: { written: 1, unwritten: 0 },
    byReason: { deleted: 3, retention: 0, person_erased: 0, withdrawn: 1 },
  },
  stepsFailed: {
    ledger: null,
    erase: null,
    sweep: null,
    repack: null,
    reindex: null,
    embedding: null,
  },
  recall: {
    since: "2026-11-12T08:00:00.000Z",
    ways: {
      words: { recalls: 40, failed: 0 },
      exact: { recalls: 8, failed: 0 },
      entities: { recalls: 0, failed: 0 },
      meaning: { recalls: 0, failed: 0 },
    },
    withoutMeaning: { timed_out: 0, failed: 0, refused: 0, unusable: 0 },
  },
  ownStores: noOwnStores,
});

/** A read of a client's Brain from its core, as the section's server function makes it. */
const read = async (clientId: string) =>
  await readBrainReport(env, { email: "grace@grasp.test" }, clientId);

/** The text of `html`, its tags gone and its spaces one. */
const textOf = (html: string): string =>
  html
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll("&#x27;", "'");

/** The Recall section of a page's HTML: from its title to the next section's. */
const recallPartOf = (html: string): string =>
  html.slice(html.indexOf(">Recall<"), html.indexOf(">Erasures<"));

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

    const { status, html } = await page(
      `/organizations/${acme.clientId}/brain`,
      "grace@grasp.test"
    );
    const text = textOf(html);

    expect({
      status,
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
      status: 200,
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

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
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

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
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

  it("shows the rest of the section while its core is slow, and the report once it answers", async () => {
    const acme = await liveClient();
    acme.core.admin = heardSnapshot("Acme");
    acme.core.brain = brainReport(1_000_000);
    const held = Promise.withResolvers<boolean>();
    acme.core.brainHeld = async () => {
      await held.promise;
    };
    const reading = "Reading how its Brain is doing from its core";

    const response = await exports.default.fetch(
      `https://ops.grasp.test/organizations/${acme.clientId}/brain`,
      {
        headers: {
          "cf-access-jwt-assertion": await accessJwt("staff@grasp.test"),
        },
      }
    );
    const reader = response.body
      ?.pipeThrough(new TextDecoderStream())
      .getReader();
    let html = "";
    // The page streams: read until it says it is reading, its core held.
    while (!html.includes(reading)) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        break;
      }
      html += chunk.value;
    }
    const beforeAnswer = {
      counts: html.includes(">What it stands on</h2>"),
      reading: html.includes(reading),
      report: html.includes("The Brain at work"),
    };
    held.resolve(true);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk after another
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        break;
      }
      html += chunk.value;
    }

    expect({
      beforeAnswer,
      report: html.includes('aria-label="The Brain at work"'),
    }).toStrictEqual({
      beforeAnswer: { counts: true, reading: true, report: false },
      report: true,
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

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
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

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
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

    const { html } = await page(`/organizations/${acme.clientId}/brain`);
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

    const { html: acmeHtml } = await page(
      `/organizations/${acme.clientId}/brain`
    );
    const { html: calmHtml } = await page(
      `/organizations/${calm.clientId}/brain`
    );
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

    const { html: acmeHtml } = await page(
      `/organizations/${acme.clientId}/brain`
    );
    const { html: calmHtml } = await page(
      `/organizations/${calm.clientId}/brain`
    );
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

  it("shows the rest of the report of a core on an older release, which sends no totals of people's own stores, and says they aren't available yet", async () => {
    const older = await liveClient();
    older.core.admin = heardSnapshot("Older");
    const { ownStores: _left, ...report } = brainReport(1_000_000);
    older.core.brain = report;

    const { status, html } = await page(
      `/organizations/${older.clientId}/brain`
    );
    const own = textOf(ownStoresPartOf(html));

    expect({
      status,
      rest: textOf(recallPartOf(html)).includes("Words 40 0"),
      notYet: own.includes(
        "This client’s release doesn’t report people’s own stores yet."
      ),
      totals: own.includes("Waiting"),
    }).toStrictEqual({ status: 200, rest: true, notYet: true, totals: false });
  });
});
