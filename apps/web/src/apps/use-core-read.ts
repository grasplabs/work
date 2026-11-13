import { useEffect, useEffectEvent, useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

/**
 * What `read` read for `key`, read again whenever `key` changes; nothing
 * while it is read, unless an earlier read of the same `scope` landed:
 * that one stays until the new one does, so what is shown doesn't blink
 * away at each write.
 */
export const useCoreRead = <T>(
  key: string,
  read: (session: Session, signal: AbortSignal) => Promise<T>,
  scope?: string
): Loaded<T> | undefined => {
  const core = useCore();
  const [held, setHeld] = useState<{
    key: string;
    scope: string | undefined;
    loaded: Loaded<T>;
  }>();
  const onRead = useEffectEvent(
    async (signal: AbortSignal): Promise<Loaded<T>> =>
      await loadFromCore(core, read, signal)
  );
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      const loaded = await onRead(left.signal);
      if (!left.signal.aborted) {
        setHeld({ key, scope, loaded });
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [key, scope]);
  if (held?.key === key) {
    return held.loaded;
  }
  return scope !== undefined && held?.scope === scope ? held.loaded : undefined;
};
