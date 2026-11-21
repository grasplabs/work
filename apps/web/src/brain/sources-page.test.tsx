// @vitest-environment happy-dom
import type { Connection, Source } from "@grasp-os/shared/brain";
import type {
  BrainMemoryShown,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
import type {
  BrainLearned,
  BrainSearchPack,
  BrainSourceListed,
  BrainSourceRef,
  BrainSourcesAfter,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
import { uploadMaxBytes } from "@grasp-os/shared/uploads";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { formatDate, formatDateTime } from "../format.ts";
import { ms } from "../grasp/tokens/tokens.values.ts";
import { SourcesPage } from "./sources-page.tsx";

// The Brain's Sources page, against core's `brainSources` as the page
// reaches it over RPC, faked: the sources core lists, a page at a time,
// one opened at its newest version and then an older one, among the
// Brain's own sources, newest first, each of which opens its own page;
// search shows recall's pack as core gives it, in its order, with what it
// didn't find and that it was cut short, and opens a result's source at
// its version; each connection says how it feeds the Brain; a refusal is
// said; a file uploads for the readers chosen, and an upload's panel
// offers what core says the person may do to it.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const handbook: BrainSourceRef = { producer: "upload", id: "u-1" };
const minutes: BrainSourceRef = { producer: "chat", id: "c-1" };
const older: BrainSourceRef = { producer: "run", id: "r-1" };
const uploaded: BrainSourceRef = { producer: "upload", id: "u-2" };
const shared: BrainSourceRef = { producer: "upload", id: "u-3" };
/** A shared upload for a team since deleted, which the admin may not read. */
const unnamed: BrainSourceRef = { producer: "upload", id: "u-4" };

/** The teams the person is in. */
const teams = [{ id: "t-1", name: "Finance" }];

/** When each listed source was added. */
const addedAt = "2026-11-10T09:00:00.000Z";

const listed = (
  source: BrainSourceRef,
  firstLine: string,
  versions = 1,
  personal = false
): BrainSourceListed => ({
  source,
  version: versions,
  addedAt,
  firstLine,
  personal,
  versions,
});

/** When the source read through a connection was last read. */
const lastReadAt = "2026-11-12T10:00:00.000Z";

/** A record agents read through a shared connection an admin opened to the person. */
const deal: BrainSourceRef = { producer: "connected", id: "conn-1/0/abc" };

const texts: Record<string, string> = {
  "conn-1/0/abc@1": "Deal Rotterdam warehouse",
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
  memories: [
    {
      store: "own",
      id: "m-1",
      statement: "I pay invoices on Fridays",
      quote: "pay them on Fridays",
      context: {
        position: 0,
        text: "Remember: I pay them on Fridays, always.",
      },
      source: null,
      said: "you",
      confirmed: false,
      contested: false,
      found: "words",
    },
    {
      store: "shared",
      id: "m-2",
      statement: "Invoices are paid on Fridays",
      quote: null,
      context: null,
      source: { source: handbook, version: 2 },
      said: "outside",
      confirmed: true,
      contested: true,
      found: "entities",
    },
    {
      store: "shared",
      id: "m-3",
      statement: "Invoices over 10,000 need a second approval",
      quote: null,
      context: null,
      source: null,
      said: "system",
      confirmed: false,
      contested: false,
      found: "words",
    },
  ],
  notFound: ["refunds", "INV-7"],
  truncated: true,
};

/** A question only memories answer: its pack holds no passage. */
const remembered = "fridays";

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
  /** Shows the page as an admin's. */
  admin?: boolean;
  /**
   * What the person's Delete of the handbook does, as core says: `erase`
   * by default; `remove` for its uploader, it being shared; null for a
   * reader who may not delete it, who may add no version either.
   */
  handbookDeletes?: "erase" | "remove" | null;
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
  /** Deletes, then answers not found: a delete done before, its answer lost. */
  deleteAnswerLost?: boolean;
  /** Refuses the first new version with this, as a lost answer would. */
  firstVersionRefused?: string;
  /** A shared connection keeps records the person may read, and search finds one. */
  kept?: boolean;
  /**
   * What the Brain learned from each version (`<id>@<version>`, and
   * `#<cursor's memory>` for a page after the first), as core answers:
   * none (null) for any other; a string is a refusal.
   */
  learned?: Record<string, BrainLearned | null | string>;
  /** The Brain's own sources, as `brain.read` gives them. */
  sources?: Source[];
}

/** A question nothing the person may read holds: its pack is empty. */
const unmatched = "zeppelin";

/** The Memories page, as far as a link to it goes: where it was asked to open. */
const MemoriesStandIn = () => {
  const { searchStr } = useLocation();
  return <p>Memories page {searchStr}</p>;
};

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
    admin = false,
    handbookDeletes = "erase",
    deleteAnswerLost = false,
    firstVersionRefused,
    kept = false,
    learned = {},
    sources = [],
  }: Faked = {}
) => {
  const calls: string[] = [];
  /** The upload id each upload was sent with, in order. */
  const uploadIds: string[] = [];
  /** The version id each new version was sent with, in order. */
  const versionIds: string[] = [];
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
        : {
            // Read through a connection: core says when it was last read.
            sources: [{ ...listed(older, ""), readAt: lastReadAt }],
            next: null,
          };
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
    learned: async (
      source: BrainSourceRef,
      version: number,
      next?: BrainStoreCursor | null
    ) => {
      await Promise.resolve();
      const after =
        next === undefined || next === null ? "" : `#${String(next.memory)}`;
      const answer = learned[`${source.id}@${version}${after}`] ?? null;
      if (typeof answer === "string") {
        throw new TypeError(answer);
      }
      return answer;
    },
    search: async (question: string) => {
      calls.push(`search ${question}`);
      await (searched ?? Promise.resolve());
      if (question === unmatched) {
        return {
          items: [],
          memories: [],
          notFound: [unmatched],
          truncated: false,
        };
      }
      if (kept) {
        return {
          ...pack,
          memories: [],
          items: [
            {
              source: deal,
              version: 1,
              position: 0,
              text: "Deal Rotterdam warehouse",
              whole: true,
              found: "words" as const,
            },
          ],
        };
      }
      return question === remembered ? { ...pack, items: [] } : pack;
    },
    connections: async () => {
      await Promise.resolve();
      return kept
        ? [
            {
              connectionId: "conn-1",
              name: "HubSpot",
              account: "sales@acme.test",
              records: 3,
              lastReadAt: "2026-11-12T10:00:00.000Z",
            },
          ]
        : [];
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
      file: { name: string; bytes: Uint8Array },
      versionId: string
    ) => {
      versionIds.push(versionId);
      await (versioning ?? Promise.resolve());
      if (firstVersionRefused !== undefined && versionIds.length === 1) {
        throw new Error(firstVersionRefused);
      }
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
            mayAddVersion: handbookDeletes !== null,
            deletes: handbookDeletes,
          }
        : null;
    },
    // One upload shared with a team: what an admin's listing shows.
    sharedUploads: async () => {
      await Promise.resolve();
      calls.push("sharedUploads");
      // One the admin may read, by name; one for a team since deleted
      // that they weren't in, without it.
      const uploads = [
        {
          source: shared,
          name: "Payroll.vtt",
          readers: { kind: "team" as const, teamId: "t-2" },
          teamName: "Payroll",
          uploaderName: "Ada",
          uploadedAt: "2026-11-10T09:00:00.000Z",
          removedAt: null,
        },
        {
          source: unnamed,
          name: null,
          readers: { kind: "team" as const, teamId: "t-3" },
          teamName: null,
          uploaderName: "Grace",
          uploadedAt: "2026-11-09T09:00:00.000Z",
          // Removed by its uploader: no name, and still listed to erase.
          removedAt: "2026-11-11T09:00:00.000Z",
        },
      ];
      return {
        uploads: uploads.filter(
          ({ source }) => !calls.includes(`deleteUpload ${source.id}`)
        ),
        next: null,
      };
    },
    deleteUpload: async (uploadId: string) => {
      await (deleting ?? Promise.resolve());
      calls.push(`deleteUpload ${uploadId}`);
      if (deleteAnswerLost) {
        throw Object.assign(
          new Error("There's no such upload, or you may not change it."),
          { code: "brain.upload_not_found" }
        );
      }
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
    component: () => (
      <SourcesPage
        admin={admin}
        connections={connections}
        sources={sources}
        teams={teams}
      />
    ),
  });
  const memoriesPage = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/memories",
    component: MemoriesStandIn,
  });
  const note = createRoute({
    getParentRoute: () => rootRoute,
    path: "/brain/$noteId",
    component: () => <p>A note</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, memoriesPage, note]),
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
  return { calls, uploadIds, versionIds, router };
};

/** Chooses `file` in `picker`. */
const pick = async (picker: HTMLInputElement, file: File): Promise<void> => {
  await act(async () => {
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [file],
    });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
};

/** Sends `form`. */
const submitted = async (form: HTMLFormElement): Promise<void> => {
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await settle();
};

/** The upload's dialog, while it is open. */
const uploadDialog = (): Element | null =>
  document.querySelector('[role="dialog"]');

/** The text of the upload's dialog, or nothing while it is closed. */
const uploadText = (): string => uploadDialog()?.textContent ?? "";

/** Presses the upload's dialog's Upload. */
const uploadPressed = async (): Promise<void> => {
  const upload = [...(uploadDialog()?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent.trim().startsWith("Upload")
  );
  if (upload === undefined) {
    throw new TypeError("No Upload in the upload's dialog");
  }
  await act(async () => {
    upload.click();
    await Promise.resolve();
  });
  await settle();
};

/** Opens the upload's dialog by the page head's Upload, unless it is open. */
const openUpload = async (): Promise<void> => {
  if (uploadDialog() !== null) {
    return;
  }
  const trigger = [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]'
    ),
  ].find((each) => each.textContent.trim() === "Upload");
  if (trigger === undefined) {
    throw new TypeError("No Upload in the page's head");
  }
  await act(async () => {
    trigger.click();
    await Promise.resolve();
  });
  await settle();
};

/** Closes the upload's dialog by its Cancel. */
const cancelUpload = async (): Promise<void> => {
  const cancel = [...(uploadDialog()?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent.trim().startsWith("Cancel")
  );
  if (cancel === undefined) {
    throw new TypeError("No Cancel in the upload's dialog");
  }
  await act(async () => {
    cancel.click();
    await Promise.resolve();
  });
  await settle();
};

/** The upload's file picker as it stands, in its dialog: it starts afresh each time the dialog opens. */
const uploadPicker = (): HTMLInputElement => {
  const picker = [...(uploadDialog()?.querySelectorAll("input") ?? [])].find(
    (input) => input.type === "file"
  );
  if (!picker) {
    throw new TypeError("No upload picker");
  }
  return picker;
};

/** The upload's form. */
const uploadForm = (): HTMLFormElement => {
  const form = uploadPicker().closest("form");
  if (!form) {
    throw new TypeError("No upload form");
  }
  return form;
};

/** The upload's choice of who may read it, a library Select's trigger. */
const readersChoice = (): HTMLElement => {
  const control = uploadForm().querySelector<HTMLElement>('[role="combobox"]');
  if (control === null) {
    throw new TypeError("No choice of readers");
  }
  return control;
};

/** What the choice of readers shows as chosen, without what is hidden from a screen reader. */
const readersChosen = (): string => {
  const copy = readersChoice().cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};

/** Opens the choice of readers and gives its options. */
const readerOptions = async (): Promise<HTMLElement[]> => {
  const control = readersChoice();
  await act(async () => {
    control.click();
    await Promise.resolve();
  });
  await settle();
  const list = document.querySelector(
    `[id="${control.getAttribute("aria-controls") ?? ""}"]`
  );
  return [
    ...(list ?? document).querySelectorAll<HTMLElement>('[role="option"]'),
  ];
};

/** The page's text as a person sees it: nothing hidden, such as a closed panel. */
const visibleText = (): string => {
  const copy = document.body.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[hidden]")) {
    hidden.remove();
  }
  return copy.textContent;
};

/** The opened upload's new version picker and its form. */
const versionFormOf = () => {
  const picker = [...document.querySelectorAll("input")].find(
    (input) =>
      input.type === "file" && input.closest("[data-slot=panel]") !== null
  );
  const form = picker?.closest("form");
  if (!(picker && form)) {
    throw new TypeError("No new version form");
  }
  return { picker, form };
};

/** A file whose size the browser reports as `size`, its bytes never read. */
const fileSized = (name: string, size: number): File => {
  const file = new File(["WEBVTT"], name, { type: "text/vtt" });
  Object.defineProperty(file, "size", { value: size });
  file.arrayBuffer = () => {
    throw new Error("Read a file past the limit");
  };
  return file;
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

/**
 * Presses the open alert dialog's answer that says `label`. Its words come
 * first: the library's action button also holds its working and failed words.
 */
const answer = async (label: string): Promise<void> => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[role="alertdialog"] button'
    ),
  ].find((each) => each.textContent.trim().startsWith(label));
  if (found === undefined) {
    throw new TypeError(`No answer ${label}`);
  }
  await act(async () => {
    found.click();
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
  document.querySelector("[data-slot=panel]")?.textContent ?? "";

/** Opens the search result whose source is titled `title`, by its open-version action. */
const openResult = async (title: string): Promise<void> => {
  const button = [...document.querySelectorAll("[data-slot=item]")]
    .find((each) => each.textContent.startsWith(title))
    ?.querySelector("button");
  if (!button) {
    throw new TypeError(`No result ${title}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await settle();
};

/** Follows the link whose text starts with `label`. */
const follow = async (label: string): Promise<void> => {
  const link = [...document.querySelectorAll("a")].find((each) =>
    each.textContent.startsWith(label)
  );
  if (!link) {
    throw new TypeError(`No link ${label}`);
  }
  await act(async () => {
    link.click();
    await Promise.resolve();
  });
  await settle();
};

/** The text of the section whose heading is `heading`, as it is or counted, as a library list's is ("Results · 2"). */
const section = (heading: string): string =>
  [...document.querySelectorAll("section[aria-labelledby]")].find((each) => {
    const said = document.querySelector(
      `[id="${each.getAttribute("aria-labelledby")}"]`
    )?.textContent;
    return said === heading || said?.startsWith(`${heading} · `) === true;
  })?.textContent ?? "";

/** A memory as core shows one, about entity `about`. */
const memoryShown = (
  id: string,
  statement: string,
  about: string,
  contested = false
): BrainMemoryShown => ({
  store: "shared",
  id,
  about,
  attribute: null,
  object: null,
  value: null,
  type: "fact",
  statement,
  quote: null,
  source: { source: handbook, version: 2 },
  yours: false,
  learnedAt: "2026-11-10T09:00:00.000Z",
  endedAt: null,
  confirmed: null,
  validFrom: null,
  validUntil: null,
  contested,
});

/**
 * What the handbook's second version taught the Brain: a rule it added,
 * which another source disagrees with, about an entity first seen there;
 * and the first version's rule it replaced, about one seen before.
 */
const handbookLearned: BrainLearned = {
  memories: [
    {
      part: "added",
      memory: {
        ...memoryShown("m-a", "Invoices are paid on Fridays", "e-1", true),
        // Owned by Ada, whom the Brain first saw here too.
        attribute: "owner",
        object: { id: "e-3", name: "Ada" },
      },
      rivals: [
        {
          ...memoryShown("m-r", "Invoices are paid on Mondays", "e-1"),
          // Another source names Grace as the owner.
          attribute: "owner",
          object: { id: "e-4", name: "Grace" },
        },
      ],
      moreRivals: true,
    },
    {
      part: "ended",
      memory: memoryShown("m-b", "Invoices are paid monthly", "e-2"),
      rivals: [],
      moreRivals: false,
    },
    // The handbook's current text no longer says it, and nothing replaced it.
    {
      part: "out",
      memory: memoryShown("m-o", "Invoices are checked by hand", "e-2"),
      rivals: [],
      moreRivals: false,
    },
  ],
  entities: [
    {
      entity: { store: "shared", id: "e-1" },
      kind: "routine",
      name: "Paying invoices",
      unreadable: false,
      borrowed: false,
      firstSeen: true,
    },
    {
      entity: { store: "shared", id: "e-3" },
      kind: "person",
      name: "Ada Lovelace",
      unreadable: false,
      borrowed: false,
      firstSeen: true,
    },
    {
      entity: { store: "shared", id: "e-4" },
      kind: "person",
      name: "Grace Hopper",
      unreadable: false,
      borrowed: false,
      firstSeen: false,
    },
    {
      entity: { store: "shared", id: "e-2" },
      kind: "term",
      name: "Invoice",
      unreadable: false,
      borrowed: false,
      firstSeen: false,
    },
  ],
  next: null,
};

/** The text of the section of what the Brain learned, or none. */
const learnedSection = (): string | undefined =>
  [...document.querySelectorAll("section[aria-labelledby]")].find(
    (each) =>
      document.querySelector(`[id="${each.getAttribute("aria-labelledby")}"]`)
        ?.textContent === "What the Brain learned from this version"
  )?.textContent;

describe(SourcesPage, () => {
  beforeEach(() => {
    // Core's route of the person's own export, at the page's foot
    // (own-export.tsx, its own tests): none started.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(Response.json({ export: null })))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lists the sources core gives a page at a time, says when one read through a connection was last read, and opens one at its newest version, then an older one", async () => {
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
      ].map((text) => listedText.includes(text)),
      moreGone: listedText.includes("Show more"),
      // Once, for the one source core gave a read time, as the day only.
      lastRead: [
        listedText.split(`Last read ${formatDate(lastReadAt)}`).length,
        listedText.includes(formatDateTime(lastReadAt)),
      ],
      // Each row says the day it was added, without the time.
      added: [formatDate(addedAt), formatDateTime(addedAt)].map((text) =>
        listedText.includes(text)
      ),
      newest: newest.includes("Invoices are paid on Fridays."),
      oldest: oldest.includes("Invoices are paid monthly."),
      calls,
    }).toStrictEqual({
      listed: [true, true, true, true, true],
      moreGone: false,
      lastRead: [2, false],
      added: [true, false],
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

  it("closes the source opened, and leaves the list as it was", async () => {
    await shown([]);
    await press("Handbook");
    const opened = panel();
    const close = document.querySelector<HTMLButtonElement>(
      '[data-slot=panel] button[aria-label="Close"]'
    );
    await act(async () => {
      close?.click();
      await Promise.resolve();
    });
    await settle();

    expect({
      opened: opened.includes("Invoices are paid on Fridays."),
      closed: panel(),
      listed: section("Sources you may read").includes("Handbook"),
    }).toStrictEqual({ opened: true, closed: "", listed: true });
  });

  it("shows recall's pack as core gives it, and opens a result's source at its version", async () => {
    const { calls } = await shown([]);
    await search("  invoices refunds  ");
    const resultText = section("Results");
    const pageText = document.body.textContent;
    await openResult("Handbook");

    expect({
      order:
        resultText.indexOf("Invoices are paid monthly.") <
        resultText.indexOf("Board minutes"),
      found: ["Exact match", "By meaning", "The best part of its passage"].map(
        (text) => resultText.includes(text)
      ),
      notFound: pageText.includes(
        "Nothing you may read holds refunds and INV-7."
      ),
      truncated: pageText.includes("More was found than fits"),
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

  it("shows every memory of the pack with where it came from, the passage around it on asking, and opens its source at its version", async () => {
    const { calls } = await shown([]);
    await search(remembered);
    const resultText = section("Results");
    const before = visibleText();
    await press("The passage around it");
    const opened = visibleText();
    await press("Open version 2");

    expect({
      memories: [
        "What the Brain remembers",
        "I pay invoices on Fridays",
        "pay them on Fridays",
        "Your own word",
        "Only you",
        "Confirmed",
        "By its words",
        "Invoices are paid on Fridays",
        "Upload",
        "Sources disagree",
        "Through what you asked about",
        "Invoices over 10,000 need a second approval",
        "A system's word",
        "An outside party's word",
      ].map((text) => resultText.includes(text)),
      nothingMatched: resultText.includes("Nothing you may read matched."),
      notFound: resultText.includes(
        "Nothing you may read holds refunds and INV-7."
      ),
      passage: {
        before: before.includes("Remember: I pay them on Fridays, always."),
        opened: opened.includes("Remember: I pay them on Fridays, always."),
      },
      source: panel().includes("Invoices are paid on Fridays."),
      calls,
    }).toStrictEqual({
      memories: Array.from({ length: 14 }, () => true),
      nothingMatched: false,
      notFound: true,
      passage: { before: false, opened: true },
      source: true,
      calls: ["list", `search ${remembered}`, "versions u-1", "read u-1@2"],
    });
  });

  it("opens a result at the version it cites, even after another version was picked in its panel", async () => {
    await shown([]);
    await search("invoices");
    await openResult("Handbook");
    const cited = panel();
    await press("Version 2");
    const picked = panel();
    await openResult("Handbook");

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
    const nothing = document.body.textContent;
    await search("invoices refunds");
    const some = document.body.textContent;

    expect({
      nothing: [
        "Nothing you may read matched.",
        `Nothing you may read holds ${unmatched}.`,
      ].map((text) => nothing.includes(text)),
      some: some.includes("Nothing you may read holds refunds and INV-7."),
    }).toStrictEqual({ nothing: [true, false], some: true });
  });

  it("says when there is nothing in the Brain the person may read", async () => {
    await shown([], { empty: true });

    expect(document.body.textContent).toContain(
      "Nothing in the Brain you may read yet"
    );
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

  it("says what the Brain keeps of a person's own connections, marks each it keeps reads from and each that can't tell what changed in it, and leaves the section out when there are none", async () => {
    await shown([
      {
        name: "Gmail",
        status: "connected",
        via: "direct",
        matches: [],
        keepsReads: true,
      },
      {
        name: "Microsoft 365",
        status: "connected",
        via: "direct",
        matches: [],
      },
      {
        name: "HubSpot",
        status: "connected",
        via: "composio",
        matches: [],
        activityGap: true,
      },
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
        "When an agent reads for you through an account you connected yourself, the Brain keeps what it read for you alone, while that account stays connected: one Gmail message or attachment, one OneNote page, or the answer of a read in another app, the company’s records included. Everything else agents search live when you ask, and the Brain keeps nothing of it." +
        "GmailThe Brain may keep, for you alone, some of what an agent reads for you through this connection, while it stays connected." +
        "Microsoft 365Searched live, nothing kept." +
        "HubSpotSearched live, nothing kept." +
        "A gap: this connection can’t tell Grasp what changed in it, so Grasp sees only what is done there through Grasp.",
      none: "",
    });
  });

  it("shows each shared connection the person may read once, with its count and last read, and a record from one with when it was read", async () => {
    await shown([], { kept: true });
    const kept = section("What agents read through shared connections");
    await search("rotterdam");
    // A passage from a source the list hasn't shown is named by what added it.
    await openResult("Read from a shared connection");
    const opened = panel();
    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    await shown([]);

    expect({
      kept: ["HubSpot (sales@acme.test)", "3 records kept", "Last read"].map(
        (text) => kept.includes(text)
      ),
      opened: ["Deal Rotterdam warehouse", "Read from HubSpot on"].map((text) =>
        opened.includes(text)
      ),
      // None the person may read: no section at all.
      none: section("What agents read through shared connections"),
    }).toStrictEqual({
      kept: [true, true, true],
      opened: [true, true],
      none: "",
    });
  });

  it("lists the Brain's own sources among the kept ones, newest first, the older ones once core's pages reach them, and opens one on its own page", async () => {
    const { router } = await shown([], {
      sources: [
        {
          id: "src-finance",
          kind: "interview",
          title: "Finance lead interview",
          date: "2026-11-12",
          who: "Finance lead",
          how: "Live, 45 minutes",
        },
        {
          id: "src-directory",
          kind: "import",
          title: "Directory",
          date: "2026-11-01",
        },
        {
          id: "src-gone",
          kind: "chat",
          title: "Forgotten chat",
          date: "2026-11-11",
          removedAt: "2026-11-13",
        },
      ],
    });
    const firstPage = section("Sources you may read");
    await press("Show more");
    const listedText = section("Sources you may read");
    const order = [
      "Finance lead interview",
      "Handbook",
      "Board minutes",
      "No first line",
      "Directory",
    ].map((title) => listedText.indexOf(title));
    await follow("Finance lead interview");

    expect({
      waited: firstPage.includes("Directory"),
      found: order.every((at) => at >= 0),
      order: order.toSorted((a, b) => a - b),
      gone: listedText.includes("Forgotten chat"),
      origin: listedText.includes(
        "Interview · Finance lead · Live, 45 minutes"
      ),
      at: router.state.location.pathname,
    }).toStrictEqual({
      waited: false,
      found: true,
      order,
      gone: false,
      origin: true,
      at: "/brain/src-finance",
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
    const { calls } = await shown([]);
    await openUpload();
    await pick(
      uploadPicker(),
      new File(["WEBVTT"], "notes.vtt", { type: "text/vtt" })
    );
    const offered = await readerOptions();
    const options = offered.map(({ textContent }) => textContent.trim());
    const team = offered.find(
      ({ textContent }) => textContent.trim() === "Team Finance"
    );
    await act(async () => {
      team?.click();
      await Promise.resolve();
    });
    await settle();
    await uploadPressed();
    await settle();
    const dialogClosed = uploadDialog() === null;
    await press("Handbook");
    await settle();
    const opened = panel();
    await press("Delete");
    await press("Delete for good");
    await settle();

    expect({
      options,
      dialogClosed,
      opened: [
        "Team Finance can read this upload.",
        "Upload new version",
        "Delete",
      ].map((text) => opened.includes(text)),
      closed: panel(),
      calls: calls.filter((call) => !call.startsWith("read")),
    }).toStrictEqual({
      options: ["Only me", "Team Finance", "Everyone"],
      dialogClosed: true,
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
    await openUpload();
    const picker = uploadPicker();
    const chosen = readersChosen();
    await pick(picker, new File(["WEBVTT"], "notes.vtt", { type: "text/vtt" }));
    await uploadPressed();
    const refusedText = uploadText();
    await cancelUpload();
    await press("Handbook");
    await settle();

    expect({
      chosen,
      accepts: picker.accept.split(",").map((type) => type.trim()),
      // The limit, as core's own holds it.
      says: refusedText.includes(
        "PDF, Word, Excel or transcripts, up to 10 MB."
      ),
      uploadSaysWhy: refusedText.includes(refused),
      panelSaysWhy: panel().includes(refused),
    }).toStrictEqual({
      chosen: "Only me",
      accepts: [".pdf", ".docx", ".xlsx", ".vtt"],
      says: true,
      uploadSaysWhy: true,
      panelSaysWhy: true,
    });
  });

  it("says it uploads while it does, says a file's text is too long in the person's words, and retries with the same upload's id", async () => {
    // A refused Upload shows so for a moment, and takes no press meanwhile.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const held = Promise.withResolvers<boolean>();
    const { uploadIds } = await shown([], {
      uploading: held.promise,
      firstUploadRefused: {
        code: "brain.upload_text_too_long",
        message: "Core's own words",
      },
    });
    // The dialog closes once a file is uploaded, and its picker starts
    // afresh when it opens again: each choice finds it anew.
    const choose = async (name: string) => {
      await openUpload();
      await pick(
        uploadPicker(),
        new File(["WEBVTT"], name, { type: "text/vtt" })
      );
    };
    const submit = async () => {
      await uploadPressed();
    };
    await choose("long.vtt");
    await submit();
    const whileHeld =
      uploadDialog()?.querySelector('[aria-busy="true"]') !== null;
    held.resolve(true);
    await settle();
    const refusedText = uploadText();
    act(() => {
      vi.advanceTimersByTime(ms.durationHold);
    });
    await submit();
    await choose("other.vtt");
    await submit();

    expect({
      whileHeld,
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
    await openUpload();
    await pick(
      uploadPicker(),
      new File(["WEBVTT"], "first.vtt", { type: "text/vtt" })
    );
    const before = uploadPicker().disabled;
    await uploadPressed();
    const whileUploading = uploadPicker().disabled;
    // Cancel can't take the form, and the file it holds, away meanwhile.
    await cancelUpload();
    const stillOpen =
      uploadDialog()?.querySelector('[aria-busy="true"]') !== null &&
      uploadDialog() !== null;
    held.resolve(true);
    await settle();
    await openUpload();

    expect({
      before,
      whileUploading,
      stillOpen,
      after: uploadPicker().disabled,
    }).toStrictEqual({
      before: false,
      whileUploading: true,
      stillOpen: true,
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
        input.type === "file" && input.closest("[data-slot=panel]") !== null
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

  it("offers a shared upload's uploader a Delete that removes it for everyone, them included, saying so", async () => {
    const { calls } = await shown([], { handbookDeletes: "remove" });
    await press("Handbook");
    await settle();
    await press("Delete");
    const told = document.body.textContent.includes(
      "Nobody can find or read it from then on, you included, and it can't be brought back. The Brain keeps its history until an admin erases it."
    );
    await answer("Delete");

    expect({
      told,
      calls: calls.filter((call) => call.startsWith("delete")),
      closed: panel(),
    }).toStrictEqual({
      told: true,
      calls: ["deleteUpload u-1"],
      closed: "",
    });
  });

  it("offers a reader who may not delete a shared upload no Delete, and no admin's listing", async () => {
    await shown([], { handbookDeletes: null });
    await press("Handbook");
    await settle();

    expect({
      deleteOffered: [...document.querySelectorAll("button")].some(
        (button) => button.textContent.trim() === "Delete"
      ),
      sharedListed: document.body.textContent.includes("Shared uploads"),
    }).toStrictEqual({ deleteOffered: false, sharedListed: false });
  });

  it("lists shared uploads for an admin, by name only if they may read it, team and uploader, and erases one for good", async () => {
    const { calls } = await shown([], { admin: true });
    const sharedText = section("Shared uploads");
    // Each row's button, by what a screen reader says of it.
    const labels = [...document.querySelectorAll("button")].flatMap(
      (button) => {
        const label = button.getAttribute("aria-label");
        return label !== null && label.startsWith("Erase ") ? [label] : [];
      }
    );
    await press("Erase for good");
    const told =
      document.querySelector('[role="alertdialog"]')?.textContent ?? "";
    await answer("Erase for good");
    await settle();

    expect({
      listed: [
        "Payroll.vtt",
        "Team Payroll",
        "Uploaded by Ada",
        "An upload",
        "A deleted team",
        "Uploaded by Grace",
        "Removed by its uploader",
      ].map((text) => sharedText.includes(text)),
      // The one in use isn't marked removed.
      removedMarks: sharedText.split("Removed by its uploader").length - 1,
      labels,
      // What it erases, and that a workflow's kept state stays unread.
      told: [
        "Every version of it is erased from the Brain",
        "What a workflow kept from it between its runs isn't erased, but it is no longer shown or used.",
      ].map((text) => told.includes(text)),
      after: ["Payroll.vtt", "An upload"].map((text) =>
        section("Shared uploads").includes(text)
      ),
      calls: calls.filter(
        (call) => call.startsWith("sharedUploads") || call.startsWith("delete")
      ),
    }).toStrictEqual({
      listed: [true, true, true, true, true, true, true],
      removedMarks: 1,
      labels: ["Erase Payroll.vtt for good", "Erase this upload for good"],
      told: [true, true],
      after: [false, true],
      calls: ["sharedUploads", "deleteUpload u-3", "sharedUploads"],
    });
  });

  it("refuses a file past the limit, new or as a new version, before reading or sending it", async () => {
    const { calls, uploadIds, versionIds } = await shown([]);
    const tooLarge = uploadMaxBytes + 1;
    await openUpload();
    await pick(uploadPicker(), fileSized("large.vtt", tooLarge));
    await uploadPressed();
    const refusedText = uploadText();
    await cancelUpload();
    await press("Handbook");
    await settle();
    const version = versionFormOf();
    await pick(version.picker, fileSized("large 2.vtt", tooLarge));
    await submitted(version.form);

    expect({
      sent: [uploadIds.length, versionIds.length],
      calls: calls.filter((call) => call.startsWith("upload")),
      said: [refusedText, panel()].map((text) =>
        text.includes("This file is over the upload limit of 10 MB.")
      ),
    }).toStrictEqual({ sent: [0, 0], calls: [], said: [true, true] });
  });

  it("retries a new version with the same version's id, and gives another file a new one", async () => {
    const lost = "The connection was lost.";
    const { versionIds } = await shown([], { firstVersionRefused: lost });
    await press("Handbook");
    await settle();
    const { picker, form } = versionFormOf();
    await pick(picker, new File(["WEBVTT"], "v2.vtt", { type: "text/vtt" }));
    await submitted(form);
    const refusedText = panel();
    await submitted(form);
    // The panel shows the new version, with a form of its own.
    const next = versionFormOf();
    await pick(
      next.picker,
      new File(["WEBVTT"], "v3.vtt", { type: "text/vtt" })
    );
    await submitted(next.form);

    expect({
      refused: refusedText.includes(lost),
      sameOnRetry: versionIds[0] === versionIds[1],
      newForAnotherFile: versionIds[2] !== versionIds[1],
      ids: versionIds.length,
    }).toStrictEqual({
      refused: true,
      sameOnRetry: true,
      newForAnotherFile: true,
      ids: 3,
    });
  });

  it("reads again what is there after a delete answered as not found, done before or no longer theirs, with no refusal shown", async () => {
    const { calls } = await shown([], { admin: true, deleteAnswerLost: true });
    await press("Handbook");
    await settle();
    await press("Delete");
    const before = calls.length;
    await press("Delete for good");
    await settle();
    const afterPanel = calls.slice(before);
    // The first row's: Payroll.vtt.
    await press("Erase for good");
    const beforeErase = calls.length;
    await answer("Erase for good");
    await settle();

    expect({
      refusalShown: document.body.textContent.includes(
        "There's no such upload"
      ),
      // The list and the opened source, read again: still open.
      afterPanel: afterPanel.filter(
        (call) => call === "list" || call === "versions u-1"
      ),
      stillOpen: panel().includes("Handbook"),
      afterErase: calls
        .slice(beforeErase)
        .filter((call) => call !== "list" && !call.startsWith("read")),
    }).toStrictEqual({
      refusalShown: false,
      afterPanel: ["list", "versions u-1"],
      stillOpen: true,
      afterErase: ["deleteUpload u-3", "sharedUploads"],
    });
  });

  it("reads an admin's shared uploads again after an upload", async () => {
    const { calls } = await shown([], { admin: true });
    const before = calls.length;
    await openUpload();
    await pick(
      uploadPicker(),
      new File(["WEBVTT"], "notes.vtt", { type: "text/vtt" })
    );
    await uploadPressed();
    await settle();

    expect(
      calls.slice(before).filter((call) => call.startsWith("sharedUploads"))
    ).toStrictEqual(["sharedUploads"]);
  });

  it("reads an admin's shared uploads again after a new version from the panel", async () => {
    const { calls } = await shown([], { admin: true });
    await press("Handbook");
    await settle();
    const { picker, form } = versionFormOf();
    const before = calls.length;
    await pick(picker, new File(["WEBVTT"], "v2.vtt", { type: "text/vtt" }));
    await submitted(form);
    await settle();

    expect(
      calls.slice(before).filter((call) => call.startsWith("sharedUploads"))
    ).toStrictEqual(["sharedUploads"]);
  });

  it("reads an admin's shared uploads again after a delete from the panel", async () => {
    const { calls } = await shown([], { admin: true });
    await press("Handbook");
    await settle();
    await press("Delete");
    const before = calls.length;
    await press("Delete for good");
    await settle();

    expect(
      calls.slice(before).filter((call) => call.startsWith("sharedUploads"))
    ).toStrictEqual(["sharedUploads"]);
  });

  it("shows what the Brain learned from the version shown: what it added, replaced, what is no longer in it, and what contradicts it", async () => {
    await shown([], { learned: { "u-1@2": handbookLearned } });
    await press("Handbook");
    const learned = learnedSection() ?? "";

    expect(
      [
        "This version added 1 memory.",
        "Invoices are paid on Fridays",
        "Paying invoices",
        "New",
        "This version replaced 1 memory from an earlier version.",
        "Invoices are paid monthly",
        "Invoice",
        "1 memory from an earlier version is no longer in this source.",
        "Invoices are checked by hand",
        "1 memory this version added is contradicted elsewhere.",
        "Contradicted by: Invoices are paid on Mondays",
        "More memories contradict it.",
      ].filter((text) => !learned.includes(text))
    ).toStrictEqual([]);
  });

  it.each([
    ["a memory of the version is about", "Invoice", "entity=e-2&kind=term"],
    [
      "a memory of the version relates to",
      "Ada Lovelace",
      "entity=e-3&kind=person",
    ],
    [
      "another source's disagreeing memory relates to",
      "Grace Hopper",
      "entity=e-4&kind=person",
    ],
  ])("opens on the Memories page the entity %s", async (_how, name, opens) => {
    await shown([], { learned: { "u-1@2": handbookLearned } });
    await press("Handbook");
    const link = [...document.querySelectorAll("a")].find(
      (each) => each.textContent === name
    );
    await act(async () => {
      link?.click();
      await Promise.resolve();
    });
    await settle();

    expect(document.body.textContent).toContain(
      `Memories page ?store=shared&${opens}`
    );
  });

  it("says when the Brain learned nothing from a version, shows nothing for one core answers none of, and says why core refused", async () => {
    await shown([], {
      learned: {
        "u-1@2": { memories: [], entities: [], next: null },
        "c-1@1": "The Brain is busy.",
      },
    });
    await press("Handbook");
    const nothing = learnedSection();
    await press("Version 1");
    const none = learnedSection();
    await press("Board minutes");
    const refused = learnedSection();

    expect({ nothing, none, refused }).toStrictEqual({
      nothing:
        "What the Brain learned from this versionThe Brain hasn't learned anything from this version.",
      none: undefined,
      refused: "What the Brain learned from this versionThe Brain is busy.",
    });
  });

  // Erased, or the reader taken off it, since the first page: core answers
  // none alike, and the page says the one thing that is true of both.
  it.each(["erased", "no longer the reader's to read"])(
    "says once, in place of what it showed, that what the Brain learned is no longer theirs to read when a later page answers none (%s)",
    async () => {
      const [added] = handbookLearned.memories;
      await shown([], {
        learned: {
          "u-1@2": {
            ...handbookLearned,
            memories: added === undefined ? [] : [added],
            next: { at: "2026-11-10T09:00:00.000Z", memory: "m-a" },
          },
          "u-1@2#m-a": null,
        },
      });
      await press("Handbook");
      const pressMore = async () => {
        const more = [
          ...document.querySelectorAll<HTMLButtonElement>("section button"),
        ].find(
          (each) =>
            each.textContent === "Show more" &&
            each.closest("[data-slot=panel]") !== null
        );
        await act(async () => {
          more?.click();
          await Promise.resolve();
        });
        await settle();
        return more !== undefined;
      };
      const offered = await pressMore();

      expect({
        offered,
        section: learnedSection(),
        offeredAgain: await pressMore(),
      }).toStrictEqual({
        offered: true,
        section:
          "What the Brain learned from this versionYou can no longer read what the Brain learned from this version.",
        offeredAgain: false,
      });
    }
  );

  it("reads what the Brain learned a page at a time, its counts said to be so far while more follow", async () => {
    const [added] = handbookLearned.memories;
    await shown([], {
      learned: {
        "u-1@2": {
          ...handbookLearned,
          memories: added === undefined ? [] : [added],
          next: { at: "2026-11-10T09:00:00.000Z", memory: "m-a" },
        },
        "u-1@2#m-a": {
          ...handbookLearned,
          memories: [
            {
              part: "added",
              memory: memoryShown("m-c", "Receipts go to Finance", "e-2"),
              rivals: [],
              moreRivals: false,
            },
          ],
        },
      },
    });
    await press("Handbook");
    const first = learnedSection() ?? "";
    const more = [
      ...document.querySelectorAll<HTMLButtonElement>("section button"),
    ].find(
      (each) =>
        each.textContent === "Show more" &&
        each.closest("[data-slot=panel]") !== null
    );
    await act(async () => {
      more?.click();
      await Promise.resolve();
    });
    await settle();
    const both = learnedSection() ?? "";

    expect({
      first: first.includes("So far, this version added 1 memory."),
      both: [
        "This version added 2 memories.",
        "Invoices are paid on Fridays",
        "Receipts go to Finance",
      ].every((text) => both.includes(text)),
      more: both.includes("Show more"),
    }).toStrictEqual({ first: true, both: true, more: false });
  });
});
