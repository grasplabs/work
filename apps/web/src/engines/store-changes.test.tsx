import type { App } from "@grasp-os/shared/apps";
import { appErrors } from "@grasp-os/shared/apps";
import { appIdSchema } from "@grasp-os/shared/ids";
import { roleErrors } from "@grasp-os/shared/roles";
import { dataErrors, migrationErrors } from "@grasp-os/shared/stores";
import type {
  AbandonBackfill,
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
import {
  Abandoned,
  abandonChange,
  readStoreChanges,
  StoreChange,
} from "./store-changes.tsx";
import type { Outcome } from "./store-changes.tsx";

// What an admin reads of a store's pending change on the engine page,
// from what it renders, and what each refusal of abandoning it, or of
// making a version current, says; what confirming it sends core, and
// whom the page reads it for. Opening the confirmation, and where focus
// goes after it, need a browser: the dialog's text is in store-changes.tsx.

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
  alias: "crm",
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
          alias: null,
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
    expect(text).toContain("A change to the store store-1 is being applied");
    expect(text).toContain("Records checked: 10. Filled in: 4.");
    expect(text).not.toContain("Abandon");
    expect(text).not.toContain("Store ID");
  });

  it("interrupts with a failed change, and not with one still being applied", () => {
    const failedMarkup = markupOf(
      <StoreChange
        busy={false}
        change={failed({ reason: "stalled" })}
        onAbandon={idle}
      />
    );
    const running = markupOf(
      <StoreChange
        busy={false}
        change={{
          ...failed(null),
          backfill: { ...failed(null).backfill, state: "running" },
        }}
        onAbandon={idle}
      />
    );
    expect({
      failed: failedMarkup.includes('role="alert"'),
      running: running.includes('role="alert"'),
    }).toStrictEqual({ failed: true, running: false });
  });

  it("names the store by its alias, and the abandon control by its visible words and the change's title", () => {
    const markup = markupOf(
      <StoreChange
        busy={false}
        change={failed({ reason: "stalled" })}
        onAbandon={idle}
      />
    );
    const title =
      /<div[^>]*data-slot="alert-title"[^>]*id="(?<id>[^"]+)"[^>]*>(?<text>[^<]*)</u.exec(
        markup
      )?.groups;
    const button = /<button(?<attributes>[^>]*)>Abandon this change</u.exec(
      markup
    )?.groups?.attributes;
    expect({
      title: title?.text,
      describedBy: button?.includes(`aria-describedby="${title?.id}"`),
      labelled: button?.includes("aria-label"),
      id: textOf(
        <StoreChange
          busy={false}
          change={failed({ reason: "stalled" })}
          onAbandon={idle}
        />
      ).includes("Store ID: store-1"),
    }).toStrictEqual({
      title: "A change to the store crm can&#x27;t be applied",
      describedBy: true,
      labelled: false,
      id: true,
    });
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
});

/** A connection to core that counts what it is asked, and answers nothing. */
const countingCore = () => {
  const asked = { count: 0 };
  return {
    asked,
    core: {
      withSession: async (): Promise<never> => {
        asked.count += 1;
        await Promise.resolve();
        throw new Error("Not answered here");
      },
    },
  };
};

describe("whom the page reads a store's changes for", () => {
  it("asks core only for the organization's own admins", async () => {
    const reads = await Promise.all(
      [
        { role: "admin", staff: false },
        { role: "admin", staff: true },
        { role: "builder", staff: false },
        { role: "member", staff: false },
      ].map(async (viewer) => {
        const { asked, core } = countingCore();
        const read = readStoreChanges(core, viewer, engine.id);
        await read;
        return { read: read !== undefined, asked: asked.count };
      })
    );
    expect(reads).toStrictEqual([
      { read: true, asked: 1 },
      { read: false, asked: 0 },
      { read: false, asked: 0 },
      { read: false, asked: 0 },
    ]);
  });
});

/** Confirms abandoning `change` against `abandon`, as the page does. */
const confirm = async (
  change: AppStoreBackfill,
  abandon: (input: AbandonBackfill) => Promise<AbandonedBackfill>,
  refresh: () => Promise<void> = async () => {
    await Promise.resolve();
  }
) => {
  const sent: AbandonBackfill[] = [];
  const settled: Outcome[] = [];
  let refreshed = 0;
  let ended = "done";
  try {
    await abandonChange(
      change,
      async (input) => {
        sent.push(input);
        return await abandon(input);
      },
      async () => {
        refreshed += 1;
        await refresh();
      },
      (outcome) => {
        settled.push(outcome);
      }
    );
  } catch {
    ended = "refused";
  }
  return { sent, settled, refreshed, ended };
};

describe("confirming an abandonment", () => {
  const change = failed({ reason: "stalled" });

  it("sends the store, target and run the page loaded, then reads the page again", async () => {
    const answer: AbandonedBackfill = {
      store: change.store,
      target: change.backfill.target,
      attempt: change.backfill.attempt,
      scanned: 40,
      filled: 39,
      failure: { reason: "stalled" },
      releases: [],
      reserved: [],
      abandonedAt: "2026-10-13T12:00:00.000Z",
    };
    const { sent, settled, refreshed } = await confirm(change, async () => {
      await Promise.resolve();
      return answer;
    });
    expect({ sent, settled, refreshed }).toStrictEqual({
      sent: [{ store: "store-1", target: "a".repeat(64), attempt: 2 }],
      settled: [{ abandoned: answer, name: "crm" }],
      refreshed: 1,
    });
  });

  it("says a retry already started when the run it saw is stale, and reads the page again", async () => {
    const { settled, refreshed } = await confirm(change, async () => {
      await Promise.resolve();
      throw migrationErrors.create("migration.superseded");
    });
    expect({ settled, refreshed }).toStrictEqual({
      settled: [
        {
          failure:
            "A retry of this change already started, so it wasn't abandoned. The page shows where it stands now.",
        },
      ],
      refreshed: 1,
    });
  });

  it("still settles when reading the page again fails, so the controls come back", async () => {
    const { settled, ended } = await confirm(
      change,
      async () => {
        await Promise.resolve();
        throw migrationErrors.create("migration.abandoned");
      },
      async () => {
        await Promise.resolve();
        throw new Error("Core went away");
      }
    );
    expect({ settled, ended }).toStrictEqual({
      settled: [{ failure: "This change was already abandoned." }],
      ended: "refused",
    });
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
    const text = textOf(
      <Abandoned abandoned={abandoned} engine={engine} name="crm" />
    );
    expect(text).toContain(
      "These releases can never be made current: Notes, version 3 and engine crm, version 5."
    );
    expect(text).toContain("The change to the store crm was abandoned");
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
