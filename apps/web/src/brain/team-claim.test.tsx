// @vitest-environment happy-dom
import { setTimeout as sleep } from "node:timers/promises";

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BannerHeader } from "./brain-article/kern.tsx";
import { MentionLinks } from "./brain-article/mention-links.tsx";
import { NoteChip } from "./brain-chips.tsx";
import { buildBrain } from "./brain.ts";
import type { Note } from "./brain.ts";
import { testWorkspace } from "./test-workspace.ts";

// A team's claim from the interviews (GRA-1084) is what five or more of
// its people said, put together: wherever the Brain names it, it reads in
// plain words, never in quotation marks as one person's, and where it
// stands on its own it says what it rests on. Anyone's own words stay
// quoted.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const claimId = "onb-st-0123456789abcdef0123456789abcdef";
const claimText = "Tickets come in through Zendesk";
const ownId = "st-inbox";
const ownText = "Every email is routed by hand";

const brain = buildBrain(testWorkspace());
const [base] = brain.notes;
if (!base) {
  throw new Error("No note");
}

/** A statement note, as the brain makes one for statement `id`. */
const statementNote = (id: string, title: string): Note => ({
  ...base,
  id,
  kind: "statement",
  title,
  summary: "",
});

/** `node` on a page with the brain's note route, as the app has it. */
const shown = async (node: ReactElement): Promise<HTMLElement> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => node,
  });
  const note = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/$noteId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, note]),
    history: createMemoryHistory(),
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  return host;
};

/** Opens a chip's preview, as a pointer resting on it does. */
const hover = async (chip: Element): Promise<void> => {
  await act(async () => {
    chip.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
    chip.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    chip.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    // Past the preview's opening delay.
    await sleep(1000);
  });
};

describe("a team's claim, wherever the Brain names it", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("heads its page in plain words, and says it rests on five or more people", async () => {
    const host = await shown(
      <BannerHeader
        kern={{ interviewed: [], counts: [] }}
        note={statementNote(claimId, claimText)}
      />
    );
    expect({
      title: host.querySelector("h1")?.textContent,
      basis: host.textContent?.includes("Said by five or more people"),
    }).toStrictEqual({ title: claimText, basis: true });
  });

  it("heads someone's own statement in quotation marks, with no basis", async () => {
    const host = await shown(
      <BannerHeader
        kern={{ interviewed: [], counts: [] }}
        note={statementNote(ownId, ownText)}
      />
    );
    expect({
      title: host.querySelector("h1")?.textContent,
      basis: host.textContent?.includes("Said by five or more people"),
    }).toStrictEqual({ title: `“${ownText}”`, basis: false });
  });

  it("previews it on a chip in plain words", async () => {
    const host = await shown(
      <NoteChip note={statementNote(claimId, claimText)} />
    );
    const chip = host.querySelector("a");
    if (!chip) {
      throw new Error("No chip");
    }
    await hover(chip);
    // The preview itself, opened, not the chip's own label.
    const preview = document.querySelector('[data-slot="hover-card-content"]');
    expect({
      open: preview !== null,
      title: preview?.querySelector(".font-medium")?.textContent,
    }).toStrictEqual({ open: true, title: claimText });
  });

  it("lists it among the statements naming a note in plain words, beside someone's quoted words", async () => {
    const host = await shown(
      <MentionLinks
        mentions={[
          {
            statementId: claimId,
            sourceId: "onb-src-ops",
            text: claimText,
            own: false,
          },
          {
            statementId: ownId,
            sourceId: "src-service",
            text: ownText,
            own: false,
          },
        ]}
      />
    );
    expect(
      [...host.querySelectorAll("a")].map((link) => link.textContent)
    ).toStrictEqual([claimText, `“${ownText}”`]);
  });
});
