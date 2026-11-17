import path from 'node:path';
import ts from 'typescript';
import { declarations } from './source.mjs';

function isCandidate(entry, source) {
  const { node, header, kind, body } = entry;
  if (!node.name || !ts.isIdentifier(node.name) || node.name.text.startsWith('_')) return false;
  if (header.parent !== source || (kind !== 'function' && kind !== 'class')) return false;
  if (kind === 'function' && !body) return false;
  if (ts.canHaveDecorators(node) && ts.getDecorators(node)?.length) return false;
  return !header.modifiers?.some(modifier =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword ||
    modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function symbolChecker(source) {
  const options = {
    allowJs: true, checkJs: true, noEmit: true, noResolve: true, noLib: true,
    jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, types: []
  };
  const entry = path.resolve(source.fileName);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => path.resolve(file) === entry ? source : undefined;
  host.fileExists = file => path.resolve(file) === entry;
  host.readFile = file => path.resolve(file) === entry ? source.text : undefined;
  return ts.createProgram([entry], options, host).getTypeChecker();
}

export function unusedDeclarations(source, changes) {
  if (!source || source.parseDiagnostics.length || !ts.isExternalModule(source)) return [];

  const additions = new Set(changes.filter(change => change.kind === 'added')
    .map(change => JSON.stringify([change.name, change.line])));
  if (!additions.size) return [];
  const entries = declarations(source).filter(entry => isCandidate(entry, source) &&
    additions.has(JSON.stringify([entry.name, entry.line])));
  if (!entries.length) return [];

  const checker = symbolChecker(source);
  const candidates = new Map();
  for (const entry of entries) {
    const symbol = checker.getSymbolAtLocation(entry.node.name);
    if (symbol?.declarations?.length === 1) candidates.set(symbol, entry);
  }

  let dynamicScope = false;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      dynamicScope = true;
      return;
    }
    if (ts.isExportSpecifier(node) && !node.parent.parent.moduleSpecifier) {
      candidates.delete(checker.getExportSpecifierLocalTargetSymbol(node));
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ?
        checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
      const entry = candidates.get(symbol);
      if (entry && (node.pos < entry.node.pos || node.end > entry.node.end)) candidates.delete(symbol);
    }
    for (const comment of node.jsDoc ?? []) visit(comment);
    ts.forEachChild(node, visit);
  }
  visit(source);

  if (dynamicScope) return [];
  return [...candidates.values()].map(entry => ({
    line: entry.line, message: 'New module-local ' + entry.kind + ' ' + entry.name + ' has no references.'
  }));
}
