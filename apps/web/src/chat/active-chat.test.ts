// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  activeChat,
  forgetActiveChats,
  forgetChat,
  setActiveChat,
} from "./active-chat.ts";
import { slotOf } from "./chat-subject.ts";

// The tab's open chats, as a deleted chat leaves them: it is open in none
// of them, an App's slot included, so the App's workspace asks core for
// its chat again; every other open chat stays.

describe(forgetChat, () => {
  afterEach(() => {
    forgetActiveChats();
  });

  it("closes a deleted chat wherever the tab holds it open, and no other", () => {
    setActiveChat("chat-deleted");
    setActiveChat("chat-deleted", slotOf({ kind: "app", id: "invoices" }));
    setActiveChat("chat-kept", slotOf({ kind: "app", id: "holidays" }));

    forgetChat("chat-deleted");

    expect({
      chat: activeChat(),
      invoices: activeChat(slotOf({ kind: "app", id: "invoices" })),
      holidays: activeChat(slotOf({ kind: "app", id: "holidays" })),
      stored: sessionStorage.getItem("grasp.chat.slot.app:invoices"),
    }).toStrictEqual({
      chat: undefined,
      invoices: undefined,
      holidays: "chat-kept",
      stored: null,
    });
  });
});
