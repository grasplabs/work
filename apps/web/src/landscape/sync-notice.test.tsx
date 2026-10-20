import type { LandscapeSyncStatus } from "@grasp-os/shared/landscape";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatDateTime } from "../format.ts";
import { discoveredAppOf } from "./landscape-data.ts";
import { signalTextOf } from "./landscape.ts";
import { IncompleteNotice, SyncNotices } from "./sync-notice.tsx";

// How fresh the apps found in Microsoft Entra are, as admins see it, and
// how an unverified publisher shows: never as the app's vendor.

const status = (patch: Partial<LandscapeSyncStatus>): LandscapeSyncStatus => ({
  connectionId: "connection-entra",
  connection: "active",
  state: "done",
  reason: null,
  startedAt: "2026-10-20T10:00:00.000Z",
  finishedAt: "2026-10-20T10:05:00.000Z",
  wholeAt: "2026-10-20T10:00:00.000Z",
  ...patch,
});

/** The notices' text, as a person reads it. */
const textOf = (statuses: LandscapeSyncStatus[]): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <SyncNotices syncs={{ state: "ready", data: statuses }} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** The line a person who isn't an admin reads, if any. */
const lineOf = (
  incomplete: boolean,
  syncs: Parameters<typeof IncompleteNotice>[0]["syncs"]
): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <IncompleteNotice incomplete={incomplete} syncs={syncs} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll("&#x27;", "'");

describe("the landscape's freshness", () => {
  it("says when the list was last read whole, and says so when the last read stopped at its limit or failed", () => {
    const whole = formatDateTime("2026-10-20T10:00:00.000Z");
    expect({
      done: textOf([status({})]),
      partial: textOf([status({ state: "partial", wholeAt: null })]),
      failed: textOf([
        status({ state: "failed", reason: "landscape.inactive" }),
      ]),
      failedOther: textOf([
        status({ state: "failed", reason: "landscape.provider_failed" }),
      ]),
    }).toStrictEqual({
      done: `Apps found in Microsoft Entra as of ${whole}.`,
      partial:
        "The last read of Microsoft Entra stopped at its limit Your organization has more grants than one day's read takes, so some apps may be missing. Microsoft Entra hasn't been read whole yet.",
      failed: `The last read of Microsoft Entra failed The Microsoft Entra connection needs an admin to connect it again. Apps found in Microsoft Entra as of ${whole}.`,
      failedOther: `The last read of Microsoft Entra failed Microsoft didn't answer the reads. Grasp tries again tomorrow. Apps found in Microsoft Entra as of ${whole}.`,
    });
  });

  it("tells anyone but an admin, in one line, when the apps found may be incomplete", () => {
    expect({
      member: lineOf(true, null),
      memberWhole: lineOf(false, null),
      admin: lineOf(true, { state: "ready", data: [status({})] }),
      adminUnread: lineOf(true, { state: "offline" }),
    }).toStrictEqual({
      member:
        "The apps found in Microsoft Entra may be incomplete: its last read didn't finish.",
      memberWhole: "",
      admin: "",
      adminUnread:
        "The apps found in Microsoft Entra may be incomplete: its last read didn't finish.",
    });
  });

  it("shows an unverified publisher only as the app's own word, never as its vendor", () => {
    const app = discoveredAppOf({
      connectionId: "connection-entra",
      appId: "app-planted",
      name: "Totally Microsoft Teams",
      publisher: null,
      unverifiedPublisher: "Microsoft Corporation",
      verified: false,
      firstSeen: "2026-10-20T10:00:00.000Z",
      lastSeen: "2026-10-20T10:00:00.000Z",
      people: 1,
      adminConsented: false,
      scopes: [],
      signals: ["unverified_publisher"],
    });
    expect({
      vendor: app.vendor,
      signal: signalTextOf(
        "unverified_publisher",
        app.discovered?.unverifiedPublisher ?? null
      ),
    }).toStrictEqual({
      vendor: null,
      signal:
        "Microsoft hasn't verified who publishes this app. It names its publisher Microsoft Corporation itself, unverified.",
    });
  });
});
