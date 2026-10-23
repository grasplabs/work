import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import styles from "../styles.css?url";

/**
 * The document every page renders in. Grasp's admin (src/routes/admin.tsx)
 * is the one frame staff work in, with its own sidebar: the console has no
 * bar of its own any more.
 */
const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      {children}
      <Scripts />
    </body>
  </html>
);

/** A page there isn't. */
const NotFound = () => (
  <main className="flex flex-col gap-4 p-6">
    <h1 className="text-2xl font-medium">Not found</h1>
    <p className="text-sm">There&apos;s no such page.</p>
    <Link className="text-sm underline underline-offset-4" to="/admin">
      Back to the admin
    </Link>
  </main>
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Grasp admin" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});
