// What the design system's lint says of an App's screens and components,
// alike in Grasp (packages/compiler/src/lint.ts, screen-checks.test.ts)
// and in an exported App's oxlint (scripts/package-definition.test.ts):
// - the kit's own classes, which its theme and the stylesheets it imports
//   add to Tailwind's, pass, and a class Tailwind doesn't know fails;
// - a disable comment as oxlint writes it holds;
// - a disable comment for another lint's rule, and an inline config
//   comment, which oxlint doesn't read, say nothing.

/** Screens and components, by path in the App. */
export const designCases: Record<string, string> = {
  "screens/kit-classes.tsx": `export default function KitClasses() {
  return (
    <p className="flex animate-in fade-in ease-house type-display foo-bar">
      Kit
    </p>
  );
}
`,
  "screens/disabled.tsx": `import { Button } from "@grasp-os/ui/components/button";

export default function Disabled() {
  return (
    <main>
      {/* oxlint-disable-next-line shadcn/no-restyle */}
      <Button className="rounded-none">Go</Button>
      {/* oxlint-disable-next-line grasp/no-remote-resources */}
      <img alt="" src="https://example.com/logo.png" />
    </main>
  );
}
`,
  "components/other-rules.tsx": `// eslint-disable-next-line typescript/no-explicit-any
export const anything = (value: any): unknown => value;

// oxlint-disable-next-line react-doctor/no-giant-component
export const Plain = () => <p className="flex">Plain</p>;

/* eslint no-console: "error" */
export const quiet = (): number => 1;
`,
};

/** What the design system's lint finds in them: the unknown class. */
export const designFindings = [
  "screens/kit-classes.tsx shadcn/no-unknown-classes",
];
