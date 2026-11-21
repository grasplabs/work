// @vitest-environment happy-dom
import { act } from "react";
import { describe, expect, it } from "vite-plus/test";

import { answeredAdmin, gridRow, openAdmin, settle } from "../../test/app.tsx";
import { emptyAdminSnapshot } from "../../test/snapshots.ts";
import type { ClientAdmin } from "../clients/admin.ts";

// What staff change on an organization's page shows changed once the
// change is through, within the minute its last answer stands: the page
// asks its core again for what it changed, never shows the answer from
// before (src/admin/org-loads.ts, `readOrganization`).

const acme = gridRow({ id: "acme", name: "Acme" });

/** Acme's core answering `before` until `changed` says the change went through, then `after`. */
const answering = (before: ClientAdmin, after: ClientAdmin) => {
  let changed = false;
  return {
    change: () => {
      changed = true;
    },
    admin: () => (changed ? after : before),
  };
};

/** Submits `form` as pressing its button does. */
const submit = async (form: Element | null | undefined): Promise<void> => {
  if (form === null || form === undefined) {
    throw new Error("No such form");
  }
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
  });
  await settle();
};

describe("a change on an organization's page", () => {
  it("shows what was agreed once a command gives it, though the page's answer was a moment old", async () => {
    const empty = emptyAdminSnapshot("Acme");
    const core = answering(
      answeredAdmin({ client: acme, snapshot: empty }),
      answeredAdmin({
        client: acme,
        snapshot: {
          ...empty,
          agreements: {
            processing: true,
            assessment: true,
            council: "none",
            processingOn: "2026-09-02",
          },
        },
      })
    );
    const { container } = await openAdmin(
      "/organizations/acme/details?tab=contract",
      {
        fetchClientGrid: [acme],
        fetchClientAdmin: core.admin,
        fetchClientAdmins: [],
        commandFn: () => {
          core.change();
          return { refused: null, issuedAt: new Date().toISOString() };
        },
      }
    );
    const agreed = () =>
      container.querySelector(
        'section[aria-label="Agreed before the first interview"]'
      )?.textContent ?? "";
    const before = agreed();

    const open = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Change what was agreed"
    );
    await act(async () => {
      open?.click();
      await Promise.resolve();
    });
    await settle();
    // The dialog's form, in the document beside the page.
    await submit(
      [...document.querySelectorAll("form")].find((form) =>
        form.textContent?.includes("Works council")
      )
    );

    expect({
      before: before.includes("Not recorded yet"),
      after: agreed().includes("In place since 2 Sep 2026"),
    }).toStrictEqual({ before: true, after: true });
  });
});
