import ts from 'typescript';
import { diffLines } from 'diff';
import { readChanges } from './git.mjs';
import { explicitConfig, reviewConfig } from './review-config.mjs';
import { applySuppressions } from './suppressions.mjs';
import { duplicateFunctions } from './duplicate-functions.mjs';
import { unusedDeclarations } from './unused-declarations.mjs';
import { checkNpmRegistry } from './npm-registry.mjs';
import { declarations, isSource, isTest, lineOf } from './source.mjs';

const secrets = [
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['OpenAI or Anthropic API key', /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}\b/g],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['Azure storage key', /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g]
];

function addedLines(before, after) {
  const added = new Map();
  let line = 1;
  for (const chunk of diffLines(before ?? '', after ?? '', { stripTrailingCr: true })) {
    if (chunk.removed) continue;
    if (chunk.added) {
      const lines = chunk.value.split('\n');
      for (let i = 0; i < chunk.count; i++) added.set(line + i, lines[i]);
    }
    line += chunk.count;
  }
  return added;
}

function fingerprint(node, source, replacements = new Map(), omit = null) {
  if (!node || node === omit) return '';
  if (replacements.has(node)) return replacements.get(node);
  const parts = [];
  node.forEachChild(child => { parts.push(fingerprint(child, source, replacements, omit)); });
  if (parts.length) return '[' + node.kind + ':' + parts.join('') + ']';
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isLiteralExpression(node) ||
      ts.isJsxText(node) || ts.isTemplateLiteralToken(node)) {
    const value = ts.isStringLiteral(node) ? node.text : node.getText(source);
    return JSON.stringify([node.kind, value]);
  }
  return '[' + node.kind + ']';
}

function parse(file, value) {
  if (value === null || !file || !isSource(file)) return null;
  return ts.createSourceFile(file, value, ts.ScriptTarget.Latest, true);
}

function entries(source) {
  if (!source) return new Map();
  const result = new Map();
  const counts = new Map();
  for (const entry of declarations(source)) {
    const key = entry.kind + ':' + entry.name;
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    result.set(key + '@' + occurrence, entry);
  }
  return result;
}

function headerOf(entry, source) {
  if (ts.isVariableDeclaration(entry.node) || ts.isPropertyDeclaration(entry.node)) {
    const initializer = entry.node.initializer;
    if (entry.kind === 'function' || entry.kind === 'method') {
      return fingerprint(entry.node, source, new Map(), entry.body) + variableModifiers(entry);
    }
    return fingerprint(entry.node, source, new Map(), initializer) + variableModifiers(entry);
  }
  return fingerprint(entry.node, source, new Map(), entry.body);
}

function variableModifiers(entry) {
  if (!ts.isVariableStatement(entry.header)) return '';
  return JSON.stringify([
    entry.header.declarationList.flags & ts.NodeFlags.BlockScoped,
    entry.header.modifiers?.map(modifier => modifier.kind) ?? []
  ]);
}

function moduleFingerprint(source, members) {
  if (!source) return '';
  return fingerprint(source, source, new Map([...members.values()].map(entry => [entry.node, ''])));
}

function semanticDiff(file, before, after) {
  if (!before && !after) return { changes: [], cosmetic: false };
  // With malformed source, retain a conservative file-level change instead of
  // interpreting the parser's error recovery as a member addition or removal.
  if (before?.parseDiagnostics.length || after?.parseDiagnostics.length) {
    return { changes: file.before === file.after ? [] : [{ kind: 'source', name: '(parse error)', line: 1 }], cosmetic: false };
  }
  const previous = entries(before);
  const current = entries(after);
  const changes = [];
  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(key);
    const next = current.get(key);
    let kind;
    if (!old || !next) kind = next ? 'added' : 'removed';
    else if (!old.container && headerOf(old, before) !== headerOf(next, after)) kind = 'signature';
    else if (!old.container && fingerprint(old.body, before) !== fingerprint(next.body, after)) kind = 'behavior';
    else if (old.container) {
      const oldMembers = new Map([...previous.values()].filter(entry => entry !== old).map(entry => [entry.node, '']));
      const newMembers = new Map([...current.values()].filter(entry => entry !== next).map(entry => [entry.node, '']));
      if (fingerprint(old.node, before, oldMembers) !== fingerprint(next.node, after, newMembers)) kind = 'signature';
    }
    if (kind) changes.push({ kind, name: (next ?? old).name, line: (next ?? old).line });
  }
  if (before && after && moduleFingerprint(before, previous) !== moduleFingerprint(after, current)) {
    changes.push({ kind: 'module', name: '(module)', line: 1 });
  }
  if (!changes.length && (!before || !after)) {
    changes.push({ kind: after ? 'added' : 'removed', name: '(module)', line: 1 });
  }
  return { changes, cosmetic: !changes.length && file.before !== file.after };
}

function dependencies(value) {
  try {
    const pkg = JSON.parse(value ?? '{}');
    return new Map(['devDependencies', 'peerDependencies', 'dependencies', 'optionalDependencies']
      .flatMap(field => {
        const list = pkg?.[field];
        return list && typeof list === 'object' && !Array.isArray(list) ? Object.entries(list) : [];
      }));
  } catch {
    return null;
  }
}

function sourceFindings(source, added, emit) {
  function changed(node) { return added.has(lineOf(node, source)); }
  function visit(node) {
    if (ts.isDebuggerStatement(node) && changed(node)) {
      emit('PRB011', 'warning', lineOf(node, source), 'Debugger statement added.');
    }
    if (ts.isCatchClause(node) && node.block.statements.length === 0 &&
        !node.block.getText(source).slice(1, -1).trim() && (changed(node) || changed(node.block))) {
      emit('PRB001', 'warning', lineOf(node, source), 'Empty catch block added.');
    }
    if (isTest(source.fileName) && ts.isCallExpression(node) && changed(node) &&
        /^(?:test|it|describe)\.(?:skip|only|todo)$|^[fx](?:it|test|describe)$/.test(node.expression.getText(source))) {
      emit('PRB103', 'warning', lineOf(node, source), 'Test or suite is skipped, focused, or marked TODO.');
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function prepareReview(dir, options) {
  const snapshot = readChanges(dir, options);
  const config = reviewConfig(explicitConfig(options.configPath) ?? snapshot.configText, options.configPath);
  const changedFiles = snapshot.files.filter(file => !config.ignores(file.file ?? file.oldFile));
  const newDependencies = new Map();
  if (config.rules.PRB202 !== 'off') {
    for (const file of changedFiles) {
      if (!file.file || !/(?:^|\/)package\.json$/.test(file.file)) continue;
      const old = dependencies(file.before);
      const next = dependencies(file.after);
      if (!old || !next) continue;
      const additions = [...next].filter(([name]) => !old.has(name)).sort(([a], [b]) => (a > b) - (a < b));
      if (additions.length) newDependencies.set(file.file, additions.map(([name, spec]) => ({
        name, spec: typeof spec === 'string' ? spec.trim() : spec
      })));
    }
  }
  return { snapshot, config, changedFiles, newDependencies };
}

export function review(dir, options) {
  return analyzeReview(prepareReview(dir, options));
}

export async function reviewOnline(dir, options, fetchMetadata) {
  const prepared = prepareReview(dir, options);
  const registry = await checkNpmRegistry([...prepared.newDependencies.values()].flat(), fetchMetadata);
  return analyzeReview(prepared, registry);
}

function analyzeReview({ snapshot, config, changedFiles, newDependencies }, registry = new Map()) {
  const findings = [];
  const suppressed = [];
  const files = [];
  const touchedTests = changedFiles.some(file => isTest(file.file ?? file.oldFile));
  const configuredRules = (id, severity) => {
    const setting = Object.hasOwn(config.rules, id) ? config.rules[id] : 'on';
    return setting === 'on' ? severity : setting;
  };
  const analyzed = changedFiles.map(file => {
    const name = file.file ?? file.oldFile;
    const before = parse(file.oldFile, file.before);
    const after = parse(file.file, file.after);
    return { file, name, after, ...semanticDiff(file, before, after) };
  });
  const duplicates = configuredRules('PRB302', 'warning') === 'off' ? new Map() :
    duplicateFunctions(analyzed, () => snapshot.sources(file => isSource(file) && !isTest(file) && !config.ignores(file)));
  for (const { file, name, after, changes, cosmetic } of analyzed) {
    files.push({ file: name, oldFile: file.oldFile, status: file.status, changes, cosmetic });
    const added = addedLines(file.before, file.after);
    const pending = [];
    const emit = (id, severity, line, message) => {
      const level = configuredRules(id, severity);
      if (level !== 'off') pending.push({ id, severity: level, file: name, line, message });
    };

    if (after) sourceFindings(after, added, emit);
    if (!isTest(name) && !touchedTests && changes.some(change => change.kind === 'behavior')) {
      emit('PRB101', 'warning', changes.find(change => change.kind === 'behavior').line, 'Behavior changed with no test files touched.');
    }
    for (const [line, value] of added) {
      const credential = secrets.find(([, pattern]) =>
        [...value.matchAll(pattern)].some(match => !/example/i.test(match[0])));
      if (credential) emit('PRB010', 'critical', line, 'Possible hard-coded ' + credential[0] + '.');
      if (after && /^\s*\/\/\s*@ts-(?:ignore|nocheck)\b/.test(value)) {
        emit('PRB005', 'warning', line, 'TypeScript checking suppressed.');
      }
    }
    for (const dependency of newDependencies.get(name) ?? []) {
      const line = [...added].find(([, value]) => value.includes(JSON.stringify(dependency.name)))?.[0] ?? 1;
      const lookup = registry.get(dependency);
      emit('PRB202', lookup?.severity ?? 'info', line, lookup?.message ?? 'npm dependency added.');
    }
    if (/^\.github\/workflows\/|(?:^|\/)(?:prbuddy\.json|tsconfig(?:\.[^/]+)?\.json|eslint\.config\.[^/]+)$/.test(name)) {
      emit('PRB201', 'info', 1, 'CI, compiler, or lint configuration changed.');
    }
    if (configuredRules('PRB301', 'warning') !== 'off' && !isTest(name)) {
      for (const finding of unusedDeclarations(after, changes)) {
        emit('PRB301', 'warning', finding.line, finding.message);
      }
    }
    for (const duplicate of duplicates.get(name) ?? []) {
      emit('PRB302', duplicate.severity, duplicate.line, duplicate.message);
    }
    const review = applySuppressions(name, file.after, after, added, pending);
    findings.push(...review.active);
    for (const finding of review.suppressed) {
      const reason = secrets.reduce((value, [, pattern]) => value.replace(pattern, '[redacted]'), finding.reason);
      suppressed.push({ ...finding, reason });
    }
    for (const diagnostic of review.diagnostics) {
      const severity = configuredRules(diagnostic.id, diagnostic.severity);
      if (severity !== 'off') findings.push({ ...diagnostic, severity });
    }
  }
  const compare = (a, b) => (a.file > b.file) - (a.file < b.file) || a.line - b.line || a.id.localeCompare(b.id, 'en');
  findings.sort(compare);
  suppressed.sort(compare);
  return { root: snapshot.root, baseline: snapshot.baseline, mode: snapshot.mode,
    files, findings, suppressed, failOn: config.failOn };
}
