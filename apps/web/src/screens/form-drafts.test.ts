import { screenLimits } from "@grasp-os/shared/screens";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  appDrafts,
  clearDrafts,
  draftGatherMs,
  draftsFor,
  saveDraft,
  sweepDrafts,
} from "./form-drafts.ts";

// The page's keep of unsaved drafts against what a frame, or the next
// person at the same device, could try: read another person's or App's
// drafts, fill the tab's storage, or find drafts after access ended.

/** The tab's session storage, as a browser keeps it, refusing past `room` characters. */
class TabStorage implements Storage {
  readonly #items = new Map<string, string>();
  readonly #room: number;

  constructor(room = Number.POSITIVE_INFINITY) {
    this.#room = room;
  }

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    const others = [...this.#items]
      .filter(([name]) => name !== key)
      .reduce((total, [, text]) => total + text.length, 0);
    if (others + value.length > this.#room) {
      throw new DOMException("Full.", "QuotaExceededError");
    }
    this.#items.set(key, value);
  }
}

/** A fresh tab's storage for each test, as the page sees it. */
const freshTab = (): (() => TabStorage) => {
  let tab = new TabStorage();
  beforeEach(() => {
    tab = new TabStorage();
    vi.stubGlobal("sessionStorage", tab);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  return () => tab;
};

describe("a person's drafts of an App", () => {
  const tab = freshTab();

  it("reach only that person, and only that App's frame", () => {
    saveDraft("ada", "notes", "n1", "Ada's draft");
    saveDraft("ada", "invoices", "i1", "Ada's invoice");
    expect(draftsFor("ada", "notes")).toStrictEqual({ n1: "Ada's draft" });

    // The next person at the device finds none, and Ada's are gone.
    expect(draftsFor("bob", "notes")).toStrictEqual({});
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });

  it("go when access ends: an App's when it is refused, all at signing out", () => {
    saveDraft("ada", "notes", "n1", "draft");
    saveDraft("ada", "invoices", "i1", "draft");
    clearDrafts("notes");
    expect(draftsFor("ada", "notes")).toStrictEqual({});
    expect(draftsFor("ada", "invoices")).toStrictEqual({ i1: "draft" });
    clearDrafts();
    expect(tab).toHaveLength(0);
  });

  it("drops a draft dropped by the frame, and a day-old one unread", () => {
    const now = Date.now();
    saveDraft(
      "ada",
      "notes",
      "old",
      "draft",
      now - screenLimits.drafts.maxAgeMs - 1
    );
    saveDraft("ada", "notes", "gone", "draft", now);
    saveDraft("ada", "notes", "gone", null, now);
    expect(draftsFor("ada", "notes", now)).toStrictEqual({});
  });
});

describe("what a frame sends to keep", () => {
  freshTab();

  it("is never kept past the limits of a draft, its name or its kind", () => {
    saveDraft(
      "ada",
      "notes",
      "big",
      "x".repeat(screenLimits.drafts.characters + 1)
    );
    saveDraft(
      "ada",
      "notes",
      "n".repeat(screenLimits.drafts.keyCharacters + 1),
      "x"
    );
    saveDraft("ada", "notes", "object", { text: "x" });
    saveDraft("ada", "notes", 7, "x");
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });

  it("lets the oldest drafts go past an App's count", () => {
    for (let index = 0; index <= screenLimits.drafts.perApp; index += 1) {
      saveDraft("ada", "notes", `d${index}`, "draft", index + 1);
    }
    const kept = draftsFor("ada", "notes", screenLimits.drafts.perApp + 1);
    expect(Object.keys(kept)).toHaveLength(screenLimits.drafts.perApp);
    expect(kept).not.toHaveProperty("d0");
  });

  it("lets the oldest go when the tab's drafts together, or the browser, have no room", () => {
    const half = "x".repeat(screenLimits.drafts.characters);
    const fits = Math.floor(screenLimits.drafts.total / half.length);
    for (let index = 0; index <= fits; index += 1) {
      saveDraft("ada", "notes", `d${index}`, half, index + 1);
    }
    const kept = Object.keys(draftsFor("ada", "notes", fits + 1));
    expect(kept.length).toBeLessThan(fits + 1);
    expect(kept).toContain(`d${fits}`);
    expect(kept).not.toContain("d0");

    vi.stubGlobal("sessionStorage", new TabStorage(100));
    saveDraft("ada", "notes", "a", "x".repeat(40), 1);
    saveDraft("ada", "notes", "b", "x".repeat(40), 2);
    expect(Object.keys(draftsFor("ada", "notes", 2))).toStrictEqual(["b"]);
  });
});

/** Every draft key in `tab`, as storage holds them. */
const keysIn = (tab: Storage): string[] =>
  Array.from({ length: tab.length }, (_value, index) => tab.key(index) ?? "");

describe("the drafts in a tab the browser restored", () => {
  const tab = freshTab();

  it("are left as they are by a lookup that finds nothing to delete", () => {
    saveDraft("ada", "notes", "n1", "draft");
    saveDraft("ada", "tasks", "t1", "draft");
    const store = tab();
    let writes = 0;
    const setItem = store.setItem.bind(store);
    store.setItem = (key, value) => {
      writes += 1;
      setItem(key, value);
    };
    for (let count = 0; count < 10; count += 1) {
      draftsFor("ada", "notes");
    }
    expect({ writes, kept: draftsFor("ada", "tasks") }).toStrictEqual({
      writes: 0,
      kept: { t1: "draft" },
    });
  });

  it("are swept once core says who is signed in: anyone else's and expired ones deleted", () => {
    const now = Date.now();
    saveDraft("ada", "notes", "young", "draft", now);
    saveDraft(
      "ada",
      "notes",
      "old",
      "draft",
      now - screenLimits.drafts.maxAgeMs - 1
    );
    saveDraft("bob", "notes", "b1", "Bob's draft", now);
    sweepDrafts("ada", now);
    expect(keysIn(tab())).toHaveLength(1);
    expect(tab().getItem(keysIn(tab())[0] ?? "")).not.toContain("old");
  });

  it("are all deleted when core says nobody is signed in", () => {
    saveDraft("ada", "notes", "n1", "draft");
    saveDraft("bob", "invoices", "i1", "draft");
    sweepDrafts();
    expect(tab()).toHaveLength(0);
  });
});

describe("drafts named by ids holding a colon", () => {
  freshTab();

  it("never reach the person or App whose ids run together the same way", () => {
    saveDraft("a:b", "x", "n1", "draft");
    expect(draftsFor("a", "b:x")).toStrictEqual({});
  });
});

describe("one App's drafts beside another's", () => {
  freshTab();

  it("can't be emptied by another App filling the tab", () => {
    const large = "x".repeat(screenLimits.drafts.characters - 64);
    saveDraft("ada", "notes", "kept", "Mine", 1);
    for (let index = 0; index < 12; index += 1) {
      saveDraft("ada", "flood", `f${index}`, large, 2 + index);
    }
    saveDraft("ada", "notes", "new", "x".repeat(150_000), 20);
    expect(Object.keys(draftsFor("ada", "notes", 20)).toSorted()).toStrictEqual(
      ["kept", "new"]
    );
  });

  it("past the tab's total, lose only the oldest draft in the tab", () => {
    const large = "x".repeat(screenLimits.drafts.characters - 64);
    saveDraft("ada", "app0", "older", large, 1);
    saveDraft("ada", "app0", "newer", large, 2);
    // One draft per App more, until the tab's total is passed once.
    let apps = 1;
    while (
      apps < 100 &&
      Object.keys(draftsFor("ada", "app0", 100)).length === 2
    ) {
      saveDraft("ada", `app${apps}`, "draft", large, 2 + apps);
      apps += 1;
    }
    const others = Array.from({ length: apps - 1 }, (_value, index) =>
      Object.keys(draftsFor("ada", `app${index + 1}`, 100))
    );
    expect(Object.keys(draftsFor("ada", "app0", 100))).toStrictEqual(["newer"]);
    expect(others.every((names) => names.length === 1)).toBeTruthy();
  });
});

/** Lets what the page gathered be written. */
const gathered = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(draftGatherMs);
};

const ada = async (): Promise<string> => await Promise.resolve("ada");

describe("drafts when the tab's storage refuses a write", () => {
  const tab = freshTab();

  it("never cost another App's drafts when the browser's storage is full of something else", () => {
    const now = Date.now();
    saveDraft("ada", "invoices", "i1", "Ada's invoice", now - 1000);
    const store = tab();
    store.setItem = () => {
      throw new DOMException("Full.", "QuotaExceededError");
    };
    saveDraft("ada", "notes", "n1", "draft", now);
    expect(sessionStorage).toHaveLength(1);
  });

  it("let expired drafts go before a live one, past the tab's total", () => {
    const now = Date.now();
    const old = now - screenLimits.drafts.maxAgeMs - 1;
    for (let app = 0; app < 15; app += 1) {
      saveDraft("ada", `old${app}`, "d", "x".repeat(150_000), old);
    }
    saveDraft("ada", "notes", "n1", "y".repeat(180_000), now);
    expect(Object.keys(draftsFor("ada", "notes", now))).toStrictEqual(["n1"]);
  });

  it("never cost another App's drafts when it isn't for want of room", () => {
    const now = Date.now();
    saveDraft("ada", "invoices", "i1", "Ada's invoice", now - 1000);
    const store = tab();
    store.setItem = () => {
      throw new DOMException("Blocked.", "SecurityError");
    };
    saveDraft("ada", "notes", "n1", "draft", now);
    expect(sessionStorage).toHaveLength(1);
  });
});

describe("a running screen's drafts", () => {
  const tab = freshTab();
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("go, and no more are kept or handed over, once core refuses the person or the App", async () => {
    const drafts = appDrafts("notes", ada);
    drafts.save("n1", "draft");
    await gathered();
    drafts.refused(Object.assign(new Error("No."), { code: "role.forbidden" }));
    drafts.save("n2", "draft");
    await gathered();
    await expect(drafts.drafts()).resolves.toStrictEqual({});
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });

  it("stay when core refuses something else", async () => {
    const drafts = appDrafts("notes", ada);
    drafts.save("n1", "draft");
    await gathered();
    drafts.refused(Object.assign(new Error("No."), { code: "data.conflict" }));
    await expect(drafts.drafts()).resolves.toStrictEqual({ n1: "draft" });
  });

  it("ask who is signed in again after core failed to say", async () => {
    let asked = 0;
    const drafts = appDrafts("notes", async () => {
      asked += 1;
      if (asked === 1) {
        throw new Error("Core is out of reach.");
      }
      return await Promise.resolve("ada");
    });
    drafts.save("n1", "lost");
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({});
    drafts.save("n1", "draft");
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({ n1: "draft" });
  });

  it("keep nothing when core refuses the person while a save waits to know who is signed in", async () => {
    const person = Promise.withResolvers<string>();
    const drafts = appDrafts("notes", async () => await person.promise);
    drafts.save("n1", "draft");
    // The gathering ended, and the write waits for who is signed in.
    await gathered();
    drafts.refused(Object.assign(new Error("No."), { code: "role.forbidden" }));
    person.resolve("ada");
    await gathered();
    expect(sessionStorage).toHaveLength(0);
  });

  it("touch nothing for a screen that stopped while its drafts waited to know who is signed in", async () => {
    saveDraft("bob", "notes", "n1", "Bob's draft");
    const person = Promise.withResolvers<string>();
    const drafts = appDrafts("notes", async () => await person.promise);
    const handing = drafts.drafts();
    drafts.stop();
    // Ada's screen asked; Bob is signed in now, his drafts in the tab.
    person.resolve("ada");
    await expect(handing).resolves.toStrictEqual({});
    expect(draftsFor("bob", "notes")).toStrictEqual({ n1: "Bob's draft" });
  });

  it("keep nothing for a screen that stopped while a save waited to know who is signed in", async () => {
    const person = Promise.withResolvers<string>();
    const drafts = appDrafts("notes", async () => await person.promise);
    drafts.save("n1", "draft");
    await gathered();
    drafts.stop();
    person.resolve("ada");
    await gathered();
    drafts.save("n2", "draft");
    await gathered();
    expect(sessionStorage).toHaveLength(0);
  });

  it("are written once per gathering however fast the frame sends, the newest of each", async () => {
    const writes: string[] = [];
    const store = tab();
    const setItem = store.setItem.bind(store);
    store.setItem = (key, value) => {
      writes.push(key);
      setItem(key, value);
    };
    const drafts = appDrafts("notes", ada);
    for (let count = 0; count < 100; count += 1) {
      drafts.save("n1", `draft ${count}`);
      drafts.save("n2", `other ${count}`);
    }
    expect(draftsFor("ada", "notes")).toStrictEqual({});
    await gathered();
    // One write of the App's drafts, the newest of each.
    const written = writes.length;
    expect({ kept: draftsFor("ada", "notes"), written }).toStrictEqual({
      kept: { n1: "draft 99", n2: "other 99" },
      written: 1,
    });
  });

  it("never let a drop go, however many drafts wait to be kept", async () => {
    for (let index = 0; index < screenLimits.drafts.perApp; index += 1) {
      saveDraft("ada", "notes", `n${index}`, "kept");
    }
    const drafts = appDrafts("notes", ada);
    for (let index = 0; index < screenLimits.drafts.perApp; index += 1) {
      drafts.save(`n${index}`, null);
    }
    drafts.save("new", "typed");
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({ new: "typed" });
  });

  it("are never cleared by a screen closed for access, whatever it asks", async () => {
    const drafts = appDrafts("notes", ada);
    drafts.close();
    saveDraft("ada", "notes", "n1", "another screen's");
    drafts.clear();
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({ n1: "another screen's" });
  });

  it("go from every screen of the App when one hears core refuse the person", async () => {
    const first = appDrafts("notes", ada);
    const second = appDrafts("notes", ada);
    await second.drafts();
    second.save("n2", "queued in the other screen");
    first.refused(Object.assign(new Error("No."), { code: "role.forbidden" }));
    second.flush();
    await gathered();
    expect(sessionStorage).toHaveLength(0);
  });

  it("hand over the newest drafts that fit one message, never more", () => {
    const text = "x".repeat(100_000);
    for (let index = 0; index < 4; index += 1) {
      saveDraft("ada", "notes", `n${index}`, text, Date.now() + index);
    }
    const handed = draftsFor("ada", "notes");
    expect({
      names: Object.keys(handed).toSorted(),
      fits: JSON.stringify(handed).length <= screenLimits.rpc.maxMessageSize,
    }).toStrictEqual({ names: ["n2", "n3"], fits: true });
  });

  it("drop a kept draft whose waiting change a burst crowded out, never keeping its older version", async () => {
    saveDraft("ada", "notes", "a", "kept before");
    const drafts = appDrafts("notes", ada);
    drafts.save("a", "changed");
    for (let index = 0; index < screenLimits.drafts.perApp; index += 1) {
      drafts.save(`n${index}`, "burst");
    }
    for (let index = 0; index < screenLimits.drafts.perApp; index += 1) {
      drafts.save(`n${index}`, null);
    }
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });

  it("drop a draft another screen kept after this one first looked, in the same gathering", async () => {
    const drafts = appDrafts("notes", ada);
    drafts.save("n1", null);
    // Another screen of the App keeps a draft of the same note meanwhile.
    saveDraft("ada", "notes", "n1", "another screen's");
    drafts.save("n1", null);
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });

  it("are cleared after a save that started before the clear, never before it", async () => {
    const person = Promise.withResolvers<string>();
    const drafts = appDrafts("notes", async () => await person.promise);
    drafts.save("n1", "draft");
    drafts.clear();
    person.resolve("ada");
    await gathered();
    expect(draftsFor("ada", "notes")).toStrictEqual({});
  });
});

describe("drafts once the person's session ended", () => {
  freshTab();

  it("are all deleted, and none is kept after, by a frame's timer or a keystroke", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    page.stopDrafts();
    page.saveDraft("ada", "notes", "n2", "typed after");
    expect(sessionStorage).toHaveLength(0);
  });

  it("never stop a sign-out or a sweep when the tab's storage refuses", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    page.saveDraft("bob", "notes", "n1", "draft");
    const refusing = new TabStorage();
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index) ?? "";
      refusing.setItem(key, sessionStorage.getItem(key) ?? "");
    }
    refusing.removeItem = () => {
      throw new DOMException("Blocked.", "SecurityError");
    };
    refusing.setItem = () => {
      throw new DOMException("Blocked.", "SecurityError");
    };
    vi.stubGlobal("sessionStorage", refusing);
    let signedOut = false;
    await page.stopDraftsFor(async () => {
      signedOut = true;
      await Promise.resolve();
    });
    page.sweepDrafts("ada");
    expect({ signedOut, left: refusing.length }).toStrictEqual({
      signedOut: true,
      left: 2,
    });
  });

  it("stay gone after a sign-out that failed once the session ended meanwhile", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    const signingOut = Promise.withResolvers<null>();
    const result = page.stopDraftsFor(async () => {
      await signingOut.promise;
    });
    // The session is revoked while the sign-out is on its way.
    page.stopDrafts();
    signingOut.reject(new TypeError("Failed to fetch"));
    await expect(result).rejects.toThrow("Failed to fetch");
    page.saveDraft("ada", "notes", "n2", "typed after");
    expect(sessionStorage).toHaveLength(0);
  });

  it("are untouched by a sign-out that never reached core, and kept again after", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    await expect(
      page.stopDraftsFor(async () => {
        // Nothing is written while it is on its way.
        page.saveDraft("ada", "notes", "n2", "typed meanwhile");
        await Promise.reject(new TypeError("Failed to fetch"));
      })
    ).rejects.toThrow("Failed to fetch");
    page.saveDraft("ada", "notes", "n3", "typed before core said");
    // Core says Ada is still signed in.
    page.sweepDrafts("ada");
    page.saveDraft("ada", "notes", "n3", "typed after");
    expect(page.draftsFor("ada", "notes")).toStrictEqual({
      n1: "draft",
      n3: "typed after",
    });
  });

  it("keep a running screen's clear back while a sign-out is on its way", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      page.saveDraft("ada", "notes", "n1", "kept");
      const drafts = page.appDrafts(
        "notes",
        async () => await Promise.resolve("ada")
      );
      const signingOut = Promise.withResolvers<null>();
      const result = page.stopDraftsFor(async () => {
        await signingOut.promise;
      });
      drafts.clear();
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      const during = sessionStorage.length;
      signingOut.reject(new TypeError("Failed to fetch"));
      await expect(result).rejects.toThrow("Failed to fetch");
      // Core says Ada is still signed in.
      page.sweepDrafts("ada");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      expect({ during, after: page.draftsFor("ada", "notes") }).toStrictEqual({
        during: 1,
        after: {},
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stay held back while any sign-out is on its way, and for good once the session ended", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    const first = Promise.withResolvers<null>();
    const second = Promise.withResolvers<null>();
    const firstDone = page.stopDraftsFor(async () => {
      await first.promise;
    });
    const secondDone = page.stopDraftsFor(async () => {
      await second.promise;
    });
    first.reject(new TypeError("Failed to fetch"));
    await expect(firstDone).rejects.toThrow("Failed to fetch");
    page.saveDraft("ada", "notes", "n1", "while the second is on its way");
    second.reject(new TypeError("Failed to fetch"));
    await expect(secondDone).rejects.toThrow("Failed to fetch");
    page.sweepDrafts("ada");
    page.saveDraft("ada", "notes", "n2", "after both failed");
    const kept = page.draftsFor("ada", "notes");

    page.stopDrafts();
    await expect(
      page.stopDraftsFor(async () => {
        await Promise.reject(new TypeError("Failed to fetch"));
      })
    ).rejects.toThrow("Failed to fetch");
    page.saveDraft("ada", "notes", "n3", "after the session ended");
    expect({ kept, after: sessionStorage.length }).toStrictEqual({
      kept: { n2: "after both failed" },
      after: 0,
    });
  });

  it("write a stopped screen's changes a sign-out held back, once it failed", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      const drafts = page.appDrafts(
        "notes",
        async () => await Promise.resolve("ada")
      );
      await drafts.drafts();
      const signingOut = Promise.withResolvers<null>();
      const result = page.stopDraftsFor(async () => {
        await signingOut.promise;
      });
      drafts.save("n1", "typed before the screen closed");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      drafts.stop();
      signingOut.reject(new TypeError("Failed to fetch"));
      await expect(result).rejects.toThrow("Failed to fetch");
      page.sweepDrafts("ada");
      expect(page.draftsFor("ada", "notes")).toStrictEqual({
        n1: "typed before the screen closed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("write nothing for a screen whose person core no longer has signed in, after a sign-out that failed", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      const person = Promise.withResolvers<string>();
      const drafts = page.appDrafts("notes", async () => await person.promise);
      await expect(
        page.stopDraftsFor(async () => {
          await Promise.reject(new TypeError("Failed to fetch"));
        })
      ).rejects.toThrow("Failed to fetch");
      // Core says Bob is signed in; the screen's own ask answers Ada late.
      page.sweepDrafts("bob");
      drafts.save("n1", "typed");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      person.resolve("ada");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      expect(sessionStorage).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keep held back after a sign-out that failed until core says who is signed in, and go if nobody", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    await expect(
      page.stopDraftsFor(async () => {
        await Promise.reject(new TypeError("Failed to fetch"));
      })
    ).rejects.toThrow("Failed to fetch");
    page.saveDraft("ada", "notes", "n2", "before core said");
    const held = sessionStorage.length;
    // Core says nobody is: the sign-out went through after all.
    page.sweepDrafts();
    page.saveDraft("ada", "notes", "n3", "after");
    expect({ held, after: sessionStorage.length }).toStrictEqual({
      held: 1,
      after: 0,
    });
  });

  it("keep none of a stopped screen's held-back changes once core refused its App meanwhile", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      const drafts = page.appDrafts(
        "notes",
        async () => await Promise.resolve("ada")
      );
      await drafts.drafts();
      const signingOut = Promise.withResolvers<null>();
      const result = page.stopDraftsFor(async () => {
        await signingOut.promise;
      });
      drafts.save("n1", "typed as I signed out");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      drafts.stop();
      page.shutAppDrafts("notes");
      signingOut.reject(new TypeError("Failed to fetch"));
      await expect(result).rejects.toThrow("Failed to fetch");
      page.sweepDrafts("ada");
      expect(page.draftsFor("ada", "notes")).toStrictEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("write none of the person before's held-back changes once core says someone else is signed in", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      const drafts = page.appDrafts(
        "notes",
        async () => await Promise.resolve("ada")
      );
      await drafts.drafts();
      const signingOut = Promise.withResolvers<null>();
      const result = page.stopDraftsFor(async () => {
        await signingOut.promise;
      });
      drafts.save("n1", "Ada typed as she signed out");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      signingOut.reject(new TypeError("Failed to fetch"));
      await expect(result).rejects.toThrow("Failed to fetch");
      page.sweepDrafts("bob");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      drafts.flush();
      expect(sessionStorage).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("all go once a sign-out reached core", async () => {
    vi.resetModules();
    const page = await import("./form-drafts.ts");
    page.saveDraft("ada", "notes", "n1", "draft");
    await page.stopDraftsFor(async () => {
      await Promise.resolve();
    });
    page.saveDraft("ada", "notes", "n2", "typed after");
    expect(sessionStorage).toHaveLength(0);
  });

  it("keep a running screen's changes gathered while a sign-out failed", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const page = await import("./form-drafts.ts");
      const drafts = page.appDrafts(
        "notes",
        async () => await Promise.resolve("ada")
      );
      await drafts.drafts();
      const signingOut = Promise.withResolvers<null>();
      const result = page.stopDraftsFor(async () => {
        await signingOut.promise;
      });
      drafts.save("n1", "typed as I signed out");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      signingOut.reject(new TypeError("Failed to fetch"));
      await expect(result).rejects.toThrow("Failed to fetch");
      // Core says Ada is still signed in.
      page.sweepDrafts("ada");
      await vi.advanceTimersByTimeAsync(page.draftGatherMs);
      expect(page.draftsFor("ada", "notes")).toStrictEqual({
        n1: "typed as I signed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
