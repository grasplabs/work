import { SidebarProvider } from "@grasp-os/ui/components/sidebar";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarBrandView } from "./sidebar-brand.tsx";

// The sidebar's header: the organization's name over "Grasp" once core
// says it, as the prototype's; "Grasp" alone until then.

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory(),
});

/** The header's text, as a screen reader reads it. */
const textOf = (name?: string): string =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <SidebarProvider>
        <SidebarBrandView name={name} />
      </SidebarProvider>
    </RouterContextProvider>
  )
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

describe("the sidebar's header", () => {
  it("names the organization over Grasp, and says Grasp alone until it knows the name", () => {
    expect({
      named: textOf("Noordkade Finance"),
      unknown: textOf(),
    }).toStrictEqual({ named: "Noordkade Finance Grasp", unknown: "Grasp" });
  });
});
