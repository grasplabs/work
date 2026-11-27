// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  draftFor,
  emptyDraft,
  forgetDrafts,
  keepDraft,
  moveNewDraft,
} from "./drafts.ts";

// What the person typed and didn't send, kept per chat in this browser.
// These start from the ways it could go wrong: one chat's words showing in
// another's box, or in another person's; a draft lost on a reload; a
// draft a question took staying behind; one kept after signing out; and
// a kept draft that isn't one (another release's, or edited by hand)
// breaking the box.

const mentioned = {
  kind: "agent",
  id: "agent-1",
  label: "Claire",
  trigger: "@",
};

describe("a chat's draft", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("is each chat's own, and each person's own", () => {
    keepDraft("ada", "chat-1", "chat", {
      text: "Who owes us?",
      mentions: [mentioned],
    });
    keepDraft("ada", undefined, "chat", { text: "A new one", mentions: [] });

    expect({
      same: draftFor("ada", "chat-1", "chat"),
      otherChat: draftFor("ada", "chat-2", "chat"),
      newChat: draftFor("ada", undefined, "chat"),
      appsNewChat: draftFor("ada", undefined, "app:invoices"),
      otherPerson: draftFor("grace", "chat-1", "chat"),
    }).toStrictEqual({
      same: { text: "Who owes us?", mentions: [mentioned] },
      otherChat: emptyDraft,
      newChat: { text: "A new one", mentions: [] },
      appsNewChat: emptyDraft,
      otherPerson: emptyDraft,
    });
  });

  it("is read from what the browser kept, as after a reload", () => {
    localStorage.setItem(
      "grasp.chat.draft.ada.chat-1",
      JSON.stringify({ text: "Typed before the reload", mentions: [] })
    );

    expect(draftFor("ada", "chat-1", "chat").text).toBe(
      "Typed before the reload"
    );
  });

  it("keeps nothing once emptied, and reads a kept draft that isn't one as none", () => {
    keepDraft("ada", "chat-1", "chat", { text: "Who", mentions: [] });
    keepDraft("ada", "chat-1", "chat", { text: "  ", mentions: [] });
    localStorage.setItem("grasp.chat.draft.ada.chat-2", "{not json");
    localStorage.setItem(
      "grasp.chat.draft.ada.chat-3",
      JSON.stringify({ text: "Kept", mentions: [{ id: 1 }, mentioned] })
    );

    expect({
      emptied: localStorage.getItem("grasp.chat.draft.ada.chat-1"),
      broken: draftFor("ada", "chat-2", "chat"),
      halfBroken: draftFor("ada", "chat-3", "chat"),
    }).toStrictEqual({
      emptied: null,
      broken: emptyDraft,
      halfBroken: { text: "Kept", mentions: [mentioned] },
    });
  });

  it("lasts while the page does where storage is full, rather than undo what is typed", () => {
    keepDraft("ada", "chat-1", "chat", { text: "Who", mentions: [] });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });

    keepDraft("ada", "chat-1", "chat", { text: "Who owes us?", mentions: [] });

    expect(draftFor("ada", "chat-1", "chat").text).toBe("Who owes us?");
  });

  it("goes with the chat a question made: what was typed meanwhile is that chat's", () => {
    keepDraft("ada", undefined, "chat", {
      text: "Typed while it went",
      mentions: [],
    });

    moveNewDraft("ada", "chat", "chat-9");

    expect({
      made: draftFor("ada", "chat-9", "chat").text,
      next: draftFor("ada", undefined, "chat"),
    }).toStrictEqual({ made: "Typed while it went", next: emptyDraft });
  });

  it("is forgotten, every person's and chat's, once the person signs out", () => {
    keepDraft("ada", "chat-1", "chat", { text: "Who owes us?", mentions: [] });
    localStorage.setItem("grasp.chat.choice.ada", "{}");

    forgetDrafts();

    expect({
      draft: draftFor("ada", "chat-1", "chat"),
      kept: Object.keys(localStorage),
    }).toStrictEqual({ draft: emptyDraft, kept: ["grasp.chat.choice.ada"] });
  });
});
