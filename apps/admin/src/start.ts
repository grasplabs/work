/**
 * The admin's TanStack Start instance: Start's own CSRF check on every
 * server function call. A call counts as the admin's own page only when
 * the browser says it is same-origin (`Sec-Fetch-Site`), or, from one that
 * doesn't send that, its `Origin` or `Referer` is the admin's; anything
 * else, a call with none of them included, is refused before the function
 * runs. A GET function too: a link or an image on another site could make
 * one with a staff member's Access cookie. Who the caller is stays the
 * Access check's (src/access.ts), before Start sees the request.
 */
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({
      filter: ({ handlerType }) => handlerType === "serverFn",
    }),
  ],
}));
