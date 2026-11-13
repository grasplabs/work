// @vitest-environment happy-dom
import type { Connection } from "@grasp-os/shared/brain";
import type {
  BrainSearchPack,
  BrainSourceListed,
  BrainSourceRef,
  BrainSourcesAfter,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
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
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { SourcesPage } from "./sources-page.tsx";

// The Brain's Sources page, against core's `brainSources` as the page
// reaches it over RPC, faked: the sources core lists, a page at a time,
// one opened at its newest version and then an older one; search shows
// recall's pack as core gives it, in its order, with what it didn't find
// and that it was cut short, and opens a result's source at its version;
// each connection says how it feeds the Brain; a refusal is said; a file
// uploads for the readers chosen, and an upload's panel offers what core
// says the person may do to it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const handbook: BrainSourceRef = { producer: "upload", id: "u-1" };
const minutes: BrainSourceRef = { producer: "chat", id: "c-1" };
const older: BrainSourceRef = { producer: "run", id: "r-1" };
const uploaded: BrainSourceRef = { producer: "upload", id: "u-2" };

/** The teams the person is in. */
const teams = [{ id: "t-1", name: "Finance" }];

const listed = (
  source: BrainSourceRef,
  firstLine: string,
  versions = 1,
  personal = false
): BrainSourceListed => ({
  source,
  version: versions,
  addedAt: "2026-11-10T09:00:00.000Z",
  firstLine,
  personal,
  versions,
});

const texts: Record<string, string> = {
  "u-1@2": "Handbook\nInvoices are paid on Fridays.",
  "u-1@1": "Handbook draft\nInvoices are paid monthly.",
  "c-1@1": "Board minutes",
};

const pack: BrainSearchPack = {
  items: [
    {
      source: handbook,
      version: 1,
      position: 0,
      text: "Invoices are paid monthly.",
      whole: true,
      found: "exact",
    },
    {
      source: minutes,
      version: 1,
      position: 0,
      text: "Board minutes",
      whole: false,
      found: "meaning",
    },
  ],
  notFound: ["refunds", "INV-7"],
  truncated: true,
};

/** Lets every pending read settle. */
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await Promise.resolve();
    }
  });
};

/** How the faked core answers. */
interface Faked {
  /** Refuses every call with this. */
  refusal?: string;
  /** Holds each search until it settles. */
  searched?: Promise<boolean>;
  /** Holds each read of a source's first version until it settles. */
  firstRead?: Promise<boolean>;
  /** Lists no source at all. */
  empty?: boolean;
  /** Refuses uploads, and reading what may be done to one, with this. */
  uploadRefusal?: string;
  /** Holds each upload until it settles. */
  uploading?: Promise<boolean>;
  /** Refuses the first upload with this coded error, as core refuses one. */
  firstUploadRefused?: { code: string; message: string };
  /** Holds each new version until it settles. */
  versioning?: Promise<boolean>;
  /** Holds each delete until it settles. */
  deleting?: Promise<boolean>;
}

/** A question nothing the person may read holds: its pack is empty. */
const unmatched = "zeppelin";

/** Shows the page on a faked core, answering as `faked` says. */
const shown = async (
  connections: Connection[],
  {
    refusal,
    searched,
    firstRead,
    empty = false,
    uploadRefusal,
    uploading,
    firstUploadRefused,
    versioning,
    deleting,
  }: Faked = {}
) => {
  const calls: string[] = [];
  /** The upload id each upload was sent with, in order. */
  const uploadIds: string[] = [];
  const brainSources = {
    list: async (after?: BrainSourcesAfter) => {
      await Promise.resolve();
      calls.push(
        `list${after === undefined ? "" : ` after ${after.source.id}`}`
      );
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      if (empty) {
        return { sources: [], next: null };
      }
      return after === undefined
        ? {
            sources: [
              listed(handbook, "Handbook", 2, true),
              listed(minutes, "Board minutes"),
            ],
            next: { addedAt: "2026-11-10T09:00:00.000Z", source: minutes },
          }
        : { sources: [listed(older, "")], next: null };
    },
    versions: async (source: BrainSourceRef) => {
      await Promise.resolve();
      calls.push(`versions ${source.id}`);
      return {
        versions:
          source.id === handbook.id
            ? [
                { version: 2, addedAt: "2026-11-10T09:00:00.000Z" },
                { version: 1, addedAt: "2026-11-09T09:00:00.000Z" },
              ]
            : [{ version: 1, addedAt: "2026-11-10T09:00:00.000Z" }],
        before: null,
      };
    },
    read: async (source: BrainSourceRef, version: number) => {
      await Promise.resolve();
      calls.push(`read ${source.id}@${version}`);
      if (version === 1) {
        await (firstRead ?? Promise.resolve(true));
      }
      const text = texts[`${source.id}@${version}`];
      return text === undefined
        ? null
        : { source, version, addedAt: "2026-11-10T09:00:00.000Z", text };
    },
    search: async (question: string) => {
      calls.push(`search ${question}`);
      await (searched ?? Promise.resolve());
      return question === unmatched
        ? { items: [], notFound: [unmatched], truncated: false }
        : pack;
    },
    upload: async (
      file: { name: string; bytes: Uint8Array },
      readers: BrainUploadReaders,
      uploadId: string
    ) => {
      uploadIds.push(uploadId);
      await (uploading ?? Promise.resolve());
      if (uploadRefusal !== undefined) {
        throw new Error(uploadRefusal);
      }
      if (firstUploadRefused !== undefined && uploadIds.length === 1) {
        throw Object.assign(new Error(firstUploadRefused.message), {
          code: firstUploadRefused.code,
        });
      }
      const team = readers.kind === "team" ? ` ${readers.teamId}` : "";
      calls.push(
        `upload ${file.name} (${file.bytes.byteLength} bytes) for ${readers.kind}${team}`
      );
      return { source: uploaded, version: 1 };
    },
    uploadVersion: async (
      uploadId: string,
      file: { name: string; bytes: Uint8Array }
    ) => {
      await (versioning ?? Promise.resolve());
      calls.push(`uploadVersion ${uploadId} ${file.name}`);
      return { source: handbook, version: 3 };
    },
    // The handbook is the person's upload, for a team of theirs.
    uploadOf: async (uploadId: string) => {
      await Promise.resolve();
      if (uploadRefusal !== undefined) {
        throw new Error(uploadRefusal);
      }
      return uploadId === handbook.id
        ? {
            source: handbook,
            readers: { kind: "team" as const, teamId: "t-1" },
            mayAddVersion: true,
            mayDelete: true,
          }
        : null;
    },
    deleteUpload: async (uploadId: string) => {
      await (deleting ?? Promise.resolve());
      calls.push(`deleteUpload ${uploadId}`);
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { brainSources: typeof brainSources }) => Promise<T>
    ): Promise<T> => await action({ brainSources }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SourcesPage connections={connections} teams={teams} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
    context: { core },
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
  await settle();
  return { calls, uploadIds };
};

/** Presses the button whose text starts with `label`. */
const press = async (label: string): Promise<void> => {
  const button = [...document.querySelectorAll("button")].find((each) =>
    each.textContent.startsWith(label)
  );
  if (!button) {
    throw new TypeError(`No button ${label}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Searches for `question`. */
const search = async (question: string): Promise<void> => {
  const box = document.querySelector("input");
  const form = document.querySelector("form");
  if (!box || !form) {
    throw new TypeError("No search box");
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(box, question);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await settle();
};

/** The text of the opened source's panel. */
const panel = (): string =>
  document.querySelector("[data-slot=card]")?.textContent ?? "";

/** The text of the section whose heading is `heading`. */
const section = (heading: string): string =>
  [...document.querySelectorAll("section[aria-labelledby]")].find(
    (each) =>
      document.querySelector(`[id="${each.getAttribute("aria-labelledby")}"]`)
        ?.textContent === heading
  )?.textContent ?? "";

describe(SourcesPage, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("lists the sources core gives a page at a time, and opens one at its newest version, then an older one", async () => {
    const { calls } = await shown([]);
    await press("Show more");
    const listedText = document.body.textContent;
    await press("Handbook");
    const newest = panel();
    await press("Version 1");
    const oldest = panel();

    expect({
      listed: [
        "Handbook",
        "Board minutes",
        "No first line",
        "2 versions",
        "Only you",
        "Those marked Only you are yours alone",
      ].map((text) => listedText.includes(text)),
      moreGone: listedText.includes("Show more"),
      newest: newest.includes("Invoices are paid on Fridays."),
      oldest: oldest.includes("Invoices are paid monthly."),
      calls,
    }).toStrictEqual({
      listed: [true, true, true, true, true, true],
      moreGone: false,
      newest: true,
      oldest: true,
      calls: [
        "list",
        "list after c-1",
        "versions u-1",
        "read u-1@2",
        "read u-1@1",
      ],
    });
  });

  it("shows recall's pack as core gives it, and opens a result's source at its version", async () => {
    const { calls } = await shown([]);
    await search("  invoices refunds  ");
    const resultText = section("Results");
    await press("Invoices are paid monthly.");

    expect({
      order:
        resultText.indexOf("Invoices are paid monthly.") <
        resultText.indexOf("Board minutes"),
      found: ["Exact match", "By meaning", "The best part of its passage"].map(
        (text) => resultText.includes(text)
      ),
      notFound: resultText.includes(
        "Nothing you may read holds refunds and INV-7."
      ),
      truncated: resultText.includes("More was found than fits"),
      opened: panel().includes("Invoices are paid monthly."),
      calls,
    }).toStrictEqual({
      order: true,
      found: [true, true, true],
      notFound: true,
      truncated: true,
      opened: true,
      calls: ["list", "search invoices refunds", "versions u-1", "read u-1@1"],
    });
  });

  it("opens a result at the version it cites, even after another version was picked in its panel", async () => {
    await shown([]);
    await search("invoices");
    await press("Invoices are paid monthly.");
    const cited = panel();
    await press("Version 2");
    const picked = panel();
    await press("Invoices are paid monthly.");

    expect({
      cited: cited.includes("Invoices are paid monthly."),
      picked: picked.includes("Invoices are paid on Fridays."),
      again: panel().includes("Invoices are paid monthly."),
    }).toStrictEqual({ cited: true, picked: true, again: true });
  });

  it("shows a version picked as loading until its own text arrives, never the text of the one before", async () => {
    const read = Promise.withResolvers<boolean>();
    await shown([], { firstRead: read.promise });
    await press("Handbook");
    const newest = panel();
    await press("Version 1");
    const waiting = panel();
    read.resolve(true);
    await settle();

    expect({
      newest: newest.includes("Invoices are paid on Fridays."),
      waiting: waiting.includes("Invoices are paid on Fridays."),
      arrived: panel().includes("Invoices are paid monthly."),
    }).toStrictEqual({ newest: true, waiting: false, arrived: true });
  });

  it("says once that a search found nothing, and what wasn't found only beside what was", async () => {
    await shown([]);
    await search(unmatched);
    const nothing = section("Results");
    await search("invoices refunds");
    const some = section("Results");

    expect({
      nothing: [
        "Nothing you may read matched.",
        `Nothing you may read holds ${unmatched}.`,
      ].map((text) => nothing.includes(text)),
      some: some.includes("Nothing you may read holds refunds and INV-7."),
    }).toStrictEqual({ nothing: [true, false], some: true });
  });

  it("says what Only you means only when there are sources to mark", async () => {
    await shown([], { empty: true });
    const empty = section("Sources you may read");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);
    const listedText = section("Sources you may read");

    expect({
      empty: {
        onlyYou: empty.includes("Those marked Only you"),
        documents: empty.includes(
          "Documents and workflow runs show here once they reach the Brain."
        ),
      },
      listed: listedText.includes("Those marked Only you"),
    }).toStrictEqual({
      empty: { onlyYou: false, documents: true },
      listed: true,
    });
  });

  it("asks one search at a time: a question sent while one is searched is not asked", async () => {
    const answered = Promise.withResolvers<boolean>();
    const { calls } = await shown([], { searched: answered.promise });
    await search("invoices");
    await search("refunds");
    answered.resolve(true);
    await settle();

    expect({
      calls,
      shown: section("Results").includes("Invoices are paid monthly."),
    }).toStrictEqual({ calls: ["list", "search invoices"], shown: true });
  });

  it("says for each connection that agents search it live and the Brain keeps nothing, and says when there are none", async () => {
    await shown([
      { name: "Gmail", status: "connected", via: "direct", matches: [] },
      { name: "HubSpot", status: "connected", via: "composio", matches: [] },
    ]);
    const feeds = section("How your connections feed the Brain");
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);
    const none = section("How your connections feed the Brain");

    expect({ feeds, none }).toStrictEqual({
      feeds:
        "How your connections feed the Brain" +
        "Gmail: agents search it live when you ask. The Brain keeps nothing from it." +
        "HubSpot: agents search it live when you ask. The Brain keeps nothing from it.",
      none: "How your connections feed the BrainYou have no connections yet.",
    });
  });

  it("says why core refused, and shows nothing as listed", async () => {
    await shown([], { refusal: "You aren't a member of this organization." });
    const text = document.body.textContent;

    expect({
      refusal: text.includes("You aren't a member of this organization."),
      empty: text.includes("Nothing in the Brain you may read yet"),
    }).toStrictEqual({ refusal: true, empty: false });
  });

  it("uploads a file for the team chosen, then offers its uploader a new version and deleting it", async () => {
    // React says what it can't render right (two children of one key) here.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls } = await shown([]);
    const [, picker] = document.querySelectorAll("input");
    const readers = document.querySelector("select");
    const form = picker?.closest("form");
    if (!(picker && readers && form)) {
      throw new TypeError("No upload form");
    }
    const options = [...readers.options].map(({ textContent }) => textContent);
    await act(async () => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["WEBVTT"], "notes.vtt", { type: "text/vtt" })],
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      readers.value = "t-1";
      readers.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    await settle();
    await press("Handbook");
    await settle();
    const opened = panel();
    await press("Delete");
    await press("Delete for good");
    await settle();

    expect({
      options,
      errors: errors.mock.calls.map(([message]) => String(message)),
      opened: [
        "Team Finance can read this upload.",
        "Upload new version",
        "Delete",
      ].map((text) => opened.includes(text)),
      closed: panel(),
      calls: calls.filter((call) => !call.startsWith("read")),
    }).toStrictEqual({
      options: ["Only me", "Team Finance", "Everyone"],
      errors: [],
      opened: [true, true, true],
      closed: "",
      calls: [
        "list",
        "upload notes.vtt (6 bytes) for team t-1",
        "list",
        "versions u-2",
        "versions u-1",
        "deleteUpload u-1",
        "list",
      ],
    });
  });

  it("chooses Only me until the person picks other readers, and says why an upload or an upload's details were refused", async () => {
    const refused = "Files are being read for many people at the moment.";
    await shown([], { uploadRefusal: refused });
    const [, picker] = document.querySelectorAll("input");
    const readers = document.querySelector("select");
    const form = picker?.closest("form");
    if (!(picker && readers && form)) {
      throw new TypeError("No upload form");
    }
    const chosen = readers.selectedOptions[0]?.textContent;
    await act(async () => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["WEBVTT"], "notes.vtt", { type: "text/vtt" })],
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    const uploadText = section("Upload a file");
    await press("Handbook");
    await settle();

    expect({
      chosen,
      accepts: picker.accept,
      uploadSaysWhy: uploadText.includes(refused),
      panelSaysWhy: panel().includes(refused),
    }).toStrictEqual({
      chosen: "Only me",
      accepts: ".pdf,.docx,.xlsx,.vtt",
      uploadSaysWhy: true,
      panelSaysWhy: true,
    });
  });

  it("says it uploads while it does, says a file's text is too long in the person's words, and retries with the same upload's id", async () => {
    const held = Promise.withResolvers<boolean>();
    const { uploadIds } = await shown([], {
      uploading: held.promise,
      firstUploadRefused: {
        code: "brain.upload_text_too_long",
        message: "Core's own words",
      },
    });
    const [, picker] = document.querySelectorAll("input");
    const form = picker?.closest("form");
    if (!(picker && form)) {
      throw new TypeError("No upload form");
    }
    const choose = async (name: string) => {
      await act(async () => {
        Object.defineProperty(picker, "files", {
          configurable: true,
          value: [new File(["WEBVTT"], name, { type: "text/vtt" })],
        });
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
    };
    const submit = async () => {
      await act(async () => {
        form.requestSubmit();
        await Promise.resolve();
      });
      await settle();
    };
    await choose("long.vtt");
    await submit();
    const whileHeld = section("Upload a file");
    held.resolve(true);
    await settle();
    const refusedText = section("Upload a file");
    await submit();
    await choose("other.vtt");
    await submit();

    expect({
      whileHeld: whileHeld.includes("Uploading…"),
      refused: [
        refusedText.includes(
          "This file's text is too long for the Brain to keep."
        ),
        refusedText.includes("Core's own words"),
      ],
      sameOnRetry: uploadIds[0] === uploadIds[1],
      newForAnotherFile: uploadIds[2] !== uploadIds[1],
      ids: uploadIds.length,
    }).toStrictEqual({
      whileHeld: true,
      refused: [true, false],
      sameOnRetry: true,
      newForAnotherFile: true,
      ids: 3,
    });
  });

  it("keeps the file picker out of reach while a file uploads, so the next file chosen isn't lost", async () => {
    const held = Promise.withResolvers<boolean>();
    await shown([], { uploading: held.promise });
    const [, picker] = document.querySelectorAll("input");
    const form = picker?.closest("form");
    if (!(picker && form)) {
      throw new TypeError("No upload form");
    }
    await act(async () => {
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["WEBVTT"], "first.vtt", { type: "text/vtt" })],
      });
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    const before = picker.disabled;
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    await settle();
    const whileUploading = picker.disabled;
    held.resolve(true);
    await settle();

    expect({ before, whileUploading, after: picker.disabled }).toStrictEqual({
      before: false,
      whileUploading: true,
      after: false,
    });
  });

  it("leaves the source opened meanwhile open when a new version or a delete of another one finishes", async () => {
    const versioned = Promise.withResolvers<boolean>();
    const deleted = Promise.withResolvers<boolean>();
    await shown([], {
      versioning: versioned.promise,
      deleting: deleted.promise,
    });
    // A new version of the handbook, still under way as the minutes open.
    await press("Handbook");
    await settle();
    const versionPicker = [...document.querySelectorAll("input")].find(
      (input) =>
        input.type === "file" && input.closest("[data-slot=card]") !== null
    );
    const versionForm = versionPicker?.closest("form");
    if (!(versionPicker && versionForm)) {
      throw new TypeError("No new version form");
    }
    await act(async () => {
      Object.defineProperty(versionPicker, "files", {
        configurable: true,
        value: [new File(["WEBVTT"], "handbook.vtt", { type: "text/vtt" })],
      });
      versionPicker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      versionForm.requestSubmit();
      await Promise.resolve();
    });
    await press("Board minutes");
    await settle();
    versioned.resolve(true);
    await settle();
    const afterVersion = panel();
    // A delete of the handbook, still under way as the minutes open.
    await press("Handbook");
    await settle();
    await press("Delete");
    await press("Delete for good");
    await press("Board minutes");
    await settle();
    deleted.resolve(true);
    await settle();
    const afterDelete = panel();

    expect({
      afterVersion: [
        afterVersion.includes("Board minutes"),
        afterVersion.includes("Invoices"),
      ],
      afterDelete: [
        afterDelete.includes("Board minutes"),
        afterDelete.includes("Invoices"),
      ],
    }).toStrictEqual({
      afterVersion: [true, false],
      afterDelete: [true, false],
    });
  });
});
