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
    ready: false,
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
    // A stalled change names no record, so it advises no mending.
    expect({
      stalledWhy: stalled.includes("stopped making progress"),
      stalledNothingToMend: stalled.includes("there is nothing to mend"),
      stalledMend: stalled.includes("Mend the record"),
      tooLargeMend: tooLarge.includes("Mend the record"),
      stalledAbandon: stalled.includes("Abandon this change"),
    }).toStrictEqual({
      stalledWhy: true,
      stalledNothingToMend: true,
      stalledMend: false,
      tooLargeMend: true,
      stalledAbandon: true,
    });
  });

  it("names a failed migration, its table and record, and what its transform threw", () => {
    const onRecord = textOf(
      <StoreChange
        busy={false}
        change={failed({
          table: "notes",
          id: "rec_9",
          migration: "derive-category",
          reason: "threw",
          issues: ["No category for Note 9"],
        })}
        onAbandon={idle}
      />
    );
    const whole = textOf(
      <StoreChange
        busy={false}
        change={failed({
          table: "notes",
          id: null,
          migration: "derive-category",
          reason: "invalid_answer",
          issues: [],
        })}
        onAbandon={idle}
      />
    );
    expect({
      record:
        /The migration derive-category of the table notes failed on the record\s*rec_9\s*\./u.test(
          onRecord
        ),
      issue: onRecord.includes("No category for Note 9"),
      mend: onRecord.includes("Mend the record"),
      whole: whole.includes("failed as a whole: its code failed, not a record"),
      wholeNothingToMend: whole.includes("there is nothing to mend"),
    }).toStrictEqual({
      record: true,
      issue: true,
      mend: true,
      whole: true,
      wholeNothingToMend: true,
    });
  });

  it("shows a ready migration as waiting for its release, with abandoning it on offer", () => {
    const text = textOf(
      <StoreChange
        busy={false}
        change={{
          store: "store-1",
          alias: "crm",
          backfill: {
            target: "c".repeat(64),
            state: "running",
            attempt: 1,
            scanned: 12,
            filled: 12,
            failure: null,
            ready: true,
          },
        }}
        onAbandon={idle}
      />
    );
    expect({
      ready: text.includes("A change to the store crm is ready"),
      waits: text.includes(
        "It takes over when a release that needs it is made current"
      ),
      abandon: text.includes("Abandon this change"),
    }).toStrictEqual({ ready: true, waits: true, abandon: true });
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
            ready: false,
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

  it("keeps what an abandonment took out of force when reading again fails", async () => {
    const answer: AbandonedBackfill = {
      store: change.store,
      target: change.backfill.target,
      attempt: change.backfill.attempt,
      scanned: 40,
      filled: 39,
      failure: { reason: "stalled" },
      releases: [{ app: engine.id, version: 3 }],
      reserved: [{ table: "notes", field: "category" }],
      abandonedAt: "2026-10-13T12:00:00.000Z",
    };
    const { settled } = await confirm(
      change,
      async () => {
        await Promise.resolve();
        return answer;
      },
      async () => {
        await Promise.resolve();
        throw new Error("Core went away");
      }
    );
    expect(settled).toStrictEqual([{ abandoned: answer, name: "crm" }]);
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

/** `migration.backfill_failed` as core sends it, failing as `failure` says. */
const backfillFailed = (failure: AppStoreBackfill["backfill"]["failure"]) =>
  migrationErrors.create("migration.backfill_failed", {
    target: "a".repeat(64),
    attempt: 2,
    failure: failure === null ? null : { ...failure },
  });

describe("why a version wasn't made current", () => {
  it("explains a store's failed change by its reason, and points to the engine's page", () => {
    const record = { table: "notes", field: "category", id: "rec_42" };
    expect({
      invalid: makeCurrentFailure(
        backfillFailed({ ...record, reason: "invalid_value" })
      ),
      tooLarge: makeCurrentFailure(
        backfillFailed({ ...record, reason: "too_large" })
      ),
      stalled: makeCurrentFailure(backfillFailed({ reason: "stalled" })),
      migration: makeCurrentFailure(
        backfillFailed({
          table: "notes",
          id: "rec_9",
          migration: "derive-category",
          reason: "threw",
          issues: [],
        })
      ),
      unnamed: makeCurrentFailure(backfillFailed(null)),
    }).toStrictEqual({
      invalid: {
        text: "This version changes the engine's data, and the change can't be applied: a record already holds a value one of its new fields doesn't accept.",
        link: "An admin can see the record that holds it back, and abandon the change, on the engine's page.",
      },
      tooLarge: {
        text: "This version changes the engine's data, and the change can't be applied: filling in one of its new fields would make a record larger than a record may be.",
        link: "An admin can see the record that holds it back, and abandon the change, on the engine's page.",
      },
      stalled: {
        text: "This version changes the engine's data, and the change can't be applied: filling in its new fields stopped making progress.",
        link: "No record is to blame, so an admin can only abandon the change, on the engine's page.",
      },
      migration: {
        text: "This version changes the engine's data with a migration, and it can't finish: its transform failed, or answered what the table doesn't accept.",
        link: "An admin can see what went wrong, and abandon the change, on the engine's page.",
      },
      unnamed: {
        text: "This version changes the engine's data, and the change can't be applied: filling in its new fields stopped making progress.",
        link: "No record is to blame, so an admin can only abandon the change, on the engine's page.",
      },
    });
  });

  it("says an abandoned change is final, and points nowhere for anything else", () => {
    expect({
      abandoned: makeCurrentFailure(
        migrationErrors.create("migration.abandoned")
      ),
      other: makeCurrentFailure(roleErrors.create("role.forbidden")).link,
    }).toStrictEqual({
      abandoned: {
        text: "An admin abandoned the data change this version needs, so it can never be made current. Ask the engine to be built again.",
        link: undefined,
      },
      other: undefined,
    });
  });
});
