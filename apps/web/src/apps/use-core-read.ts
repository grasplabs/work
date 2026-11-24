import { useEffect, useEffectEvent, useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

/**
 * `useCoreRead`, whether what it gives is the read for `key` itself
 * (`current`) rather than an earlier one of the same `scope` held while
 * `key` is read, and which read it is (`id`, minted as each read lands,
 * so a key read again is a new read). `read` gets the read's signal,
 * which ends when the read is no longer wanted (`loadFromCore`).
 * `again` reads `key` once more (Try again).
 */
export const useHeldCoreRead = <T>(
  key: string,
  read: (session: Session, signal: AbortSignal) => Promise<T>,
  scope?: string
): {
  loaded: Loaded<T> | undefined;
  current: boolean;
  id: string | undefined;
  again: () => void;
} => {
  const core = useCore();
  const [held, setHeld] = useState<{
    key: string;
    scope: string | undefined;
    loaded: Loaded<T>;
    id: string;
  }>();
  const [attempt, setAttempt] = useState(0);
  const again = (): void => {
    setAttempt((before) => before + 1);
  };
  const onRead = useEffectEvent(
    async (signal: AbortSignal): Promise<Loaded<T>> =>
      await loadFromCore(core, read, signal)
  );
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      const loaded = await onRead(left.signal);
      if (!left.signal.aborted) {
        setHeld({ key, scope, loaded, id: crypto.randomUUID() });
      }
    };
    void load();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` says when to read again
  }, [key, scope, attempt]);
  if (held?.key === key) {
    return { loaded: held.loaded, current: true, id: held.id, again };
  }
  const kept = scope !== undefined && held?.scope === scope ? held : undefined;
  return { loaded: kept?.loaded, current: false, id: kept?.id, again };
};

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
): Loaded<T> | undefined => useHeldCoreRead(key, read, scope).loaded;
