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
});
