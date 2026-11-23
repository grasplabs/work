import {
  CatchBoundary,
  createFileRoute,
  notFound,
} from "@tanstack/react-router";

import { demoGroups } from "../kit-damsko/demos.ts";

// Local gallery of Damsko's components (packages/ui): one small use of
// each, drawn by this app's own build beside the kit's styles, before any
// page uses them. e2e/kit-damsko.e2e.ts loads it under core's Content
// Security Policy and holds every demo to having drawn. Not product UI:
// like /kit, builds in production mode answer not found, and only the
// component reads the demos, so they stay in this route's lazy chunk.

const Failed = () => <p role="alert">This part failed to draw.</p>;

const Gallery = () => (
  <main className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
    <h1 className="font-serif text-3xl">Damsko</h1>
    {Object.entries(demoGroups).map(([group, demos]) => (
      <section aria-label={group} className="flex flex-col gap-4" key={group}>
        <h2 className="font-medium">{group}</h2>
        <ul className="grid gap-4 md:grid-cols-2">
          {Object.entries(demos).map(([name, Demo]) => (
            <li
              className="flex min-w-0 flex-col gap-3 rounded-lg border p-4"
              data-demo={name}
              key={name}
            >
              <span className="text-muted-foreground text-xs">{name}</span>
              <CatchBoundary errorComponent={Failed} getResetKey={() => name}>
                <div data-demo-content="">
                  <Demo />
                </div>
              </CatchBoundary>
            </li>
          ))}
        </ul>
      </section>
    ))}
  </main>
);

export const Route = createFileRoute("/kit_/damsko")({
  beforeLoad: () => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
  },
  component: Gallery,
});
