import {
  brainReportPath,
  brainReportPurpose,
  brainReportSchema,
} from "@grasp-os/shared/brain-report";
import type {
  BrainReport,
  BrainSyncConnection,
} from "@grasp-os/shared/brain-report";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runSync } from "../src/brain-sync.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { sampleSyncControlUrl } from "./sample-sync-fake.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { auditedDuring, routed, signedInApi, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Each synced connection as Grasp's staff see it in a client's Brain
// report (src/brain-report.ts, src/brain-sync.ts `syncConnections`,
// GRA-1817): when it last synced, whether it is behind, and its latest
// error by code and time, read through the admin's signed request and in
// the company's audit log; each connection by a hash of its ID, never
// whose it is, its account or anything it holds. A file of its own: the
// runs here must see no other test's sources.

const idp = mockIdp();

/** Signing people in and connecting can be slow on CI. */
const setUpTime = { timeout: 90_000 };

const staffEmail = "grace.hopper@grasp.test";

type Person = Awaited<ReturnType<typeof signedInApi>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets what `subject`'s sample account holds (test/sample-sync-fake.ts). */
const world = async (subject: string, parts: Record<string, unknown>) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(sampleSyncControlUrl, {
    method: "POST",
    body: JSON.stringify({ subject, ...parts }),
  });
};

/**
 * `person`'s own Microsoft 365 account connected and read by connect's
 * sample sync connector, whose `files` feed is `pages`.
 */
const connectSample = async (
  person: Person,
  pages: Record<string, unknown>
): Promise<{ connectionId: string; subject: string }> => {
  const subject = String(person.person.oid);
  await world(subject, { pages });
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      acmeTenant,
      subject,
      "openid profile email offline_access User.Read Mail.ReadWrite"
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const listed = await person.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName === `${subject}@acme.test`
  );
  if (connection === undefined) {
    throw new Error(`Expected ${subject}'s connection`);
  }
  await connectDb()
    .prepare("UPDATE connections SET server = 'sample-sync' WHERE id = ?")
    .bind(connection.id)
    .run();
  return { connectionId: connection.id, subject };
};

/** A page of the feed: `changes`, read on from `next`, nothing more. */
const feedPage = (changes: unknown[], next: string) => ({
  changes,
  next,
  more: false,
});

/** A mail holding `text`, as a sync item. */
const mail = (id: string, text: string) => ({
  gone: false,
  id,
  kind: "mail",
  version: "1",
  changedAt: "2026-11-12T09:00:00.000Z",
  title: id,
  content: { type: "text", text },
  readers: null,
  changedBy: null,
  partOf: null,
});

/** Runs the sync as the clock does at `at`, with `left` calls to spend. */
const syncAt = async (at: number, left?: number): Promise<void> => {
  vi.useFakeTimers({ toFake: ["Date"], now: at });
  try {
    await runSync(env, left === undefined ? undefined : { left });
  } finally {
    vi.useRealTimers();
  }
};

/** Reads the report as the admin does, signed for a read, for `staffEmail`. */
const readReport = async (): Promise<{
  status: number;
  text: string;
  report: BrainReport | null;
}> => {
  const body = JSON.stringify({
    sentAt: new Date().toISOString(),
    staff: { email: staffEmail },
  });
  const key = await hkdfHmacKey(env.BETTER_AUTH_SECRET, brainReportPurpose, [
    "sign",
  ]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const response = await routed(brainReportPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
  const text = await response.text();
  const parsed = brainReportSchema.safeParse(
    response.ok ? JSON.parse(text) : null
  );
  return {
    status: response.status,
    text,
    report: parsed.success ? parsed.data : null,
  };
};

/** The `files` sync of `connectionId` as `report` shows it. */
const filesOf = async (
  report: BrainReport | null,
  connectionId: string
): Promise<BrainSyncConnection> => {
  const hash = await sha256Hex(connectionId);
  const row = report?.sync?.connections.find(
    (each) => each.connection === hash.slice(0, 12) && each.feed === "files"
  );
  if (row === undefined) {
    throw new Error(`Expected the files sync of ${connectionId}`);
  }
  return row;
};

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

describe("native sync, as Grasp's staff see it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "shows a connection that synced, one that fails and one that is behind, by code and time, with nothing of whose or what, and records the read",
    setUpTime,
    async () => {
      const [synced, failing, behind] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const word = `Quokka${unique()}`;
      const ok = await connectSample(synced, {
        "": feedPage([mail("memo", `Memo ${word}`)], "m1"),
        m1: feedPage([], "m1"),
      });
      const broken = await connectSample(failing, { "": feedPage([], "m1") });
      await world(broken.subject, { failing: ["files"] });
      const firstRun = Date.now();
      await syncAt(firstRun);
      // Connected two days ago, its sources made by a run whose budget
      // ran out before it read anything: no run read it since.
      const late = await connectSample(behind, { "": feedPage([], "m1") });
      const twoDaysAgo = firstRun - 2 * dayMs;
      let made = false;
      for (let left = 1; left < 20 && !made; left += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await syncAt(twoDaysAgo, left);
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        const row = await env.DB.prepare(
          "SELECT count(*) AS count FROM brain_sync_sources WHERE connection_id = ?"
        )
          .bind(late.connectionId)
          .first<{ count: number }>();
        made = (row?.count ?? 0) > 0;
      }

      let read: Awaited<ReturnType<typeof readReport>> | undefined;
      const events = await auditedDuring(async () => {
        read = await readReport();
      });
      const { status, text, report } = read ?? {
        status: 0,
        text: "",
        report: null,
      };
      const [okRow, brokenRow, lateRow] = await Promise.all([
        filesOf(report, ok.connectionId),
        filesOf(report, broken.connectionId),
        filesOf(report, late.connectionId),
      ]);
      const ago = (at: string | null): number | null =>
        at === null ? null : firstRun - Date.parse(at);

      expect({
        status,
        made,
        ok: {
          phase: okRow.phase,
          items: okRow.items,
          synced: ago(okRow.syncedAt) === 0,
          behind: okRow.behindSince,
          overdue: okRow.relistOverdue,
          error: okRow.error,
          failing: okRow.failing,
        },
        broken: {
          phase: brokenRow.phase,
          synced: brokenRow.syncedAt,
          error: brokenRow.error?.code,
          errorAt: ago(brokenRow.error?.at ?? null) === 0,
          failing: brokenRow.failing,
        },
        late: {
          synced: lateRow.syncedAt,
          behindTwoDays: ago(lateRow.behindSince) === 2 * dayMs,
          overdue: lateRow.relistOverdue,
          error: lateRow.error,
          failing: lateRow.failing,
        },
        named: [
          ok.connectionId,
          broken.connectionId,
          late.connectionId,
          ok.subject,
          synced.userId,
          word,
          "acme.test",
        ].filter((name) => text.includes(name)),
        audited: events
          .filter(({ action }) => action === "admin.brain.read")
          .map(({ actor }) => actor),
      }).toStrictEqual({
        status: 200,
        made: true,
        ok: {
          phase: "changes",
          items: 1,
          synced: true,
          behind: null,
          overdue: false,
          error: null,
          failing: false,
        },
        broken: {
          phase: "listing",
          synced: null,
          error: "sync.provider_failed",
          errorAt: true,
          failing: true,
        },
        late: {
          synced: null,
          behindTwoDays: true,
          overdue: true,
          error: null,
          failing: false,
        },
        named: [],
        audited: [{ type: "staff", userId: staffEmail, via: "console" }],
      });
    }
  );

  it(
    "keeps a connection's latest error, no longer failing, once a later read gets through",
    setUpTime,
    async () => {
      const person = await signedInApi(idp, "user");
      const { connectionId, subject } = await connectSample(person, {
        "": feedPage([], "m1"),
        m1: feedPage([], "m1"),
      });
      await world(subject, { failing: ["files"] });
      const failedAt = Date.now() + hourMs;
      await syncAt(failedAt);
      await world(subject, { failing: [] });
      await syncAt(failedAt + hourMs);

      const { report } = await readReport();
      const row = await filesOf(report, connectionId);

      expect({
        error: row.error,
        failing: row.failing,
        synced: row.syncedAt,
      }).toStrictEqual({
        error: {
          code: "sync.provider_failed",
          at: new Date(failedAt).toISOString(),
        },
        failing: false,
        synced: new Date(failedAt + hourMs).toISOString(),
      });
    }
  );

  it("shows nothing to a signed-in admin of the company without the admin's signature, and records nothing", async () => {
    const person = await signedInApi(idp, "admin");
    let status = 0;
    let text = "";
    const events = await auditedDuring(async () => {
      const answer = await routed(brainReportPath, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: person.session },
        body: JSON.stringify({
          sentAt: new Date().toISOString(),
          staff: { email: staffEmail },
        }),
      });
      ({ status } = answer);
      text = await answer.text();
    });

    expect({
      status,
      sync: text.includes("connections"),
      audited: events.filter(({ action }) => action.startsWith("admin.brain")),
    }).toStrictEqual({ status: 401, sync: false, audited: [] });
  });
});
