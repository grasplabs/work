// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  activeChat,
  appSlot,
  forgetActiveChats,
  forgetChat,
  setActiveChat,
} from "./active-chat.ts";

// The tab's open chats, as a deleted chat leaves them: it is open in none
// of them, an App's slot included, so the App's workspace asks core for
// its chat again; every other open chat stays.

describe(forgetChat, () => {
  afterEach(() => {
    forgetActiveChats();
  });

  it("closes a deleted chat wherever the tab holds it open, and no other", () => {
    setActiveChat("chat-deleted");
    setActiveChat("chat-deleted", appSlot("invoices"));
    setActiveChat("chat-kept", appSlot("holidays"));
    setActiveChat("chat-brain", "brain");

    forgetChat("chat-deleted");

    expect({
      chat: activeChat(),
      invoices: activeChat(appSlot("invoices")),
      holidays: activeChat(appSlot("holidays")),
      brain: activeChat("brain"),
      stored: sessionStorage.getItem("grasp.chat.app:invoices"),
    }).toStrictEqual({
      chat: undefined,
      invoices: undefined,
      holidays: "chat-kept",
      brain: "chat-brain",
      stored: null,
    });
  });
});
