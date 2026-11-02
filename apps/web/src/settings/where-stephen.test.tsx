import type { ChannelReach } from "@grasp-os/shared/channel-accounts";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WhereStephen } from "./where-stephen.tsx";

// Settings › Security › Chat apps: where the person reaches Stephen, from
// what core says (`channelAccounts.reach`), as the page draws it.

const drawn = (reach: ChannelReach[]): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <WhereStephen reach={reach} />
    </I18nProvider>
  );

describe("where to reach Stephen", () => {
  it("names each app with where to find him, and opens it in a new tab", () => {
    const html = drawn([
      {
        platform: "teams",
        href: "https://teams.microsoft.com/l/chat/0/0?users=28:acme-bot",
      },
    ]);

    expect(html).toContain("Microsoft Teams");
    expect(html).toContain(
      "Open a chat with Stephen, or search for him in Teams’ apps."
    );
    expect(html).toContain(
      'href="https://teams.microsoft.com/l/chat/0/0?users=28:acme-bot" rel="noopener noreferrer" target="_blank"'
    );
  });

  it("says where to look in an app with no link", () => {
    const html = drawn([{ platform: "slack", href: null }]);

    expect(html).toContain("Find Stephen under Apps in your Slack workspace.");
    expect(html).not.toContain("<a");
  });

  it("shows nothing when he is reached in no chat app", () => {
    expect(drawn([])).toBe("");
  });
});
