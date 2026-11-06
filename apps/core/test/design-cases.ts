// What the pages' own lint rules (packages/compiler/src/page-rules.ts)
// say of an App's pages and components, alike in Grasp (Ultracite's lint,
// page-checks.test.ts) and in an exported App's oxlint
// (scripts/package-definition.test.ts):
// - a plain <form>, which never submits in a page's frame, fails;
// - a disable comment as oxlint writes it holds;
// - a disable comment for another lint's rule, and an inline config
//   comment, which oxlint doesn't read, say nothing.

/** Pages and components, by path in the App. */
export const designCases: Record<string, string> = {
  "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Ask = () => (
  <form>
    <p>Ask</p>
  </form>
);

export const Route = createFileRoute("/")({ component: Ask });
`,
  "src/routes/disabled.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Disabled = () => (
  <main>
    {/* oxlint-disable-next-line react/forbid-elements */}
    <form />
  </main>
);

export const Route = createFileRoute("/disabled")({ component: Disabled });
`,
  "src/components/other-rules.tsx": `// eslint-disable-next-line typescript/no-explicit-any
export const anything = (value: any): unknown => value;

// oxlint-disable-next-line react-doctor/no-giant-component
export const Plain = () => <p className="flex">Plain</p>;

/* eslint no-console: "error" */
export const quiet = (): number => 1;
`,
};

/** What the pages' lint finds in them: the plain form. */
export const designFindings = ["src/routes/index.tsx react/forbid-elements"];
