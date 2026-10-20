import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChosenAtStart } from "./chosen-at-start.tsx";

// A step's options chosen when the run starts, as a version's review and
// the workflow's page show them (builds.tsx, the workflow route's
// StepCard), read from what the badge renders.

/** What the badge renders for `options`, as text without its markup. */
const shown = (options?: readonly string[]): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <ChosenAtStart options={options} />
    </I18nProvider>
  )
    .replaceAll(/<[^>]+>/gu, "")
    .trim();

describe("a step's options chosen when the run starts", () => {
  it("names each one, in words where it has some, and shows nothing for a step without any", () => {
    expect({
      reviewer: shown(["from", "timeout"]),
      other: shown(["somethingNew"]),
      none: shown([]),
      absent: shown(),
    }).toStrictEqual({
      reviewer: "Chosen when the run starts: who answers and the deadline",
      other: "Chosen when the run starts: somethingNew",
      none: "",
      absent: "",
    });
  });
});
