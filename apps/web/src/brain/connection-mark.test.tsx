// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { brandOf, ConnectionMark } from "./connection-mark.tsx";

// A connection on the Sources page comes with its name alone, so its name finds its brand: a
// brand's own name as a whole word of it, in any case. A name that only starts like a brand's, or
// names none, gets the mark of a connection, never a letter on a tile.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** What the mark beside `name` draws: a brand's own mark, a letter on a tile, or a connection's. */
const drawn = (name: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(<ConnectionMark name={name} />);
  });
  const brand = host.querySelector("[data-slot=brand-icon]");
  const connection = host.querySelector("svg[data-moves=links]");
  return {
    mark: brand !== null && host.querySelector("[data-fallback]") === null,
    letter: host.querySelector("[data-fallback]") !== null,
    connection: connection !== null,
    // Decorative: the name beside it says whose it is.
    hidden: (brand ?? connection)?.getAttribute("aria-hidden") === "true",
  };
};

describe("a connection's mark", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("finds the brand a connection's name names as a whole word, in any case", () => {
    expect(
      [
        "Microsoft 365",
        "Google Workspace",
        "google drive (sales)",
        "Microsoft",
        "HubSpot",
        "Gmail",
        "Googlesheets",
        "Microsoftish CRM",
        "",
      ].map(brandOf)
    ).toStrictEqual([
      "microsoft",
      "google",
      "google",
      "microsoft",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("draws the brand's own mark for Microsoft and Google, and a connection's mark for anything else, never a letter", () => {
    expect(
      ["Microsoft 365", "Google Workspace", "HubSpot", "Googlesheets"].map(
        drawn
      )
    ).toStrictEqual([
      { mark: true, letter: false, connection: false, hidden: true },
      { mark: true, letter: false, connection: false, hidden: true },
      { mark: false, letter: false, connection: true, hidden: true },
      { mark: false, letter: false, connection: true, hidden: true },
    ]);
  });
});
