import { readFileSync } from "node:fs";

import { appLinkSchema, reservedAppLinks } from "@grasp-os/shared/apps";
import { describe, expect, it } from "vite-plus/test";

import { suggestedLink } from "./app-own-link.tsx";

// An App's link is tried only where no page is (`routes/_shell.$.tsx`), and
// shared's `reservedAppLinks` keeps links off every page's first part, so a
// page added later can't be taken by a link set before it. Read from the
// generated route tree, which names every page.

const tree = readFileSync(
  new URL("../routeTree.gen.ts", import.meta.url),
  "utf-8"
);

/** The first part of every page's address, but for an address's own part. */
const firstParts = (): Set<string> => {
  const list = /fullPaths:(?<paths>[^:]+?)fileRoutesByTo/su.exec(tree)?.groups
    ?.paths;
  const parts = [...(list ?? "").matchAll(/'\/(?<part>[^/']*)/gu)]
    .map(({ groups }) => groups?.part ?? "")
    .filter((part) => part !== "" && !part.startsWith("$"));
  return new Set(parts);
};

describe("App links", () => {
  it("are kept off the first part of every page's address", () => {
    const parts = firstParts();

    expect({
      read: parts.size > 10,
      unreserved: [...parts].filter((part) => !reservedAppLinks.has(part)),
    }).toStrictEqual({ read: true, unreserved: [] });
  });

  it("are suggested from an App's name, in a form core takes", () => {
    const suggested = [
      "Sales pipeline",
      "  Ärger & Co. — Q3!  ",
      "x".repeat(80),
    ].map(suggestedLink);

    expect({
      suggested: suggested.slice(0, 2),
      valid: suggested.map((link) => appLinkSchema.safeParse(link).success),
    }).toStrictEqual({
      suggested: ["sales-pipeline", "arger-co-q3"],
      valid: [true, true, true],
    });
  });
});
