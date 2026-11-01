import { demos } from "@grasp-os/ui/catalog/demos";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { createFileRoute, notFound, useParams } from "@tanstack/react-router";

// Local gallery of the UI kit: one component's demo per page, which the
// accessibility checks in e2e/catalog.e2e.ts go through. Not product UI:
// like /kit, builds in production mode answer not found.
//
// Only the component reads `demos` statically, so the code splitter keeps
// them, and every package they pull in, in this route's lazy chunk.
// `beforeLoad` stays in the eager one and imports them only when it runs:
// a production build answers not found first, and never loads them.

const ComponentDemo = () => {
  const { name } = useParams({ from: "/kit_/components/$name" });
  const Demo = Object.hasOwn(demos, name) ? demos[name] : undefined;
  if (Demo === undefined) {
    return null;
  }
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <PageHeaderTitle>{name}</PageHeaderTitle>
      <div data-catalog-content="">
        <Demo />
      </div>
    </main>
  );
};

export const Route = createFileRoute("/kit_/components/$name")({
  beforeLoad: async ({ params }) => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
    const catalog = await import("@grasp-os/ui/catalog/demos");
    if (!Object.hasOwn(catalog.demos, params.name)) {
      throw notFound();
    }
  },
  component: ComponentDemo,
});
