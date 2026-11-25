import { describe, expect, it } from "vite-plus/test";

import { leanModules, leanStylesheet } from "./lean-parts.ts";

// The lean pages' copy of the stylesheet keeps every rule they can need:
// those for the class names their modules hold, and every rule written by
// hand, used or not. It drops only what Tailwind's utilities layer and
// StyleX generated for classes nothing on those pages names, and keeps the
// rest in the whole stylesheet's order, so the whole can follow it.

const whole = [
  "@layer base{html{color:red}}",
  "@layer utilities{.flex{display:flex}.grid{display:grid}",
  "@media (width>=40rem){.sm\\:grid{display:grid}.sm\\:flex{display:flex}}}",
  ".painted-field{color:blue}",
  ".dark .painted-field{color:green}",
  ".x1abcde{margin:0}",
  ".x2fghij:not(#\\#){padding:0}",
  ".x3klmno:hover{color:red}",
  "@media (prefers-reduced-motion:reduce){.x4pqrst{transition:none}}",
].join("");

const lean = leanStylesheet(
  whole,
  new Set(["flex", "sm:grid", "x2fghij", "x3klmno"])
);

describe("the lean stylesheet", () => {
  it("keeps the generated rules a lean page's classes name, in order", () => {
    expect(lean).toBe(
      [
        "@layer base{html{color:red}}",
        "@layer utilities{.flex{display:flex}",
        "@media (width>=40rem){.sm\\:grid{display:grid}}}",
        ".painted-field{color:#00f}",
        ".dark .painted-field{color:green}",
        ".x2fghij:not(#\\#){padding:0}",
        ".x3klmno:hover{color:red}",
        "@media (prefers-reduced-motion:reduce){}",
      ].join("")
    );
  });
});

// The modules each lean page can run, from a build's graph: index.html's
// main.tsx, the route tree main.tsx loads for the page and the page's own
// route, with what they import; never the other route tree, another
// route's page or a catalog.
describe("a lean page's modules", () => {
  const src = "/app/src";
  const imports: Record<string, { stat?: string[]; dyn?: string[] }> = {
    "/app/index.html": { stat: [`${src}/main.tsx`] },
    [`${src}/main.tsx`]: {
      stat: [`${src}/i18n.ts`],
      dyn: [`${src}/interview-routes.tsx`, `${src}/app-routes.tsx`],
    },
    [`${src}/i18n.ts`]: {
      dyn: [`${src}/locales/en/messages.po`, "\0lean-catalog:setup:en.lean"],
    },
    [`${src}/interview-routes.tsx`]: { stat: [`${src}/routes/interview.tsx`] },
    [`${src}/routes/interview.tsx`]: {
      dyn: [`${src}/routes/interview.tsx?tsr-split=component`],
    },
    [`${src}/routes/interview.tsx?tsr-split=component`]: {
      stat: [`${src}/interview/talk.tsx`],
    },
    [`${src}/interview/talk.tsx`]: { dyn: [`${src}/interview/audio.ts`] },
    [`${src}/interview/audio.ts`]: {},
    [`${src}/app-routes.tsx`]: { stat: [`${src}/routeTree.gen.ts`] },
    [`${src}/routeTree.gen.ts`]: {
      stat: [`${src}/routes/setup.tsx`, `${src}/routes/inbox.tsx`],
    },
    [`${src}/routes/setup.tsx`]: {
      dyn: [`${src}/routes/setup.tsx?tsr-split=component`],
    },
    [`${src}/routes/setup.tsx?tsr-split=component`]: {},
    [`${src}/routes/inbox.tsx`]: {
      dyn: [`${src}/routes/inbox.tsx?tsr-split=component`],
    },
    [`${src}/routes/inbox.tsx?tsr-split=component`]: {},
  };
  const graph = {
    ids: () => Object.keys(imports),
    info: (id: string) => {
      const found = imports[id];
      return found === undefined
        ? undefined
        : {
            isEntry: id === "/app/index.html",
            importedIds: found.stat ?? [],
            dynamicallyImportedIds: found.dyn ?? [],
          };
    },
  };
  const own = (page: "interview" | "setup"): string[] =>
    [...leanModules(graph, src, page)]
      .filter((id) => id.startsWith(src))
      .map((id) => id.slice(src.length + 1))
      .toSorted();

  it("holds the interview's and nothing of the app's route tree", () => {
    expect(own("interview")).toStrictEqual([
      "i18n.ts",
      "interview-routes.tsx",
      "interview/audio.ts",
      "interview/talk.tsx",
      "main.tsx",
      "routes/interview.tsx",
      "routes/interview.tsx?tsr-split=component",
    ]);
  });

  it("holds the setup's, and no other route's page", () => {
    expect(own("setup")).toStrictEqual([
      "app-routes.tsx",
      "i18n.ts",
      "main.tsx",
      "routeTree.gen.ts",
      "routes/inbox.tsx",
      "routes/setup.tsx",
      "routes/setup.tsx?tsr-split=component",
    ]);
  });
});
