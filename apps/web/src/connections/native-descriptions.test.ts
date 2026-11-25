import { i18n } from "@lingui/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { messages as german } from "../locales/de/messages.po";
import { descriptionOf } from "./native-descriptions.ts";

// What an app in the catalog is for: Grasp's own connectors in the page's
// language, whatever connect sends, and any other as connect sends it.

describe(descriptionOf, () => {
  afterEach(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });

  const microsoft = { source: "native", id: "microsoft", description: null };
  const toolkit = {
    source: "composio",
    id: "google",
    description: "A toolkit.",
  };

  it("words Grasp's own connectors in the page's language, and a toolkit as the catalog describes it, whatever its slug", () => {
    const english = [microsoft, toolkit].map(descriptionOf);
    i18n.loadAndActivate({ locale: "de", messages: german });
    const inGerman = [microsoft, toolkit].map(descriptionOf);
    expect({ english, inGerman }).toStrictEqual({
      english: [
        "Outlook mail and calendars, and files in OneDrive and SharePoint.",
        "A toolkit.",
      ],
      inGerman: [
        "Outlook-E-Mails und -Kalender sowie Dateien in OneDrive und SharePoint.",
        "A toolkit.",
      ],
    });
  });
});
