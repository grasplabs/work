import type { LandscapeAppSummary } from "@grasp-os/shared/landscape";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatDate } from "../format.ts";
import { discoveredAppOf } from "./landscape-data.ts";
import { UsageTab } from "./usage-tab.tsx";
import type { UsagePeople } from "./usage-tab.tsx";

// An app's Usage tab: for an app found in the identity provider's grants,
// how many people granted it access, and who for admins alone.

const found: LandscapeAppSummary = {
  connectionId: "connection-entra",
  appId: "app-crm",
  name: "Contoso CRM",
  publisher: "Contoso",
  unverifiedPublisher: null,
  verified: true,
  firstSeen: "2026-10-01T08:00:00.000Z",
  lastSeen: "2026-10-20T08:00:00.000Z",
  people: 2,
  adminConsented: false,
  scopes: ["User.Read"],
  signals: ["no_admin_consent"],
};

/** The tab's text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (people: UsagePeople): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <UsageTab app={discoveredAppOf(found)} people={people} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("a found app's usage", () => {
  it("names who granted it access to admins, and only counts them for everyone else", () => {
    const lastSeen = "2026-10-20T08:00:00.000Z";
    const admin = textOf({
      state: "ready",
      data: [
        {
          personId: "oid-ada",
          name: "Ada",
          userId: "user-ada",
          scopes: ["User.Read", "Mail.Read"],
          firstSeen: lastSeen,
          lastSeen,
        },
        {
          personId: "oid-unnamed",
          name: null,
          userId: null,
          scopes: ["User.Read"],
          firstSeen: lastSeen,
          lastSeen,
        },
      ],
    });
    const member = textOf(null);
    const refused = textOf({ state: "refused", message: "Not allowed" });
    expect({ admin, member, refused }).toStrictEqual({
      admin: `Usage 2 people granted this app access for themselves. Ada Granted User.Read and Mail.Read. Last seen ${formatDate(lastSeen)}. oid-unnamed Granted User.Read. Last seen ${formatDate(lastSeen)}.`,
      member:
        "Usage 2 people granted this app access for themselves. Only admins see who they are.",
      refused:
        "Usage 2 people granted this app access for themselves. Not allowed",
    });
  });

  it("lists each person who granted it access as an entry of the list, for assistive technology", () => {
    const at = "2026-10-20T08:00:00.000Z";
    const person = (personId: string) => ({
      personId,
      name: null,
      userId: null,
      scopes: ["User.Read"],
      firstSeen: at,
      lastSeen: at,
    });
    const markup = renderToStaticMarkup(
      <I18nProvider i18n={i18n}>
        <UsageTab
          app={discoveredAppOf(found)}
          people={{
            state: "ready",
            data: [person("oid-ada"), person("oid-bob")],
          }}
        />
      </I18nProvider>
    );
    expect({
      lists: markup.match(/role="list"/gu)?.length ?? 0,
      // Each an <li>, a list item to assistive technology.
      entries: markup.match(/<li[\s>]/gu)?.length ?? 0,
    }).toStrictEqual({ lists: 1, entries: 2 });
  });
});
