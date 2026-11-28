"use client";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@grasp-os/app-kit/components/code-block";
import { useHighlightedCode } from "@grasp-os/app-kit/hooks/use-highlighted-code";
import { withinMarkdownLimits } from "@grasp-os/shared/markdown-limits";
import { cn } from "cn";
import { Component } from "react";
import type { ComponentProps, ReactElement } from "react";
import {
  defaultRehypePlugins,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown";
import type { ExtraProps, StreamdownProps } from "streamdown";

// The registry's Markdown (apps/v4/components/markdown.tsx in
// github.com/shadcn-ui/ui, MIT), as its chat examples render a model's
// answer: Streamdown, which completes half-written Markdown while it
// streams, with fenced code drawn by the kit's code block. Upstream's code
// but for these changes, listed with their reason and test in
// packages/app-kit/local-changes.json:
// - Raw HTML in the text shows as the text it is: Streamdown's own rehype
//   plugins less rehype-raw, which would parse it into elements.
// - A link is its words with its address beside them, to read (one within
//   the answer, a footnote's, its words alone): an App
//   page's frame opens no window and goes nowhere (sandboxed without
//   popups or navigation, it opens a URL only through a links permission
//   of its App), so Streamdown's link, a button whose dialog opens or
//   copies the address, would do nothing.
// - Text past @grasp-os/shared's `markdownLimits` (very large or
//   pathological: deep nesting, hundreds of unclosed emphasis or links in a paragraph)
//   shows as plain text, as does text Streamdown throws on: untrusted
//   text must not freeze or crash the page for whoever opens it.
// A page can't switch the first two off: the props that would replace or widen
// the pipeline are the kit's (`PIPELINE`), and its link wins over a
// page's `components`.
// Upstream's `cn-markdown` class is left out: no style of the registry
// gives it any CSS, and the lint refuses a class without any. An image
// from another server stays an <img>, as upstream's: the frame's policy
// (`img-src data: blob:`) refuses to load it, and Streamdown shows that
// it isn't available.

const languageClass = /language-(?<language>\S+)/u;

/** The address Streamdown gives a link whose address is still being written. */
const incompleteLink = "streamdown:incomplete-link";

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  // True while the closing fence has not arrived yet.
  const incomplete = useIsCodeFenceIncomplete();
  const lines = useHighlightedCode(code, language);

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton disabled={incomplete} value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with data-block. Inline code stays inline.
  if (!("data-block" in props)) {
    return (
      <code
        className={cn(
          "bg-muted rounded-sm px-1 py-0.5 font-mono text-[0.9em]",
          className
        )}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={languageClass.exec(className ?? "")?.groups?.language ?? ""}
    />
  );
}

/** The scheme an autolink's words leave out (`www.example.com`, `a@b.c`). */
const autolinkScheme = /^(?:https?:\/\/|mailto:)/u;

function MarkdownLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  // A link still being written, one whose address the sanitizer dropped
  // (`javascript:`), or one within the answer (a footnote's): its words
  // alone.
  if (
    href === undefined ||
    href === "" ||
    href === incompleteLink ||
    href.startsWith("#")
  ) {
    return <span>{children}</span>;
  }
  // An autolink's words are its address already.
  const words = children === href.replace(autolinkScheme, "");
  return (
    <span className="wrap-anywhere">
      {words || children === href ? (
        children
      ) : (
        <>
          {children} ({href})
        </>
      )}
    </span>
  );
}

// Streamdown memoizes on components, so keep the default stable.
const DEFAULT_COMPONENTS = { code: MarkdownCode };

/**
 * Streamdown's props that would replace or widen its safe handling of the
 * text, each set by the kit whatever a page passes, and refused by the
 * types: its rehype plugins, less rehype-raw; and its own (undefined), as
 * a page's remark plugins, remark-rehype options, plugins or block
 * component could put HTML or links back, a URL transform or allowed tags
 * could let an address or a tag through the sanitizer, and its link
 * safety only configures the link the kit replaces.
 */
type Pipeline =
  | "rehypePlugins"
  | "remarkPlugins"
  | "remarkRehypeOptions"
  | "urlTransform"
  | "allowedTags"
  | "literalTagContent"
  | "plugins"
  | "BlockComponent"
  | "linkSafety";

const PIPELINE: { [Prop in Pipeline]: StreamdownProps[Prop] } = {
  rehypePlugins: Object.entries(defaultRehypePlugins)
    .filter(([name]) => name !== "raw")
    .map(([, plugin]) => plugin),
  remarkPlugins: undefined,
  remarkRehypeOptions: undefined,
  urlTransform: undefined,
  allowedTags: undefined,
  literalTagContent: undefined,
  plugins: undefined,
  BlockComponent: undefined,
  linkSafety: undefined,
};

/** The text as it is, wrapped where it ends a line: no Markdown drawn. */
function MarkdownText({
  className,
  children,
}: {
  className?: string;
  children: string;
}) {
  return (
    <div
      className={cn(
        "w-full min-w-0 overflow-hidden wrap-anywhere whitespace-pre-wrap",
        className
      )}
      data-slot="markdown"
    >
      {children}
    </div>
  );
}

/**
 * The text as plain text when Streamdown throws on it, instead of the
 * page's error screen; it tries again once the text changes.
 */
interface BoundaryProps {
  className?: string;
  text: string;
  children: ReactElement;
}

class MarkdownBoundary extends Component<
  BoundaryProps,
  { failed: boolean; text: string }
> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, text: props.text };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: { text: string }
  ) {
    return props.text === state.text
      ? null
      : { failed: false, text: props.text };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render(): ReactElement {
    const { className, text, children } = this.props;
    return this.state.failed ? (
      <MarkdownText className={className}>{text}</MarkdownText>
    ) : (
      children
    );
  }
}

function Markdown({
  className,
  components = DEFAULT_COMPONENTS,
  controls = false,
  children = "",
  ...props
}: Omit<StreamdownProps, Pipeline>) {
  // Text a renderer can't take in about a second, or would overflow the
  // stack on, is shown as it is (@grasp-os/shared/markdown-limits).
  if (!withinMarkdownLimits(children)) {
    return <MarkdownText className={className}>{children}</MarkdownText>;
  }
  return (
    <MarkdownBoundary className={className} text={children}>
      <Streamdown
        className={cn("w-full min-w-0 overflow-hidden", className)}
        controls={controls}
        data-slot="markdown"
        {...props}
        {...PIPELINE}
        // A page's components restyle the elements; the kit's link wins.
        components={{ ...components, a: MarkdownLink }}
      >
        {children}
      </Streamdown>
    </MarkdownBoundary>
  );
}

export { Markdown };
