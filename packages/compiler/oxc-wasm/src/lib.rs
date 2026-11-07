//! oxc's React transform, oxlint's linter and oxfmt's formatter, for App
//! code in an isolate, and oxc's parser, for App code and for workflow
//! expressions: threadless WebAssembly with no file system. oxc publishes
//! no WebAssembly build of them that starts small (oxlint's JS plugins and
//! parallel runtime need native threads; oxc-parser's threadless build
//! declares 61 MiB of memory up front), so this is the thin layer their
//! own playground and napi packages have over the same crates: it
//! transforms a file as `napi/transform-react` does (transform.rs), parses
//! and lints it as oxlint's runtime does (`service/runtime.rs`), fixes as
//! `oxlint --fix` does, and formats as `oxfmt` does (tools.rs, the `tools`
//! feature); and it parses a file, or one expression, to ESTree as
//! oxc-parser does (napi/parser).
//!
//! Two builds (build.sh): oxc.wasm, all of it, a wasm32-wasip1 module the
//! compiler's isolates load (packages/compiler/src/oxc.ts); and
//! oxc-parse.wasm, the parser alone, a wasm32-unknown-unknown module with
//! no imports, which core's Worker loads (packages/sdk/src/oxc-parse.ts).
//!
//! Delete this crate once oxc publishes threadless WebAssembly builds of
//! its linter, formatter, React transform and parser that start small.
//!
//! The calls are plain C ABI: text goes in through `alloc` (owned and
//! freed by the callee), and the answer is read from `out_ptr` for the
//! length a call returns. Each file gets its own arena, dropped after it,
//! so memory grows with the largest file, not with how many are linted.
//!
//! A call that traps (a panic, which aborts; the stack or the memory's
//! ceiling, build.sh, run out on a file nested too deep or too large)
//! leaves the instance's stack pointer, allocator and cells where they
//! were: its caller never calls it again, and starts a fresh one.
#[cfg(feature = "tools")]
mod tools;
#[cfg(feature = "tools")]
mod transform;

use std::cell::RefCell;

use oxc::{
    allocator::Allocator,
    ast::CommentKind,
    ast_visit::{VisitMut, utf8_to_utf16::Utf8ToUtf16},
    diagnostics::{OxcDiagnostic, Severity},
    parser::{ParseOptions, Parser, ParserReturn},
    semantic::SemanticBuilder,
    span::SourceType,
};
use oxc_estree::CompactFixesSerializer;
use serde::Serialize;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Room for `len` bytes of input, which the call it is passed to frees.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// Where the last call's answer is.
#[unsafe(no_mangle)]
pub extern "C" fn out_ptr() -> *const u8 {
    OUT.with(|out| out.borrow().as_ptr())
}

/// Text the caller wrote at `ptr` (`alloc`), owned from here on.
fn input(ptr: *mut u8, len: usize) -> String {
    // SAFETY: `ptr` is `alloc`'s, of `len` bytes, written with UTF-8 by
    // the caller, and handed over once.
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len) };
    String::from_utf8(bytes).unwrap_or_default()
}

/// Answers `text`: its length, read at `out_ptr`.
fn answer(text: String) -> usize {
    OUT.with(|out| {
        *out.borrow_mut() = text.into_bytes();
        out.borrow().len()
    })
}

/// A comment as ESTree has it: its kind, and the text between its markers.
#[derive(Serialize)]
struct EstreeComment<'a> {
    r#type: &'static str,
    value: &'a str,
    start: u32,
    end: u32,
}

/// Why `source` doesn't parse, and where: oxc's first error.
#[derive(Serialize)]
struct ParseError {
    message: String,
    start: u32,
}

/// Where `error` is: its first label's offset, in bytes.
fn offset_of(error: &OxcDiagnostic) -> u32 {
    error.labels.first().map_or(0, |label| label.offset())
}

/// `{ error }`: `message` at `start`, bytes into `source`, which it gives
/// in UTF-16 code units.
fn error_answer(source: &str, message: &str, mut start: u32) -> String {
    if let Some(mut offsets) = Utf8ToUtf16::new(source).converter() {
        offsets.convert_offset(&mut start);
    }
    let error = ParseError { message: message.to_string(), start };
    format!(
        "{{\"error\":{}}}",
        serde_json::to_string(&error).unwrap_or_else(|_| "null".to_string())
    )
}

/// `{ error }` of `diagnostics`' first error, or None when none of them
/// is an error.
fn parse_error(source: &str, diagnostics: &[OxcDiagnostic]) -> Option<String> {
    let error = diagnostics.iter().find(|error| error.severity == Severity::Error)?;
    Some(error_answer(source, &error.message, offset_of(error)))
}

/// Parses `source` (`path`, which picks the language) as oxc-parser's
/// `parseSync` does with `preserveParens: false`: JSON of `{ node, fixes,
/// comments }`, the program as TS-ESTree has it (`node`), where its
/// regular expression and BigInt literals are, whose values JSON can't
/// hold (`fixes`, as oxc-parser's), and its comments, every offset in
/// UTF-16 code units; or `{ error }` if it doesn't parse. Needs no
/// `configure`.
///
/// Its memory is the AST and the program's JSON: a file nested deep or
/// large enough to pass the memory's ceiling traps, and its caller starts
/// a fresh instance.
#[unsafe(no_mangle)]
pub extern "C" fn parse(
    path_ptr: *mut u8,
    path_len: usize,
    src_ptr: *mut u8,
    src_len: usize,
) -> usize {
    let path = input(path_ptr, path_len);
    let source = input(src_ptr, src_len);
    let source_type = SourceType::from_path(&path).unwrap_or_default();
    let allocator = Allocator::default();
    let ParserReturn { mut program, diagnostics, .. } =
        Parser::new(&allocator, &source, source_type)
            .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
            .parse();
    if let Some(error) = parse_error(&source, &diagnostics) {
        return answer(error);
    }
    let is_ts = source_type.is_typescript();
    let converter = Utf8ToUtf16::new(&source);
    converter.convert_program(&mut program);
    let mut offsets = converter.converter();
    let comments: Vec<EstreeComment> = program
        .comments
        .iter()
        .map(|comment| {
            let mut span = comment.span;
            if let Some(offsets) = offsets.as_mut() {
                offsets.convert_span(&mut span);
            }
            EstreeComment {
                r#type: match comment.kind {
                    CommentKind::Line | CommentKind::HtmlOpen | CommentKind::HtmlClose => "Line",
                    CommentKind::SingleLineBlock | CommentKind::MultiLineBlock => "Block",
                },
                value: comment.content_span().source_text(&source),
                start: span.start,
                end: span.end,
            }
        })
        .collect();
    let comments = serde_json::to_string(&comments).unwrap_or_else(|_| "[]".to_string());
    // One buffer for the answer: the program's JSON, most of it, then its
    // comments written after it, rather than both copied into a third.
    // No `range`: it is `[start, end]`, which the caller builds. The AST
    // is dropped first, so the buffer grows into the room it held.
    let mut json = program.to_estree_json_with_fixes(is_ts, false);
    drop(allocator);
    json.pop();
    json.reserve_exact(comments.len() + 16);
    json.push_str(",\"comments\":");
    json.push_str(&comments);
    json.push('}');
    answer(json)
}

/// The early errors of `source`, one expression that parsed: what oxc
/// leaves to its semantic checks rather than its parser (a legacy octal
/// literal in a module, `delete name`, `super` outside a method, a
/// private name with no class, `__proto__` set twice). They apply to the
/// expression in a program of its own, `(source\n)`, one character in.
fn early_error(allocator: &Allocator, source: &str, source_type: SourceType) -> Option<String> {
    let wrapped = allocator.alloc_str(&format!("({source}\n)"));
    let parsed = Parser::new(allocator, wrapped, source_type).parse();
    let program = allocator.alloc(parsed.program);
    let checked = SemanticBuilder::new().with_check_syntax_error(true).build(program);
    // The first in the text, as a parser that checks them meets them.
    let error = checked
        .diagnostics
        .iter()
        .chain(&parsed.diagnostics)
        .filter(|error| error.severity == Severity::Error)
        .min_by_key(|error| offset_of(error))?;
    let start = offset_of(error).saturating_sub(1).min(u32::try_from(source.len()).ok()?);
    Some(error_answer(source, &error.message, start))
}

/// Parses `source` as one expression, as oxc-parser's `parseSync` reads a
/// program but with `Parser::parse_expression`: the whole text, comments
/// around it allowed, and `{` an object, with the early errors a module's
/// parse reports (`early_error`). `path` picks the language (`.mjs`,
/// JavaScript in a module; `.ts`, TypeScript). Its parentheses are kept
/// (`ParenthesizedExpression`), which a workflow expression's check
/// reads. JSON of `{ node, fixes }`, as `parse`'s without comments, every
/// offset in UTF-16 code units; or `{ error }` if it doesn't parse.
#[unsafe(no_mangle)]
pub extern "C" fn parse_expression(
    path_ptr: *mut u8,
    path_len: usize,
    src_ptr: *mut u8,
    src_len: usize,
) -> usize {
    let path = input(path_ptr, path_len);
    let source = input(src_ptr, src_len);
    let source_type = SourceType::from_path(&path).unwrap_or_default();
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, &source, source_type)
        .with_options(ParseOptions { preserve_parens: true, ..ParseOptions::default() })
        .parse_expression();
    let mut expression = match parsed {
        Ok(expression) => expression,
        Err(diagnostics) => {
            return answer(
                parse_error(&source, &diagnostics)
                    .unwrap_or_else(|| "{\"error\":null}".to_string()),
            );
        }
    };
    if let Some(error) = early_error(&allocator, &source, source_type) {
        return answer(error);
    }
    if let Some(mut offsets) = Utf8ToUtf16::new(&source).converter() {
        offsets.visit_expression(&mut expression);
    }
    let json = CompactFixesSerializer::new(source_type.is_typescript(), false)
        .serialize_with_fixes(&expression);
    drop(allocator);
    answer(json)
}
