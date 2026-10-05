import { useLocation, useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

/**
 * A change on an Integrations page (see changeThenRefresh), then the page
 * read again, without the `connection` and `connectionError` a flow came
 * back with: their notice was about that flow, not about what the page
 * shows now. Other search (the list's filters) stays.
 */
export const useChange = ({
  leave = false,
}: {
  /** The change takes the page away: go back to the list after it. */
  leave?: boolean;
} = {}) => {
  const router = useRouter();
  const { pathname, searchStr } = useLocation();
  const action = useCoreAction();
  const change = async (
    make: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await action.run(async (session) => {
      await changeThenRefresh(
        async () => await make(session),
        async () => {
          const params = new URLSearchParams(searchStr);
          params.delete("connection");
          params.delete("connectionError");
          const left = params.toString();
          await router.navigate({
            href: leave
              ? "/integrations"
              : `${pathname}${left === "" ? "" : `?${left}`}`,
            replace: true,
          });
          // `sync` waits for the loader; without it, the router reloads
          // the page's data in the background and resolves at once.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { busy: action.busy, failure: action.failure, change };
};
