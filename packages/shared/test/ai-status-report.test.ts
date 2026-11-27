import { describe, expect, it } from "vite-plus/test";

import { aiStatusReportSchema } from "../src/ai-status-report.ts";

// A client's AI as its core reports it to Grasp's admin (pure parsing):
// the admin and the cores roll out on their own, so a report may come
// from a core on another release.

const row = (provider: string) => ({
  provider,
  kind: "platform",
  lastOkAt: 1_700_000_000_000,
  lastFailedAt: null,
  lastFailure: null,
});

describe("a core's AI status report, as the admin reads it", () => {
  it("leaves out a provider this release doesn't know, and keeps the rest of the report", () => {
    const parsed = aiStatusReportSchema.safeParse({
      // A core of another release names a provider this one has no row for.
      providers: [row("openai"), row("kugelaudio"), row("mistral")],
    });

    expect({
      read: parsed.success,
      providers: parsed.data?.providers.map(({ provider }) => provider),
    }).toStrictEqual({ read: true, providers: ["openai", "mistral"] });
  });
});
