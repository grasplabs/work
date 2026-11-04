import { useState } from "react";

/**
 * Makes something once for `key`: making it is one step of a change, and
 * when a later step fails, trying again with the same `key` answers what
 * was made rather than making another. `forget` once all of it went
 * through.
 */
export const useMadeOnce = () => {
  const [made, setMade] = useState<{ key: string; id: string }>();
  const once = async (
    key: string,
    make: () => Promise<string>
  ): Promise<string> => {
    if (made?.key === key) {
      return made.id;
    }
    const id = await make();
    setMade({ key, id });
    return id;
  };
  const forget = (): void => {
    setMade(undefined);
  };
  return { once, forget };
};
