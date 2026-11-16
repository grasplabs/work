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

  it("say what was done to an upload into the Brain, each in its own words", () => {
    const uploadActions = [
      "brain.upload.added",
      "brain.upload.refused",
      "brain.upload.failed",
      "brain.upload.deleted",
      "brain.upload.delete_failed",
      "brain.upload.listed",
    ];
    const words = uploadActions.map((action) => said(action));
    expect({
      erased: said("brain.upload.deleted"),
      allSaid: words.every((each) => each !== undefined),
      distinct: new Set(words.slice(1)).size,
    }).toStrictEqual({
      erased: "Erased an upload from the Brain for good",
      allSaid: true,
      distinct: uploadActions.length - 1,
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

  it("say code read entities, each by its own name", () => {
    expect({
      get: said("brain.entities.get"),
      find: said("brain.entities.find"),
    }).toStrictEqual({
      get: "Read entities from the Brain",
      find: "Read entities from the Brain",
    });
  });
});
