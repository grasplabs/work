import { beforeEach, describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  call,
  valueOf,
  codeOf,
  savedSchema,
  interview,
  draftsOf,
  draftOf,
  stillThere,
  sourcesOf,
  sourceOf,
  statementsOf,
  created,
  copyOf,
  memberIn,
  connected,
} from "./intake-harness.ts";
import { signedInApi, unique } from "./sign-in.ts";

// The intake, the built-in App (apps/core/blueprints/intake/): drafts of
// a source and its statements, typed in or taken out of notes by a model,
// reviewed, and saved as a source and its statements, all in the App's
// own store, which only its builders reach. What can go wrong, tried
// below: a draft saved without anyone reviewing it, saved twice, or saved
// halfway; someone who isn't one of the App's builders reading or writing
// drafts; edits written over someone else's; and a draft that doesn't fit
// kept or saved.
//
// Here: drafts and saving them; reading notes in intake-notes.test.ts.

const idp = mockIdp();
const memberOf = memberIn(idp);

describe("the intake", { timeout: 60_000 }, () => {
  beforeEach(connected);

  it("keeps a draft for review, and saves it, as edited, as a source and its statements, dropping the draft", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin);
    const title = `Month-end ${unique()}`;
    const draft = interview(title);

    const id = await created(admin, app, draft);
    const listed = await draftsOf(admin, app);
    const opened = await draftOf(admin, app, id);
    // Reviewed: the first statement goes, the second loses its blocker.
    const edited = {
      source: { ...draft.source, notes: "Edited notes." },
      statements: [{ ...draft.statements[1], tags: ["rule"] }],
    };
    const kept = valueOf(
      await call(admin, app, "drafts.keep", "mutation", {
        id,
        ...edited,
      })
    );
    // Kept again, unchanged.
    const keptAgain = valueOf(
      await call(admin, app, "drafts.keep", "mutation", {
        id,
        ...edited,
      })
    );
    const before = await sourcesOf(admin, app);
    const saved = savedSchema.parse(
      valueOf(
        await call(admin, app, "drafts.save", "mutation", {
          id,
          ...edited,
        })
      )
    );
    const [listedSource] = await sourcesOf(admin, app);
    const source = await sourceOf(admin, app, saved.source);

    expect({
      listed: listed.map(({ title: shown, origin, statements }) => ({
        title: shown,
        origin,
        statements,
      })),
      opened: opened && {
        origin: opened.origin,
        source: opened.source,
        statements: opened.statements,
      },
      kept,
      keptAgain,
      before,
      saved: saved.statements,
      listedSource: listedSource && {
        id: listedSource.id,
        title: listedSource.title,
      },
      source: {
        title: source.title,
        medium: source.medium,
        date: source.date,
        from: source.from,
        notes: source.notes,
      },
      statements: await statementsOf(admin, app, saved.source),
      draft: await draftOf(admin, app, id),
      waiting: await draftsOf(admin, app),
    }).toStrictEqual({
      listed: [{ title, origin: "manual", statements: 2 }],
      opened: {
        origin: "manual",
        // Trimmed, as the schema keeps text.
        source: { ...draft.source, from: "Anna, controller" },
        statements: [
          draft.statements[0],
          {
            text: "Invoices wait for a second signature over 5,000.",
            // Each tag once, in the order they're listed in.
            tags: ["rule", "blocker"],
            quote: "",
          },
        ],
      },
      kept: null,
      keptAgain: null,
      // Nothing is saved before someone saves it.
      before: [],
      saved: 1,
      // Listed without its notes.
      listedSource: { id: saved.source, title },
      source: {
        title,
        medium: "interview",
        date: "2026-09-21",
        from: "Anna, controller",
        notes: "Edited notes.",
      },
      statements: [
        {
          text: "Invoices wait for a second signature over 5,000.",
          tags: ["rule"],
          quote: "",
          source: saved.source,
          date: "2026-09-21",
        },
      ],
      // Saved, the draft is gone.
      draft: null,
      waiting: [],
    });
  });

  it("refuses a draft that doesn't fit, and saves none without a statement", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin);
    const draft = interview(`Unfit ${unique()}`);
    const id = await created(admin, app, draft);
    const [statement] = draft.statements;
    const kept = async (changed: Record<string, unknown>) =>
      codeOf(
        await call(admin, app, "drafts.keep", "mutation", {
          id,
          ...draft,
          ...changed,
        })
      );
    expect({
      // A date that doesn't exist, on each way in.
      created: codeOf(
        await call(admin, app, "drafts.create", "mutation", {
          ...draft,
          source: { ...draft.source, date: "2026-02-30" },
        })
      ),
      proposed: codeOf(
        await call(admin, app, "drafts.propose", "mutation", {
          ...draft,
          source: { ...draft.source, date: "2026-13-01" },
        })
      ),
      keptDate: await kept({ source: { ...draft.source, date: "21-09-2026" } }),
      untitled: await kept({ source: { ...draft.source, title: "   " } }),
      untagged: await kept({ statements: [{ ...statement, tags: [] }] }),
      // Each field within its limit, all at their longest more than a call
      // carries (128 KiB), as much as the store keeps of one record.
      tooLarge: await kept({
        source: { ...draft.source, notes: "€".repeat(30_000) },
        statements: Array.from({ length: 90 }, () => ({
          ...statement,
          quote: "€".repeat(1000),
        })),
      }),
      // More statements than a save writes in one commit.
      tooMany: await kept({
        statements: Array.from({ length: 91 }, () => statement),
      }),
      empty: codeOf(
        await call(admin, app, "drafts.save", "mutation", {
          id,
          ...draft,
          statements: [],
        })
      ),
      // Still there, as it was.
      draft: await stillThere(admin, app, id),
      sources: await sourcesOf(admin, app),
    }).toStrictEqual({
      created: "intake.invalid",
      proposed: "intake.invalid",
      keptDate: "intake.invalid",
      tooLarge: "contract.input_too_large",
      untitled: "contract.invalid_args",
      untagged: "contract.invalid_args",
      tooMany: "contract.invalid_args",
      empty: "intake.no_statements",
      draft: id,
      sources: [],
    });
  });

  it("keeps the later of two edits of a draft, and saves or keeps nothing of one someone discarded", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin);
    const draft = interview(`Raced ${unique()}`);
    const id = await created(admin, app, draft);
    // Someone else keeps their edits first; the later keep, from the same
    // draft, is the one that stays.
    const theirs = codeOf(
      await call(admin, app, "drafts.keep", "mutation", {
        id,
        ...draft,
        statements: [draft.statements[0]],
      })
    );
    const mine = codeOf(
      await call(admin, app, "drafts.keep", "mutation", { id, ...draft })
    );
    const kept = await draftOf(admin, app, id);
    // Someone discards it: a keep or a save of it then finds it gone.
    const discarded = codeOf(
      await call(admin, app, "drafts.discard", "mutation", { id })
    );
    expect({
      theirs,
      mine,
      statements: kept?.statements.length,
      discarded,
      keptAfter: codeOf(
        await call(admin, app, "drafts.keep", "mutation", { id, ...draft })
      ),
      savedAfter: codeOf(
        await call(admin, app, "drafts.save", "mutation", { id, ...draft })
      ),
      draft: await draftOf(admin, app, id),
      sources: await sourcesOf(admin, app),
    }).toStrictEqual({
      theirs: "ok",
      mine: "ok",
      statements: 2,
      discarded: "ok",
      keptAfter: "data.conflict",
      savedAfter: "intake.not_found",
      draft: null,
      sources: [],
    });
  });

  it("is only for the App's builders: no one else reads or writes a draft", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin);
    const draft = interview(`Theirs ${unique()}`);
    const id = await created(admin, app, draft);
    const member = await memberOf(admin, app, "user", "user");
    const builder = await memberOf(admin, app, "builder", "builder");
    const by = async (
      path: string,
      kind: "query" | "mutation" | "action",
      input: unknown = {}
    ) => codeOf(await call(member, app, path, kind, input));

    expect({
      member: {
        list: await by("drafts.list", "query"),
        get: await by("drafts.get", "query", { id }),
        saved: await by("drafts.saved", "query"),
        create: await by("drafts.create", "mutation", draft),
        propose: await by("drafts.propose", "mutation", draft),
        keep: await by("drafts.keep", "mutation", {
          id,
          ...draft,
        }),
        discard: await by("drafts.discard", "mutation", {
          id,
        }),
        save: await by("drafts.save", "mutation", {
          id,
          ...draft,
        }),
        reviewer: await by("drafts.reviewer", "query"),
      },
      builder: {
        reviewer: valueOf(await call(builder, app, "drafts.reviewer", "query")),
        drafts: await draftsOf(builder, app).then((drafts) =>
          drafts.map(({ id: shown }) => shown)
        ),
      },
      // Their draft, untouched.
      draft: await stillThere(admin, app, id),
    }).toStrictEqual({
      member: {
        list: "data.access_denied",
        get: "data.access_denied",
        saved: "data.access_denied",
        create: "data.write_denied",
        propose: "data.write_denied",
        keep: "data.write_denied",
        discard: "data.write_denied",
        // It reads the draft first.
        save: "data.access_denied",
        reviewer: "data.access_denied",
      },
      builder: { reviewer: true, drafts: [id] },
      draft: id,
    });
  });

  it("lists saved sources without their notes, so long notes never stop the list", async () => {
    const admin = await signedInApi(idp, "admin");
    const app = await copyOf(admin);
    const draft = interview(`Long ${unique()}`);
    const long = { ...draft.source, notes: "n".repeat(30_000) };
    // More than a query may answer (256 KiB) were their notes listed.
    const saveLong = async (): Promise<void> => {
      const id = await created(admin, app, { ...draft, source: long });
      valueOf(
        await call(admin, app, "drafts.save", "mutation", {
          id,
          ...draft,
          source: long,
        })
      );
    };
    for (let count = 0; count < 10; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await saveLong();
    }
    const listed = await sourcesOf(admin, app);
    const [first] = listed;
    const whole =
      first === undefined ? null : await sourceOf(admin, app, first.id);
    expect({ listed: listed.length, notes: whole?.notes.length }).toStrictEqual(
      {
        listed: 10,
        notes: 30_000,
      }
    );
  });
});
