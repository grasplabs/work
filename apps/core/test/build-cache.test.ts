import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  forgetReceipts,
  quarantineKeepMs,
  readVerified,
  sweepReceipts,
  throughCache,
  waitBackoff,
} from "../src/build-cache.ts";

// The build cache's lease, called as screens.ts calls it, with core's D1
// and R2: a holder that outlived its lease and finished late never
// replaces what the build that took the lease over kept (build-cache.ts).

describe("the build cache's lease", { timeout: 30_000 }, () => {
  it("keeps nothing of a holder that lost its lease over the build that took it over", async () => {
    const key = `screen-builds/test/${crypto.randomUUID()}.json`;
    const late = Promise.withResolvers<boolean>();
    const building = Promise.withResolvers<boolean>();
    // A lease shorter than this build: it runs out while it builds.
    const slow = throughCache(
      env,
      key,
      200,
      async () => {
        building.resolve(true);
        await late.promise;
        return { text: '{"ok":true,"by":"slow"}', cache: true };
      },
      () => ({})
    );
    // It holds the lease and builds; then its lease runs out.
    await building.promise;
    await scheduler.wait(400);
    // Its lease ran out: this one takes it over, and keeps its build.
    const fast = await throughCache(
      env,
      key,
      10_000,
      async () =>
        await Promise.resolve({ text: '{"ok":true,"by":"fast"}', cache: true }),
      () => ({})
    );
    late.resolve(true);
    const slowAnswered = await slow;
    const kept = await readVerified(env, key);

    expect({
      fast: fast.text,
      // The slow one still answers its own build, and keeps none of it.
      slow: slowAnswered.text,
      kept: kept.state === "hit" ? kept.text : kept.state,
    }).toStrictEqual({
      fast: '{"ok":true,"by":"fast"}',
      slow: '{"ok":true,"by":"slow"}',
      kept: '{"ok":true,"by":"fast"}',
    });
  });

  it("waits for another holder backing off, not polling core's database at a fixed rate", async () => {
    const key = `screen-builds/test/${crypto.randomUUID()}.json`;
    await env.DB.prepare(
      "INSERT INTO build_receipts (key, holder, lease_expires_at) VALUES (?, 'elsewhere', ?)"
    )
      .bind(key, Date.now() + 60_000)
      .run();
    // Core's database, counting the waiter's tries for the lease.
    let tries = 0;
    const counting = new Proxy(env.DB, {
      get: (target, property) => {
        if (property === "prepare") {
          return (query: string): D1PreparedStatement => {
            if (query.startsWith('insert into "build_receipts"')) {
              tries += 1;
            }
            return target.prepare(query);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const giveUp = new AbortController();
    const waiting = throughCache(
      { ...env, DB: counting },
      key,
      60_000,
      async () => await Promise.resolve({ text: "{}", cache: true }),
      () => ({}),
      giveUp.signal
    ).catch(() => "given up");
    // About four seconds: 250, 500, 1000 and 2000 ms between tries, where
    // a fixed 250 would have tried some sixteen times.
    const window = waitBackoff.firstMs * 15;
    await scheduler.wait(window);
    giveUp.abort(new Error("Done waiting"));
    await waiting;

    expect(tries).toBeLessThanOrEqual(6);
    expect(tries).toBeGreaterThanOrEqual(3);
  });

  it("sweeps receipts that hold nothing, and quarantines a day old, and keeps the rest", async () => {
    const now = Date.now();
    const id = crypto.randomUUID();
    const rows = {
      dead: [`dead-${id}`, null, "gone", now - 1000, null],
      leased: [`leased-${id}`, null, "here", now + 60_000, null],
      kept: [`kept-${id}`, `kept-${id}~h`, null, null, null],
      oldQuarantine: [
        `old-${id}`,
        `old-${id}~h`,
        null,
        null,
        now - quarantineKeepMs - 1000,
      ],
      newQuarantine: [`new-${id}`, `new-${id}~h`, null, null, now - 1000],
      // A day-old quarantine a build holds the lease of now: kept.
      leasedQuarantine: [
        `leasedold-${id}`,
        `leasedold-${id}~h`,
        "here",
        now + 60_000,
        now - quarantineKeepMs - 1000,
      ],
    };
    for (const [key, objectKey, holder, lease, quarantined] of Object.values(
      rows
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one row after another
      await env.DB.prepare(
        "INSERT INTO build_receipts (key, object_key, holder, lease_expires_at, quarantined_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(key, objectKey, holder, lease, quarantined)
        .run();
    }

    await sweepReceipts(env, new Date(now));
    const { results } = await env.DB.prepare(
      "SELECT key FROM build_receipts WHERE key LIKE ?"
    )
      .bind(`%${id}%`)
      .all<{ key: string }>();

    expect(
      results.map(({ key }) => key.replace(`-${id}`, "")).toSorted()
    ).toStrictEqual(["kept", "leased", "leasedold", "new"]);
  });

  it("forgets a swept object's receipt but not a live lease, so the row goes once nothing holds it", async () => {
    const now = Date.now();
    const id = crypto.randomUUID();
    const rows = [
      // Kept, nobody building: forgotten, then swept.
      [`idle-${id}`, `idle-${id}~h`, null, null],
      // Kept, with a lease that ran out: the same.
      [`expired-${id}`, `expired-${id}~h`, "gone", now - 1000],
      // Kept, with a build holding the lease now: the lease stays.
      [`live-${id}`, `live-${id}~h`, "here", now + 60_000],
    ] as const;
    for (const [key, objectKey, holder, lease] of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one row after another
      await env.DB.prepare(
        "INSERT INTO build_receipts (key, object_key, sha256, holder, lease_expires_at) VALUES (?, ?, 'h', ?, ?)"
      )
        .bind(key, objectKey, holder, lease)
        .run();
    }

    await forgetReceipts(
      env,
      rows.map(([, objectKey]) => objectKey)
    );
    await sweepReceipts(env, new Date(now));
    const { results } = await env.DB.prepare(
      "SELECT key, object_key AS objectKey, holder FROM build_receipts WHERE key LIKE ?"
    )
      .bind(`%${id}%`)
      .all<{ key: string; objectKey: string | null; holder: string | null }>();

    expect(
      results.map(({ key, objectKey, holder }) => ({
        key: key.replace(`-${id}`, ""),
        objectKey,
        holder,
      }))
    ).toStrictEqual([{ key: "live", objectKey: null, holder: "here" }]);
  });
});
