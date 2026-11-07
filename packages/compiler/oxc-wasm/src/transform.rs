//! oxc's React transform, as oxc's own `napi/transform-react` runs it
//! (`transform_impl`): the React Compiler first, on the pristine program,
//! then TypeScript removed, JSX turned into calls to `react/jsx-runtime`
//! and, for a preview, React Fast Refresh's instrumentation; or, for code
//! that isn't React, TypeScript removed alone.
//!
//! Beside the code, what the compiler's checks read of the source, from
//! the same parse: every module it names (`Site`) and its comments, which
//! the steering rules read (src/steering.ts).
use std::path::Path;

use oxc::{
    allocator::Allocator,
    ast::ast::{
        Directive, Expression, ImportDeclarationSpecifier, ImportExpression, ImportOrExportKind,
        Program, Statement, TSExternalModuleDeclaration, TSGlobalDeclaration, TSImportType,
        TSModuleReference,
    },
    ast_visit::{Visit, walk},
    codegen::{Codegen, CodegenOptions, CommentOptions},
    diagnostics::OxcDiagnostic,
    parser::Parser,
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{JsxOptions, ReactRefreshOptions, TransformOptions, Transformer},
};
use oxc_react_compiler::{CompileResult, CompilerTarget, PanicThreshold, PluginOptions};
use serde::{Deserialize, Serialize};

use crate::places;

/// How a file is transformed, as src/oxc.ts asks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    /// React code: the React Compiler and JSX. Otherwise types are
    /// removed, nothing else.
    react: bool,
    /// The React Compiler's opt-out directives (`"use no memo"`) honoured
    /// rather than refused: the kit's own files alone, which opt out only
    /// for a library the compiler lists as incompatible.
    opt_outs: bool,
    /// React Fast Refresh's instrumentation, calling these names.
    refresh: Option<RefreshNames>,
    /// The code without whitespace a reader needs.
    minify: bool,
    /// A source map of the code, as a `data:` URL.
    source_map: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RefreshNames {
    register: String,
    signature: String,
}

/// A module the source names, as written: an import, an export from
/// another module, an `import()`, a type's `import("…")`, or an ambient
/// module (`declare module "…"`, `declare global`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Site {
    /// None for an `import()` of a computed value, and `declare global`.
    specifier: Option<String>,
    line: usize,
    /// The names it takes from the module, or None when it takes a
    /// default, a namespace or everything.
    names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    type_only: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    ambient: bool,
}

/// A comment: whether it is a line comment (`//`), its text between its
/// markers, and where it starts.
#[derive(Serialize)]
struct Comment<'a> {
    #[serde(rename = "lineComment")]
    is_line: bool,
    value: &'a str,
    line: usize,
    column: usize,
}

/// What a transform found wrong, where its first label points if it has
/// one.
#[derive(Serialize)]
struct Problem {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    help: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<usize>,
}

/// What `transform` answers. Every place in it is a 1-based line and a
/// column in UTF-16 code units, 1-based too.
#[derive(Serialize)]
pub struct Transformed<'a> {
    /// None when it failed.
    code: Option<String>,
    /// Its source map, as a `data:` URL, when `Config::source_map` asks.
    #[serde(skip_serializing_if = "Option::is_none")]
    map: Option<String>,
    /// Whether it parsed: when not, nothing past its first error is known.
    parsed: bool,
    errors: Vec<Problem>,
    sites: Vec<Site>,
    comments: Vec<Comment<'a>>,
}

/// Every module `program` names (`Site`): its imports and exports from
/// other modules where a module has them, at its top level, and every
/// `import()`, type `import("…")` and ambient module anywhere in it.
struct Sites {
    found: Vec<(u32, Site)>,
}

fn site(
    at: u32,
    specifier: Option<&str>,
    names: Option<Vec<String>>,
    type_only: bool,
) -> (u32, Site) {
    (
        at,
        Site {
            specifier: specifier.map(ToString::to_string),
            line: 0,
            names,
            type_only,
            ambient: false,
        },
    )
}

impl<'a> Visit<'a> for Sites {
    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        let specifier = match &it.source {
            Expression::StringLiteral(literal) => literal.value.as_str(),
            _ => None,
        };
        self.found.push(site(it.span.start, specifier, None, false));
        walk::walk_import_expression(self, it);
    }

    fn visit_ts_import_type(&mut self, it: &TSImportType<'a>) {
        self.found.push(site(it.span.start, it.source.value.as_str(), None, true));
        walk::walk_ts_import_type(self, it);
    }

    fn visit_ts_external_module_declaration(&mut self, it: &TSExternalModuleDeclaration<'a>) {
        let (at, mut found) = site(it.span.start, it.id.value.as_str(), None, true);
        found.ambient = true;
        self.found.push((at, found));
        walk::walk_ts_external_module_declaration(self, it);
    }

    fn visit_ts_global_declaration(&mut self, it: &TSGlobalDeclaration<'a>) {
        let (at, mut found) = site(it.span.start, None, None, true);
        found.ambient = true;
        self.found.push((at, found));
        walk::walk_ts_global_declaration(self, it);
    }
}

/// The module `statement` imports or exports from, if it is one of
/// those: the names it takes (None for a default, a namespace or
/// everything), and whether it brings in types alone.
fn module_statement(statement: &Statement<'_>) -> Option<(u32, Site)> {
    match statement {
        Statement::ImportDeclaration(it) => {
            let specifiers =
                it.specifiers.as_ref().map_or(&[][..], |specifiers| specifiers.as_slice());
            let values: Vec<_> = specifiers
                .iter()
                .filter(|specifier| match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(named) => {
                        named.import_kind.is_value()
                    }
                    _ => true,
                })
                .collect();
            let type_only =
                it.import_kind.is_type() || (!specifiers.is_empty() && values.is_empty());
            let names = values
                .iter()
                .map(|specifier| match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(named) => {
                        Some(named.imported.name().to_string())
                    }
                    _ => None,
                })
                .collect::<Option<Vec<_>>>();
            Some(site(
                it.span.start,
                it.source.value.as_str(),
                if type_only { None } else { names },
                type_only,
            ))
        }
        Statement::ExportFromDeclaration(it) => {
            let values: Vec<_> =
                it.specifiers.iter().filter(|specifier| specifier.export_kind.is_value()).collect();
            let type_only =
                it.export_kind.is_type() || (!it.specifiers.is_empty() && values.is_empty());
            let names = values.iter().map(|specifier| specifier.local.name().to_string()).collect();
            Some(site(
                it.span.start,
                it.source.value.as_str(),
                if type_only { None } else { Some(names) },
                type_only,
            ))
        }
        Statement::ExportAllDeclaration(it) => {
            Some(site(it.span.start, it.source.value.as_str(), None, it.export_kind.is_type()))
        }
        // `import X = require("…")`: a value, or with `type` a type.
        Statement::TSImportEqualsDeclaration(it) => match &it.module_reference {
            TSModuleReference::ExternalModuleReference(reference) => Some(site(
                it.span.start,
                reference.expression.value.as_str(),
                None,
                it.import_kind == ImportOrExportKind::Type,
            )),
            _ => None,
        },
        _ => None,
    }
}

fn sites_of(program: &Program<'_>, source: &str) -> Vec<Site> {
    let mut sites = Sites { found: program.body.iter().filter_map(module_statement).collect() };
    sites.visit_program(program);
    let offsets: Vec<usize> = sites.found.iter().map(|(at, _)| *at as usize).collect();
    sites
        .found
        .into_iter()
        .zip(places(source, &offsets))
        .map(|((_, mut found), (line, _))| {
            found.line = line;
            found
        })
        .collect()
}

/// Why a transform failed: each of `diagnostics`, whatever its severity
/// (the React Compiler fails a file on what it rates a warning too), where
/// its first label points; or that it failed, should none say why.
/// The directives that switch the React Compiler off for the function (or
/// module) that holds them, as it matches them: exactly this text. With
/// one, the compiler only logs what it refuses, and ships the function as
/// written.
const OPT_OUTS: [&str; 2] = ["use no memo", "use no forget"];

/// Where `program` holds a directive of `OPT_OUTS`, in a function body or
/// its prologue, and which. Only a directive: a string or a comment that
/// names one is not.
#[derive(Default)]
struct OptOuts {
    found: Vec<(u32, String)>,
}

impl<'a> Visit<'a> for OptOuts {
    fn visit_directive(&mut self, it: &Directive<'a>) {
        if let Some(value) = it.expression.value.as_str()
            && OPT_OUTS.contains(&value)
        {
            self.found.push((it.span.start, value.to_string()));
        }
    }
}

/// Why `program` can't be compiled for what its directives say: each
/// directive of `OPT_OUTS` it holds, where it is.
fn opt_outs(program: &Program<'_>, source: &str) -> Vec<Problem> {
    let mut opt_outs = OptOuts::default();
    opt_outs.visit_program(program);
    let offsets: Vec<usize> = opt_outs.found.iter().map(|(at, _)| *at as usize).collect();
    opt_outs
        .found
        .into_iter()
        .zip(places(source, &offsets))
        .map(|((_, value), (line, column))| Problem {
            message: format!(
                "\"{value}\" is never in App code: it would switch the React Compiler off, and every component goes through it. Fix what the compiler refuses instead."
            ),
            help: None,
            line: Some(line),
            column: Some(column),
        })
        .collect()
}

fn problems(source: &str, diagnostics: impl IntoIterator<Item = OxcDiagnostic>) -> Vec<Problem> {
    let errors: Vec<OxcDiagnostic> = diagnostics.into_iter().collect();
    if errors.is_empty() {
        return vec![Problem {
            message: "The React Compiler couldn't compile this file.".to_string(),
            help: None,
            line: None,
            column: None,
        }];
    }
    let labelled: Vec<Option<usize>> = errors
        .iter()
        .map(|error| error.labels.first().map(|label| label.offset() as usize))
        .collect();
    let offsets: Vec<usize> = labelled.iter().map(|at| at.unwrap_or(0)).collect();
    errors
        .into_iter()
        .zip(labelled)
        .zip(places(source, &offsets))
        .map(|((error, labelled), (line, column))| Problem {
            message: error.message.to_string(),
            help: error.help.as_ref().map(ToString::to_string),
            line: labelled.map(|_| line),
            column: labelled.map(|_| column),
        })
        .collect()
}

fn comments_of<'a>(program: &Program<'_>, source: &'a str) -> Vec<Comment<'a>> {
    let offsets: Vec<usize> =
        program.comments.iter().map(|comment| comment.span.start as usize).collect();
    program
        .comments
        .iter()
        .zip(places(source, &offsets))
        .map(|(comment, (line, column))| Comment {
            is_line: comment.is_line(),
            value: comment.content_span().source_text(source),
            line,
            column,
        })
        .collect()
}

/// The React Compiler's options, as the frontend's build sets them: React
/// 19, and every error fails the file.
fn react_compiler() -> PluginOptions {
    PluginOptions {
        target: CompilerTarget::Version("19".to_string()),
        panic_threshold: PanicThreshold::AllErrors,
        ..PluginOptions::default()
    }
}

fn transform_options(config: &Config) -> TransformOptions {
    let jsx = if config.react {
        JsxOptions {
            refresh: config.refresh.as_ref().map(|names| ReactRefreshOptions {
                refresh_reg: names.register.clone(),
                refresh_sig: names.signature.clone(),
                // Readable, with no hashing: the same in every isolate.
                emit_full_signatures: true,
            }),
            ..JsxOptions::enable()
        }
    } else {
        JsxOptions::disable()
    };
    TransformOptions { jsx, ..TransformOptions::default() }
}

/// `source` (`path`, which picks the language) transformed as `config`
/// says, with the modules it names and its comments.
pub fn transform<'a>(path: &str, source: &'a str, config: &Config) -> Transformed<'a> {
    let failed =
        |parsed: bool, errors: Vec<Problem>, sites: Vec<Site>, comments: Vec<Comment<'a>>| {
            Transformed { code: None, map: None, parsed, errors, sites, comments }
        };
    let source_type = SourceType::from_path(path).unwrap_or_default();
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    if parsed.diagnostics.has_errors() {
        return failed(false, problems(source, parsed.diagnostics), Vec::new(), Vec::new());
    }
    let mut program = parsed.program;
    let sites = sites_of(&program, source);
    let comments = comments_of(&program, source);
    // Every component goes through the React Compiler: a directive that
    // would switch it off is refused before it runs.
    if config.react && !config.opt_outs {
        let refused = opt_outs(&program, source);
        if !refused.is_empty() {
            return failed(true, refused, sites, comments);
        }
    }
    let built = SemanticBuilder::new_compiler()
        .with_excess_capacity(2.0)
        .with_enum_eval(true)
        .with_build_nodes(config.react)
        .build(&program);
    if !built.diagnostics.is_empty() {
        return failed(true, problems(source, built.diagnostics), sites, comments);
    }
    let compiled = if config.react {
        match oxc_react_compiler::compile(&program, &built.semantic, &allocator, react_compiler()) {
            CompileResult::Success { output, .. } => output,
            CompileResult::Fatal { diagnostics } => {
                return failed(true, problems(source, diagnostics), sites, comments);
            }
        }
    } else {
        None
    };
    let mut scoping = built.semantic.into_scoping();
    if let Some(output) = compiled {
        output.transform(&mut program);
        scoping =
            SemanticBuilder::new().with_enum_eval(true).build(&program).semantic.into_scoping();
    }
    let transformed = Transformer::new(&allocator, Path::new(path), &transform_options(config))
        .build_with_scoping(scoping, &mut program);
    if transformed.diagnostics.has_errors() {
        return failed(true, problems(source, transformed.diagnostics), sites, comments);
    }
    let options = if config.minify {
        CodegenOptions::minify()
    } else {
        CodegenOptions { comments: CommentOptions::disabled(), ..CodegenOptions::default() }
    };
    let printed = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: config.source_map.then(|| Path::new(path).to_path_buf()),
            ..options
        })
        .build(&program);
    Transformed {
        code: Some(printed.code),
        map: printed.map.map(|map| map.to_data_url()),
        parsed: true,
        errors: Vec::new(),
        sites,
        comments,
    }
}
