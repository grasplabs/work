// @vitest-environment happy-dom
import type { LinksReference } from "@grasp-os/runtime";
import { RichText } from "@grasp-os/ui/components/rich-text";
import { describe, expect, it } from "vite-plus/test";

import { click, find, rendered, testHost } from "./test-host.tsx";

// Formatted text on an App's page, whose links open only through one of
// the App's links resources: the address goes to the host through it,
// never opened by the frame itself.

const site: LinksReference<"site", readonly ["https://example.com"]> = {
  kind: "links",
  alias: "site",
  origins: ["https://example.com"],
};

describe("rich text's links", () => {
  it("open through the page's links resource", async () => {
    const { client, links } = testHost(() => ({ value: null }));
    await rendered(
      client,
      <RichText
        links={site}
        value="See [the plan](https://example.com/plan)."
      />
    );
    await click(find("button", "the plan"));
    expect(links).toStrictEqual([
      { resource: "site", url: "https://example.com/plan" },
    ]);
  });
});
