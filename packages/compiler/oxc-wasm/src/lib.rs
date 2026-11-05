//! oxlint's linter and oxfmt's formatter, for App code in an isolate: a
//! threadless wasm32-wasip1 module with no file system, which src/oxc.ts
//! loads. oxlint and oxfmt publish no WebAssembly build of either (their
//! JS plugins and parallel runtime need native threads), so this is the
//! thin layer their own playground has over the same crates: it parses
//! and lints a file as oxlint's runtime does (`service/runtime.rs`),
//! fixes as `oxlint --fix` does, and formats as `oxfmt` does. It also
//! parses a file for ESLint as oxc-parser does (napi/parser), with the
//! tokens oxc-parser gives only by raw transfer, which needs 64-bit memory:
//! the compiler's design lint parses with it (src/eslint-parser.ts).
//!
//! Delete this crate once oxc publishes a threadless WebAssembly build of
//! its linter and formatter, as it does for its parser (`oxc-parser/workerd`).
//!
//! The calls are plain C ABI: text goes in through `alloc` (owned and
//! freed by the callee), and the answer is read from `out_ptr` for the
//! length a call returns. Each file gets its own arena, dropped after it,
//! so memory grows with the largest file, not with how many are linted.
//!
//! A call that traps (a panic, which aborts; the stack or the memory's
//! ceiling, build.sh, run out on a file nested too deep or too large)
//! leaves the instance's stack pointer, allocator and cells where they
//! were: src/oxc.ts never calls it again, and starts a fresh one.
use std::{cell::RefCell, path::Path, sync::Arc};

use oxc::{
    allocator::Allocator,
    ast::CommentKind,
    ast_visit::utf8_to_utf16::Utf8ToUtf16,
    diagnostics::Severity,
    parser::{ParseOptions, Parser, ParserReturn, config::RuntimeParserConfig},
    semantic::SemanticBuilder,
    span::SourceType,
};
use oxc_estree_tokens::{ESTreeTokenOptions, to_estree_tokens_json};
use oxc_formatter::{
    ArrowParentheses, BracketSameLine, BracketSpacing, JsFormatOptions, QuoteProperties,
    QuoteStyle, Semicolons, SortImportsOptions, SortOrder, TrailingCommas,
};
use oxc_formatter_core::{IndentStyle, IndentWidth, LineEnding, LineWidth};
use oxc_linter::{
    ConfigStore, ConfigStoreBuilder, ContextSubHost, ContextSubHostOptions, ExternalPluginStore,
    FixKind, Fixer, LintOptions, Linter, Message, ModuleRecord, Oxlintrc,
    oxc_code_short_canonical_name,
};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

/// What `configure` sets up: a linter that reports, one that makes the
/// fixes `oxlint --fix` makes, and oxfmt's options.
struct Tools {
    report: Linter,
    fix: Linter,
    format: JsFormatOptions,
}

thread_local! {
    static TOOLS: RefCell<Option<Tools>> = const { RefCell::new(None) };
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

fn linter(oxlintrc: &str, fix: FixKind) -> Result<Linter, String> {
    let mut store = ExternalPluginStore::default();
    let oxlintrc = Oxlintrc::from_string(oxlintrc).map_err(|error| error.to_string())?;
    let config = ConfigStoreBuilder::from_oxlintrc(false, oxlintrc, None, &mut store, None)
        .map_err(|error| error.to_string())?
        .build(&mut store)
        .map_err(|error| error.to_string())?;
    Ok(Linter::new(
        LintOptions { fix, ..LintOptions::default() },
        ConfigStore::new(config, FxHashMap::default(), store),
        None,
    ))
}

/// oxfmt's config keys this module formats with, as `.oxfmtrc.json`
/// names them. Any other key is refused, so an option oxfmt has and this
/// doesn't map can't pass unnoticed.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormatConfig {
    arrow_parens: Option<String>,
    bracket_same_line: Option<bool>,
    bracket_spacing: Option<bool>,
    /// Only "off": formatting a template's CSS or GraphQL is a host's
    /// service in oxfmt, which this module doesn't have.
    embedded_language_formatting: Option<String>,
    end_of_line: Option<String>,
    jsx_single_quote: Option<bool>,
    print_width: Option<u16>,
    quote_props: Option<String>,
    semi: Option<bool>,
    single_quote: Option<bool>,
    sort_imports: Option<SortImportsConfig>,
    tab_width: Option<u8>,
    trailing_comma: Option<String>,
    use_tabs: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SortImportsConfig {
    ignore_case: Option<bool>,
    newlines_between: Option<bool>,
    order: Option<String>,
}

/// `config` as oxfmt turns its config into the formatter's options
/// (apps/oxfmt `to_oxc_formatter`).
fn format_options(config: &str) -> Result<JsFormatOptions, String> {
    let config: FormatConfig = serde_json::from_str(config).map_err(|error| error.to_string())?;
    let mut options = JsFormatOptions::default();
    if config.embedded_language_formatting.as_deref().is_some_and(|value| value != "off") {
        return Err("embeddedLanguageFormatting: only \"off\" is supported".to_string());
    }
    if let Some(use_tabs) = config.use_tabs {
        options.indent_style = if use_tabs { IndentStyle::Tab } else { IndentStyle::Space };
    }
    if let Some(width) = config.tab_width {
        options.indent_width = IndentWidth::try_from(width).map_err(|error| error.to_string())?;
    }
    if let Some(ending) = config.end_of_line {
        options.line_ending = ending.parse::<LineEnding>()?;
    }
    if let Some(width) = config.print_width {
        options.line_width = LineWidth::try_from(width).map_err(|error| error.to_string())?;
    }
    if let Some(single) = config.single_quote {
        options.quote_style = if single { QuoteStyle::Single } else { QuoteStyle::Double };
    }
    if let Some(single) = config.jsx_single_quote {
        options.jsx_quote_style = if single { QuoteStyle::Single } else { QuoteStyle::Double };
    }
    if let Some(props) = config.quote_props {
        options.quote_properties = props.parse::<QuoteProperties>()?;
    }
    if let Some(commas) = config.trailing_comma {
        options.trailing_commas = commas.parse::<TrailingCommas>()?;
    }
    if let Some(semi) = config.semi {
        options.semicolons = if semi { Semicolons::Always } else { Semicolons::AsNeeded };
    }
    if let Some(parens) = config.arrow_parens {
        // oxfmt reads Prettier's "avoid" as the formatter's "as-needed".
        let parens = if parens == "avoid" { "as-needed".to_string() } else { parens };
        options.arrow_parentheses = parens.parse::<ArrowParentheses>()?;
    }
    if let Some(spacing) = config.bracket_spacing {
        options.bracket_spacing = BracketSpacing::from(spacing);
    }
    if let Some(same_line) = config.bracket_same_line {
        options.bracket_same_line = BracketSameLine::from(same_line);
    }
    if let Some(sort) = config.sort_imports {
        let mut sort_imports = SortImportsOptions::default();
        if let Some(order) = sort.order {
            sort_imports.order = order.parse::<SortOrder>()?;
        }
        if let Some(ignore_case) = sort.ignore_case {
            sort_imports.ignore_case = ignore_case;
        }
        if let Some(newlines_between) = sort.newlines_between {
            sort_imports.newlines_between = newlines_between;
        }
        options.sort_imports = Some(sort_imports);
    }
    Ok(options)
}

/// Sets up the linters from an `.oxlintrc.json` with no `extends`, and
/// the formatter from oxfmt's config. 0, or an error (its text at
/// `out_ptr`, its length negated).
#[unsafe(no_mangle)]
pub extern "C" fn configure(
    lint_ptr: *mut u8,
    lint_len: usize,
    format_ptr: *mut u8,
    format_len: usize,
) -> i32 {
    let oxlintrc = input(lint_ptr, lint_len);
    let format = input(format_ptr, format_len);
    let tools = linter(&oxlintrc, FixKind::None).and_then(|report| {
        Ok(Tools {
            report,
            fix: linter(&oxlintrc, FixKind::SafeFix)?,
            format: format_options(&format)?,
        })
    });
    match tools {
        Ok(tools) => {
            TOOLS.with(|cell| *cell.borrow_mut() = Some(tools));
            0
        }
        Err(error) => -i32::try_from(answer(error)).unwrap_or(i32::MAX),
    }
}

/// What `linter` says of `source` (`path`), parsed as oxlint's runtime
/// parses it; None if it doesn't parse.
fn messages(linter: &Linter, path: &Path, source: &str) -> Option<Vec<Message>> {
    let source_type = SourceType::from_path(path).ok()?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            allow_return_outside_function: true,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return None;
    }
    let built = SemanticBuilder::new_linter()
        .with_check_syntax_error(true)
        .build(allocator.alloc(parsed.program));
    if !built.diagnostics.is_empty() {
        return None;
    }
    let mut semantic = built.semantic;
    semantic.set_irregular_whitespaces(parsed.irregular_whitespaces);
    let module_record = Arc::new(ModuleRecord::new(path, &parsed.module_record, &semantic));
    Some(linter.run(
        path,
        vec![ContextSubHost::new(semantic, module_record, 0, ContextSubHostOptions::default())],
        &allocator,
    ))
}

/// A finding as the isolate answers it: oxlint's name of its rule, and
/// where it is (1-based lines, and columns in UTF-16 code units).
#[derive(Serialize)]
struct Finding {
    rule: String,
    severity: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    help: Option<String>,
    line: usize,
    column: usize,
}

/// Where each of `offsets` (bytes into `source`) is, in one pass over
/// `source` whatever the number of findings: 1-based lines, and columns in
/// UTF-16 code units. An offset inside a character is placed at it.
fn places(source: &str, offsets: &[usize]) -> Vec<(usize, usize)> {
    let mut order: Vec<usize> = (0..offsets.len()).collect();
    order.sort_unstable_by_key(|&at| offsets[at]);
    let mut places = vec![(1, 1); offsets.len()];
    let (mut line, mut column) = (1, 1);
    let mut chars = source.char_indices().peekable();
    for at in order {
        while let Some(&(byte, char)) = chars.peek() {
            if byte >= offsets[at] {
                break;
            }
            if char == '\n' {
                line += 1;
                column = 1;
            } else {
                column += char.len_utf16();
            }
            chars.next();
        }
        places[at] = (line, column);
    }
    places
}

/// Lints `source` (`path`, which picks the language and the overrides
/// that apply): JSON of its findings, or `null` if it doesn't parse.
#[unsafe(no_mangle)]
pub extern "C" fn lint(path_ptr: *mut u8, path_len: usize, src_ptr: *mut u8, src_len: usize) -> usize {
    let path = input(path_ptr, path_len);
    let source = input(src_ptr, src_len);
    let found = TOOLS.with(|cell| {
        let tools = cell.borrow();
        let tools = tools.as_ref().expect("configure first");
        messages(&tools.report, Path::new(&path), &source)
    });
    let findings = found.map(|messages| {
        let offsets: Vec<usize> =
            messages.iter().map(|message| message.span.start as usize).collect();
        messages
            .into_iter()
            .zip(places(&source, &offsets))
            .map(|(message, (line, column))| Finding {
                rule: oxc_code_short_canonical_name(&message.error.code)
                    .unwrap_or_else(|| "lint".to_string()),
                severity: if message.error.severity == Severity::Error {
                    "error"
                } else {
                    "warning"
                },
                message: message.error.message.to_string(),
                help: message.error.help.as_ref().map(ToString::to_string),
                line,
                column,
            })
            .collect::<Vec<_>>()
    });
    answer(serde_json::to_string(&findings).unwrap_or_else(|_| "null".to_string()))
}

/// `source` (`path`) with the fixes `oxlint --fix` makes made, then
/// formatted as oxfmt formats it. What doesn't parse is answered as it is.
#[unsafe(no_mangle)]
pub extern "C" fn tidy(path_ptr: *mut u8, path_len: usize, src_ptr: *mut u8, src_len: usize) -> usize {
    let path = input(path_ptr, path_len);
    let source = input(src_ptr, src_len);
    let tidied = TOOLS.with(|cell| {
        let tools = cell.borrow();
        let tools = tools.as_ref().expect("configure first");
        let path = Path::new(&path);
        let Ok(source_type) = SourceType::from_path(path) else {
            return source.clone();
        };
        let fixed = match messages(&tools.fix, path, &source) {
            Some(messages) => Fixer::new(&source, messages, Some(source_type)).fix().fixed_code,
            None => return source.clone(),
        };
        let allocator = Allocator::default();
        oxc_formatter::format(&allocator, &fixed, source_type, tools.format.clone())
            .ok()
            .and_then(|formatted| formatted.print().ok())
            .map_or_else(|| fixed.to_string(), |printed| printed.into_code())
    });
    answer(tidied)
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

/// Parses `source` (`path`, which picks the language) as oxc-parser's
/// `parseSync` does with `range: true` and `preserveParens: false`: JSON of
/// `{ program, comments, tokens }`, the program and its comments as
/// TS-ESTree has them and its tokens as ESLint's, every offset in UTF-16
/// code units; or `{ error }` if it doesn't parse. Needs no `configure`.
#[unsafe(no_mangle)]
pub extern "C" fn parse(path_ptr: *mut u8, path_len: usize, src_ptr: *mut u8, src_len: usize) -> usize {
    let path = input(path_ptr, path_len);
    let source = input(src_ptr, src_len);
    let source_type = SourceType::from_path(&path).unwrap_or_default();
    let allocator = Allocator::default();
    let ParserReturn { mut program, diagnostics, tokens, .. } =
        Parser::new(&allocator, &source, source_type)
            .with_options(ParseOptions { preserve_parens: false, ..ParseOptions::default() })
            .with_config(RuntimeParserConfig::new(true))
            .parse();
    let converter = Utf8ToUtf16::new(&source);
    if let Some(error) = diagnostics.iter().find(|error| error.severity == Severity::Error) {
        let mut start =
            error.labels.first().map_or(0, |label| u32::try_from(label.offset()).unwrap_or(0));
        if let Some(mut offsets) = converter.converter() {
            offsets.convert_offset(&mut start);
        }
        let error = ParseError { message: error.message.to_string(), start };
        return answer(format!(
            "{{\"error\":{}}}",
            serde_json::to_string(&error).unwrap_or_else(|_| "null".to_string())
        ));
    }
    let is_ts = source_type.is_typescript();
    // Before the program's offsets are converted: the tokens' are read
    // against it, and converted as they are written.
    let tokens =
        to_estree_tokens_json(&tokens, &program, &source, &converter, ESTreeTokenOptions::new(is_ts));
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
    answer(format!(
        "{{\"program\":{},\"comments\":{},\"tokens\":{tokens}}}",
        program.to_estree_json(is_ts, true),
        serde_json::to_string(&comments).unwrap_or_else(|_| "[]".to_string()),
    ))
}
