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
  it("names each app with what to write to, and opens it in a new tab", () => {
    const html = drawn([
      {
        platform: "whatsapp",
        address: "+31 20 123 4567",
        href: "https://wa.me/31201234567",
      },
      {
        platform: "gmail",
        address: "stephen@acme.test",
        href: "mailto:stephen@acme.test",
      },
    ]);

    expect(html).toContain("WhatsApp");
    expect(html).toContain("+31 20 123 4567");
    expect(html).toContain(
      'href="https://wa.me/31201234567" rel="noopener noreferrer" target="_blank"'
    );
    expect(html).toContain("stephen@acme.test");
    expect(html).toContain('href="mailto:stephen@acme.test"');
  });

  it("says where to look in an app with no address or link", () => {
    const html = drawn([{ platform: "slack", address: null, href: null }]);

    expect(html).toContain("Find Stephen under Apps in your Slack workspace.");
    expect(html).not.toContain("<a");
  });

  it("shows nothing when he is reached in no chat app", () => {
    expect(drawn([])).toBe("");
  });
});
