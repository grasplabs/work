import { i18n } from "@lingui/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { messages as dutch } from "../../locales/nl/messages.po";
import { scoreOf, wordsOf } from "./apps-recommend.ts";

// Which apps a new agent's words point to: Grasp's own suites by what the
// web says they are for, in the page's language and in English, as people
// write a job in either.

const microsoft = {
  source: "native",
  id: "microsoft",
  name: "Microsoft 365",
  categories: ["Productivity"],
  description: null,
};

describe(scoreOf, () => {
  afterEach(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  it("points a job to a native suite by what it is for, written in English or in the page's language", () => {
    i18n.loadAndActivate({ locale: "nl", messages: dutch });
    expect({
      english: scoreOf(microsoft, wordsOf("Organize the team's files")),
      dutch: scoreOf(microsoft, wordsOf("Bestanden van het team ordenen")),
      neither: scoreOf(microsoft, wordsOf("Answer the phone")),
    }).toStrictEqual({ english: 1, dutch: 1, neither: 0 });
  });
});
