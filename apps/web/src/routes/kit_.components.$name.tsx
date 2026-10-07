import { isKitComponent } from "@grasp-os/ui/catalog";
import { demos } from "@grasp-os/ui/catalog/demos";
import { createFileRoute, notFound, useParams } from "@tanstack/react-router";

// Local gallery of the UI kit: one component's demo per page, which the
// accessibility checks in e2e/catalog.e2e.ts go through. Not product UI:
// like /kit, builds in production mode answer not found.
//
// Only the component reads `demos`, so the code splitter keeps them, and
// every package they pull in, in this route's lazy chunk. `beforeLoad`
// stays in the eager one and checks the name against the inventory, which
// is plain data.

const ComponentDemo = () => {
  const { name } = useParams({ from: "/kit_/components/$name" });
  if (!isKitComponent(name)) {
    return null;
  }
  const Demo = demos[name];
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">{name}</h1>
      <Demo />
    </main>
  );
};

export const Route = createFileRoute("/kit_/components/$name")({
  beforeLoad: ({ params }) => {
    if (import.meta.env.MODE === "production" || !isKitComponent(params.name)) {
      throw notFound();
    }
  },
  component: ComponentDemo,
});
