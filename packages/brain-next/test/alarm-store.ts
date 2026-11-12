// The store as the tests' Worker binds it: as a host subclasses it, so a
// person's own store works its queue on its own alarm, here with no
// model, as core runs while none ships.
import type { AskModel } from "../src/contract.ts";
import { BrainStore as Store } from "../src/store.ts";
import type { AlarmHost } from "../src/store.ts";

/** A model that answers nothing: no work of the tests asks one. */
const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** The store, its own alarm working as a host with no model works it. */
export class BrainStore extends Store {
  // oxlint-disable-next-line class-methods-use-this -- the store's hook for its host
  protected override readonly alarmHost = async (): Promise<AlarmHost> => {
    await Promise.resolve();
    return {
      ask: quietAsk,
      embedders: {
        model: null,
        embed: async () => {
          await Promise.resolve();
          throw new Error("No model in these tests");
        },
      },
    };
  };
}
