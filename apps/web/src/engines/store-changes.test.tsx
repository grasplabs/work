import type { App } from "@grasp-os/shared/apps";
import { appErrors } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { dataErrors, migrationErrors } from "@grasp-os/shared/stores";
import type {
  AbandonedBackfill,
  AppStoreBackfill,
} from "@grasp-os/shared/stores";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  abandonFailureText,
  makeCurrentFailure,
} from "./store-change-errors.ts";
import { Abandoned, StoreChange, StoreChanges } from "./store-changes.tsx";

// What an admin reads of a store's pending change on the engine page,
// from what it renders, and what each refusal of abandoning it, or of
// making a version current, says. Opening the confirmation needs a
// browser; the dialog's text is in store-changes.tsx.

/** What `element` renders, as text without its markup. */
const textOf = (element: ReactElement): string =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{element}</I18nProvider>)
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .replaceAll("&#x27;", "'")
    .trim();

const markupOf = (element: ReactElement): string =>
  renderToStaticMarkup(<I18nProvider i18n={i18n}>{element}</I18nProvider>);

const engine: App = {
  id: appIdSchema.parse("0b9f3c1e-4a51-4d1e-9c3a-2f6d8e7a1b40"),
  name: "Notes",
  description: "",
  owner: "ada",
  blueprint: null,
  currentVersion: 2,
  pendingVersion: null,
  createdAt: "2026-10-01T09:00:00.000Z",
};

const failed = (
  failure: AppStoreBackfill["backfill"]["failure"]
): AppStoreBackfill => ({
  store: "store-1",
  backfill: {
    target: "a".repeat(64),
    state: "failed",
    attempt: 2,
    scanned: 40,
    filled: 39,
    failure,
  },
});

const idle = () => {
  // Rendering never calls it.
};

describe("a store's pending change", () => {
  it("names the table, field and record that failed, what that blocks, and offers abandoning it", () => {
    const change = failed({
      table: "notes",
      field: "category",
      id: "rec_42",
      reason: "invalid_value",
    });
    const text = textOf(
      <StoreChange busy={false} change={change} onAbandon={idle} />
    );
    expect(text).toContain(
      "The new field category of the table notes can't be filled in: the record rec_42 already holds a value"
    );
    expect(text).toContain("no release that changes this store's tables");
    expect(text).toContain("Records checked: 40. Filled in: 39.");
    expect(text).toContain("Abandon this change");
  });

  it("says when filling in would make a record too large, or stalled", () => {
    const tooLarge = textOf(
      <StoreChange
        busy={false}
        change={failed({
          table: "notes",
          field: "body",
          id: "rec_7",
          reason: "too_large",
        })}
        onAbandon={idle}
      />
    );
    const stalled = textOf(
      <StoreChange
        busy={false}
        change={failed({ reason: "stalled" })}
        onAbandon={idle}
      />
    );
    expect(tooLarge).toContain(
      "Filling in the new field body of the table notes would make the record rec_7 larger"
    );
    expect(stalled).toContain("stopped making progress");
    expect(stalled).toContain("Abandon this change");
  });

  it("shows a change still being applied with its progress, and nothing to abandon", () => {
    const text = textOf(
      <StoreChange
        busy={false}
        change={{
          store: "store-1",
          backfill: {
            target: "b".repeat(64),
            state: "running",
            attempt: 1,
            scanned: 10,
            filled: 4,
            failure: null,
          },
        }}
        onAbandon={idle}
      />
    );
    expect(text).toContain("is being applied");
    expect(text).toContain("Records checked: 10. Filled in: 4.");
    expect(text).not.toContain("Abandon");
  });

  it("turns the abandon control off while a change is under way", () => {
    const markup = markupOf(
      <StoreChange
        busy
        change={failed({ reason: "stalled" })}
        onAbandon={idle}
      />
    );
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Abandon this change/u);
  });

  it("is nothing at all for someone the page didn't read it for", () => {
    expect(markupOf(<StoreChanges changes={undefined} engine={engine} />)).toBe(
      ""
    );
  });
});

describe("an abandoned change", () => {
  it("names the releases that never run and the fields that stay reserved", () => {
    const abandoned: AbandonedBackfill = {
      store: "store-1",
      target: "a".repeat(64),
      attempt: 2,
      scanned: 40,
      filled: 39,
      failure: { reason: "stalled" },
      releases: [
        { app: engine.id, version: 3 },
        { app: "crm", version: 5 },
      ],
      reserved: [{ table: "notes", field: "category" }],
      abandonedAt: "2026-10-13T12:00:00.000Z",
    };
    const text = textOf(<Abandoned abandoned={abandoned} engine={engine} />);
    expect(text).toContain(
      "These releases can never be made current: Notes, version 3 and engine crm, version 5."
    );
    expect(text).toContain(
      "These fields stay reserved with their current meaning: notes.category."
    );
  });
});

describe("why abandoning didn't go through", () => {
  it("says a retry already started, and each other refusal in words of its own", () => {
    expect({
      superseded: abandonFailureText(
        migrationErrors.create("migration.superseded")
      ),
      notFailed: abandonFailureText(
        migrationErrors.create("migration.not_failed")
      ),
      abandoned: abandonFailureText(
        migrationErrors.create("migration.abandoned")
      ),
      gone: abandonFailureText(dataErrors.create("data.store_unavailable")),
      forbidden: abandonFailureText(roleErrors.create("role.forbidden")),
      other: abandonFailureText(appErrors.create("app.not_found")),
    }).toStrictEqual({
      superseded:
        "A retry of this change already started, so it wasn't abandoned. The page shows where it stands now.",
      notFailed:
        "This change is being applied again, so it can't be abandoned now. The page shows where it stands now.",
      abandoned: "This change was already abandoned.",
      gone: "This store no longer exists, so there is nothing to abandon.",
      forbidden:
        "Only your organization's admins can abandon a change to a store.",
      other: appErrors.create("app.not_found").message,
    });
  });
});

describe("why a version wasn't made current", () => {
  it("points to the engine's page when a store's failed change holds it back", () => {
    const blocked = makeCurrentFailure(
      migrationErrors.create("migration.backfill_failed", {
        target: "a".repeat(64),
        attempt: 2,
      })
    );
    const abandoned = makeCurrentFailure(
      migrationErrors.create("migration.abandoned")
    );
    const other = makeCurrentFailure(roleErrors.create("role.forbidden"));
    expect({
      blocked: blocked.blocked,
      abandoned,
      other: other.blocked,
    }).toStrictEqual({
      blocked: true,
      abandoned: {
        text: "An admin abandoned the data change this version needs, so it can never be made current. Ask the engine to be built again.",
        blocked: false,
      },
      other: false,
    });
  });
});
