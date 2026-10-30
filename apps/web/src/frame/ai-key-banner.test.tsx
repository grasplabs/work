// @vitest-environment happy-dom
import type { AiProvidersListing } from "@grasp-os/shared/ai-providers";
import type { Identity } from "@grasp-os/shared/rpc";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { formatSince } from "../format.ts";
import { AiKeyBanner } from "./ai-key-banner.tsx";

// The banner over every page while one of the organization's AI provider
// providers fails its calls, from what core's listing says of each one:
// the organization's own admins see it, with the way to replace the key;
// members and Grasp staff never do, and nobody does once the key works or
// was replaced.

const minute = 60_000;

/** A listing of OpenAI and Anthropic, OpenAI as `openai` says it fares. */
const listingWith = (
  openai: NonNullable<AiProvidersListing["providers"][number]["status"]>,
  provider: "openai" | "openai-compatible" = "openai"
): AiProvidersListing => ({
  providers: [
    {
      provider,
      mask: "sk-…a3f2",
      baseUrl: null,
      addedAt: Date.now() - 30 * 24 * 60 * minute,
      updatedAt: Date.now() - 30 * 24 * 60 * minute,
      label: provider === "openai" ? "OpenAI" : "Your endpoint",
      whereItRuns: "United States",
      status: openai,
    },
    {
      provider: "anthropic",
      mask: "sk-…b4c1",
      baseUrl: null,
      addedAt: Date.now() - 30 * 24 * 60 * minute,
      updatedAt: Date.now() - 30 * 24 * 60 * minute,
      label: "Anthropic",
      whereItRuns: "United States",
      status: {
        lastOkAt: Date.now(),
        lastFailedAt: null,
        lastFailure: null,
        lastStatus: null,
        failingClass: null,
        failingSince: null,
      },
    },
  ],
  offered: [],
  choice: null,
  platform: [],
});

const failingSince = Date.now() - 30 * minute;

/** OpenAI's key refused since `failingSince`, its latest refusal a minute ago. */
const refused = {
  lastOkAt: failingSince - minute,
  lastFailedAt: Date.now() - minute,
  lastFailure: "auth",
  lastStatus: 401,
  failingClass: "refused",
  failingSince,
} as const;

/** Not answering since `failingSince`: a 503 last. */
const notAnswering = {
  ...refused,
  lastFailure: "provider_down",
  lastStatus: 503,
  failingClass: "not_answering",
} as const;

/** Limiting requests since `failingSince`: a 429 last. */
const limiting = {
  ...refused,
  lastFailure: "rate_limited",
  lastStatus: 429,
  failingClass: "limiting",
} as const;

const since = formatSince(failingSince);

let root: Root | undefined;

/** What the banner says for `identity`, core listing `listing`. */
const bannerFor = async (
  listing: AiProvidersListing,
  identity: Pick<Identity, "role" | "staff">
): Promise<{ said: string; links: string[] }> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AiKeyBanner
          providers={async () => await Promise.resolve(listing)}
          identity={{
            userId: "user-1",
            email: "admin@example.com",
            name: "Admin",
            teams: [],
            expiresAt: new Date(Date.now() + minute).toISOString(),
            ...identity,
          }}
        />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
  const said = host.textContent ?? "";
  const links = [...host.querySelectorAll("a")].map(
    (link) => link.getAttribute("href") ?? ""
  );
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  return { said, links };
};

describe("the AI key banner", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("tells the organization's own admins that a provider refuses the key since when, with the way to check or replace it, and nobody else", async () => {
    const admin = await bannerFor(listingWith(refused), {
      role: "admin",
      staff: false,
    });
    const member = await bannerFor(listingWith(refused), {
      role: "user",
      staff: false,
    });
    const staff = await bannerFor(listingWith(refused), {
      role: "admin",
      staff: true,
    });

    expect({ admin, member, staff }).toStrictEqual({
      admin: {
        said: `OpenAI is refusing your key since ${since}.Check or replace it in Settings › AI providers.`,
        links: ["/settings/ai-providers"],
      },
      member: { said: "", links: [] },
      staff: { said: "", links: [] },
    });
  });

  it("says a provider isn't answering, with its own status page where it has one, and one that limits requests, by what was seen", async () => {
    const asAdmin = { role: "admin", staff: false } as const;
    const down = await bannerFor(listingWith(notAnswering), asAdmin);
    const ownEndpoint = await bannerFor(
      listingWith(notAnswering, "openai-compatible"),
      asAdmin
    );
    const limited = await bannerFor(listingWith(limiting), asAdmin);

    expect({ down, ownEndpoint, limited }).toStrictEqual({
      down: {
        said: `OpenAI isn't answering since ${since}.This is usually an outage on their side; Grasp keeps retrying. If it lasts, check status.openai.com or switch provider.`,
        links: ["https://status.openai.com"],
      },
      ownEndpoint: {
        said: `Your endpoint isn't answering since ${since}.This is usually an outage on their side; Grasp keeps retrying. If it lasts, switch provider.`,
        links: [],
      },
      limited: {
        said: `OpenAI is limiting requests since ${since} (rate or spending limit at OpenAI).`,
        links: [],
      },
    });
  });

  it("says nothing once a call works again or the key was replaced", async () => {
    const replaced = await bannerFor(
      listingWith({ ...refused, failingClass: null, failingSince: null }),
      { role: "admin", staff: false }
    );

    expect(replaced).toStrictEqual({ said: "", links: [] });
  });
});
