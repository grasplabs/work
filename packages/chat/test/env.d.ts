import type { ChatState } from "../src/state.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      CHAT_STATE: DurableObjectNamespace<ChatState>;
    }
  }
}
