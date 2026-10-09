import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import {
  onboardingSummaryPath,
  onboardingSummaryPurpose,
  onboardingSummarySchema,
} from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { onboardingStore } from "../src/onboarding/store.ts";
import { summaryOf } from "../src/onboarding/summary.ts";
import { routed } from "./sign-in.ts";

// The onboarding summary for the console (src/onboarding/summary.ts): only
// the console may read it, and what it reads is numbers only. The ways it
// can fail, tried here:
//
// - Anyone but the console reading it: unsigned, signed with another key,
//   sent long ago, or not a request at all.
// - A name, a team or a word anyone said reaching the console.

/** A name nobody else uses, to look for where it must not be. */
const sentinel = "Ottoline Brackenbury";

/** `body`'s signature as the console makes it, with the key `secret` gives. */
const signatureOf = async (
  body: string,
  secret = env.BETTER_AUTH_SECRET,
  purpose = onboardingSummaryPurpose
): Promise<string> => {
  const key = await hkdfHmacKey(secret, purpose, ["sign"]);
  return toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
};

/** Asks core for the summary through the router, signed with `signature`. */
const ask = async (
  body: string,
  signature: string | null,
  method = "POST"
): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) {
    headers.set(platformUpdateSignatureHeader, signature);
  }
  return await routed(onboardingSummaryPath, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

const bodyAt = (sentAt = new Date().toISOString()) =>
  JSON.stringify({ sentAt });

describe("the onboarding summary", () => {
  it("answers the console's signed request with numbers only", async () => {
    const store = onboardingStore(env);
    const by = { type: "system" } as const;
    await store.saveRoster(
      {
        teams: [
          { id: "sales", name: "Sales", lead: "lea", does: "", off: false },
        ],
        people: [
          {
            id: "lea",
            name: sentinel,
            email: "",
            team: "sales",
            title: "",
            away: false,
          },
        ],
      },
      by
    );
    const body = bodyAt();

    const response = await ask(body, await signatureOf(body));
    const text = await response.text();

    expect({
      status: response.status,
      cache: response.headers.get("cache-control"),
      summary: onboardingSummarySchema.parse(JSON.parse(text)),
    }).toStrictEqual({
      status: 200,
      cache: "no-store",
      // On the roster, the gate never closed: the company is in. The
      // agreements aren't in yet, which waits on staff.
      summary: { stage: "open", day: null, days: null, known: 25, needs: 1 },
    });
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain("Sales");
  });

  it("refuses anyone but the console: unsigned, signed otherwise, sent long ago, or no request at all", async () => {
    const fresh = bodyAt();
    const old = bodyAt(new Date(Date.now() - 10 * 60 * 1000).toISOString());
    const statuses = await Promise.all([
      ask(fresh, null),
      ask(fresh, await signatureOf(fresh, "another-secret")),
      // A platform update's key signs nothing here.
      ask(
        fresh,
        await signatureOf(
          fresh,
          env.BETTER_AUTH_SECRET,
          "grasp-os platform update key"
        )
      ),
      ask(old, await signatureOf(old)),
      ask("{}", await signatureOf("{}")),
      ask(fresh, await signatureOf(fresh), "GET"),
    ]);
    expect(statuses.map(({ status }) => status)).toStrictEqual([
      403, 403, 403, 403, 403, 404,
    ]);
  });
});

/** Nine in the morning of `day`. */
const at = (day: string) => `${day}T09:00:00.000Z`;

/** An onboarding with a roster, interviews from 1 to 14 October 2031. */
const view = (more: Partial<OnboardingView> = {}): OnboardingView => ({
  roster: { teams: [], people: [] },
  plan: { start: "2031-10-01", days: 14 },
  progress: null,
  agreed: true,
  paused: false,
  ...more,
});

/** A gate closed for the onboarding, `known` percent known. */
const closed = (known: number, ready = false): GateView => ({
  open: false,
  closedSince: "2031-09-20T09:00:00.000Z",
  threshold: 80,
  known,
  parts: [],
  ready,
  over: false,
  openedAt: null,
  staff: null,
});

describe("where the summary says an onboarding stands", () => {
  it("is preparing before the interviews, on its day during them, and waiting for the go after them or once enough is known", () => {
    expect([
      summaryOf(view(), closed(25), at("2031-09-30")),
      summaryOf(view(), closed(40), at("2031-10-04")),
      summaryOf(view(), closed(40), at("2031-10-14")),
      summaryOf(view(), closed(55), at("2031-10-15")),
      summaryOf(view(), closed(85, true), at("2031-10-10")),
    ]).toStrictEqual([
      { stage: "preparing", day: null, days: 14, known: 25, needs: 0 },
      { stage: "interviews", day: 4, days: 14, known: 40, needs: 0 },
      { stage: "interviews", day: 14, days: 14, known: 40, needs: 0 },
      { stage: "waiting", day: null, days: 14, known: 55, needs: 0 },
      // The go waits on staff.
      { stage: "waiting", day: 10, days: 14, known: 85, needs: 1 },
    ]);
  });

  it("counts what waits on staff: the agreements, a pause, the go", () => {
    expect(
      summaryOf(
        view({ agreed: false, paused: true }),
        closed(90, true),
        "2031-10-05T09:00:00.000Z"
      ).needs
    ).toBe(3);
  });

  it("counts missing agreements while the company is in too: they hold up the interviews either way", () => {
    const open: GateView = { ...closed(30), open: true, closedSince: null };
    expect([
      summaryOf(view({ agreed: false }), open, at("2031-10-05")).needs,
      summaryOf(
        view({ roster: null, plan: null, agreed: false }),
        open,
        at("2031-10-05")
      ).needs,
    ]).toStrictEqual([1, 0]);
  });
});
