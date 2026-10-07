import { examples } from "@grasp-os/ui/catalog";
import type { ExampleName } from "@grasp-os/ui/catalog";
import { loadExample } from "@grasp-os/ui/catalog/examples";
import { createFileRoute, notFound, useParams } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Local gallery of the UI kit's examples for agents, one per page, each
// loaded by name through the catalog as agents load it; the accessibility
// checks in e2e/catalog.e2e.ts go through them. Not product UI: like /kit,
// builds in production mode answer not found.

const isExample = (name: string): name is ExampleName =>
  Object.hasOwn(examples, name);

// One lazy component per example, made once: an example's module loads
// when its page renders it, not before.
const lazyExamples = {
  list: lazy(async () => ({ default: await loadExample.list() })),
  "detail-form": lazy(async () => ({
    default: await loadExample["detail-form"](),
  })),
  dialog: lazy(async () => ({ default: await loadExample.dialog() })),
  table: lazy(async () => ({ default: await loadExample.table() })),
  "responsive-navigation": lazy(async () => ({
    default: await loadExample["responsive-navigation"](),
  })),
  "specialised-panel": lazy(async () => ({
    default: await loadExample["specialised-panel"](),
  })),
} satisfies Record<ExampleName, unknown>;

const ExampleDemo = () => {
  const { name } = useParams({ from: "/kit_/examples/$name" });
  if (!isExample(name)) {
    return null;
  }
  const Example = lazyExamples[name];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">{name}</h1>
      <Suspense>
        <Example />
      </Suspense>
    </main>
  );
};

export const Route = createFileRoute("/kit_/examples/$name")({
  beforeLoad: ({ params }) => {
    if (import.meta.env.MODE === "production" || !isExample(params.name)) {
      throw notFound();
    }
  },
  component: ExampleDemo,
});
