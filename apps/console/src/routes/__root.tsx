import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import styles from "../styles.css?url";

/**
 * The console's bar above its pages. Grasp's admin has a frame of its own
 * (src/admin/frame.tsx), so not there. It follows the page on screen, not
 * the address: the address changes before the next page has loaded, while
 * the last one is still showing.
 */
const ConsoleNav = () => {
  const inAdmin = useRouterState({
    select: (state) =>
      state.matches.some(({ routeId }) => routeId === "/admin"),
  });
  if (inAdmin) {
    return null;
  }
  return (
    <nav aria-label="Console" className="flex gap-4 border-b px-6 py-3">
      <Link
        to="/"
        activeOptions={{ exact: true }}
        activeProps={{ className: "font-medium" }}
      >
        Clients
      </Link>
      <Link to="/releases" activeProps={{ className: "font-medium" }}>
        Releases
      </Link>
      <Link to="/rollouts" activeProps={{ className: "font-medium" }}>
        Rollouts
      </Link>
      <Link to="/admin">Admin</Link>
    </nav>
  );
};

const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      <ConsoleNav />
      {children}
      <Scripts />
    </body>
  </html>
);

/** A page the console doesn't have. */
const NotFound = () => (
  <main className="flex flex-col gap-4 p-6">
    <h1 className="text-2xl font-medium">Not found</h1>
    <p className="text-sm">The console has no such page.</p>
    <Link to="/" className="text-sm underline underline-offset-4">
      Back to clients
    </Link>
  </main>
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Grasp console" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});
