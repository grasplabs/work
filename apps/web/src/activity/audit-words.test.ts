import { describe, expect, it } from "vite-plus/test";

import { actionWords } from "./audit-words.ts";

/** What `action` reads as, in English. */
const said = (action: string): string | undefined =>
  actionWords(action)?.message;

describe("an audit entry's words", () => {
  it("say what a visitor did, never that an App changed", () => {
    const visitorActions = [
      "app.visitor_signed_in",
      "app.visitor_signed_out",
      "app.visitor_code_sent",
      "app.visitor_refused",
      "app.visitor_listed",
      "app.visitor_unlisted",
      "app.visitor_granted",
      "app.visitor_ungranted",
      "app.visitor_called",
    ];
    expect({
      signedIn: said("app.visitor_signed_in"),
      allOwn: visitorActions.filter(
        (action) => said(action) === said("app") || said(action) === undefined
      ),
    }).toStrictEqual({
      signedIn: "Signed in to an App as a visitor",
      allOwn: [],
    });
  });

  it("say code read the Brain's skills, and nothing of a release installing them", () => {
    expect({
      select: said("brain.skills.select"),
      read: said("brain.skills.read"),
      installed: said("brain.skills.installed"),
    }).toStrictEqual({
      select: "Read skills from the Brain",
      read: "Read skills from the Brain",
      installed: undefined,
    });
  });

  it("say code read entities and wrote, forgot or corrected a memory, each by its own name", () => {
    expect({
      get: said("brain.entities.get"),
      find: said("brain.entities.find"),
      remembered: said("brain.memory.remembered"),
      forgotten: said("brain.memory.forgotten"),
      corrected: said("brain.memory.corrected"),
    }).toStrictEqual({
      get: "Read entities from the Brain",
      find: "Read entities from the Brain",
      remembered: "Remembered something in the Brain",
      forgotten: "Forgot a memory in the Brain",
      corrected: "Corrected a memory in the Brain",
    });
  });
});
