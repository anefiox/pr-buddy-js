import { createHash } from 'node:crypto';
import ts from 'typescript';
import { declarations, isSource, isTest } from './source.mjs';

function tokenize(node, source, tokens) {
  if (node.kind === ts.SyntaxKind.JSDocComment) return;
  const children = node.getChildren(source);
  if (children.length) {
    for (const child of children) tokenize(child, source, tokens);
  } else if (node.kind !== ts.SyntaxKind.EndOfFileToken && node.getWidth(source) > 0 &&
      (node.kind !== ts.SyntaxKind.SemicolonToken || ts.isForStatement(node.parent))) {
    tokens.push(JSON.stringify([node.kind, node.getText(source)]));
  }
}

function* functionsIn(source, file) {
  if (source.parseDiagnostics.length) return;
  for (const entry of declarations(source)) {
    if (!entry.body || (entry.kind !== 'function' && entry.kind !== 'method')) continue;
    const body = [];
    tokenize(entry.body, source, body);
    if (body.length < 40) continue;

    const callable = entry.node.initializer ?? entry.node;
    const parameters = [];
    for (const parameter of callable.parameters ?? []) tokenize(parameter, source, parameters);
    const signature = JSON.stringify([
      Boolean(callable.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)),
      Boolean(callable.asteriskToken), parameters
    ]);
    const hash = createHash('sha256').update(signature + '\0' + body.join('\0')).digest('hex');
    yield { id: JSON.stringify([file, entry.name, entry.line]), file, name: entry.name, line: entry.line,
      signature, hash, body };
  }
}

function shingles(tokens) {
  const counts = new Map();
  for (let i = 2; i < tokens.length; i++) {
    const key = tokens[i - 2] + '\0' + tokens[i - 1] + '\0' + tokens[i];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function before(a, b) {
  return a.file < b.file || (a.file === b.file &&
    (a.line < b.line || (a.line === b.line && a.name < b.name)));
}

export function duplicateFunctions(changed, repositorySources) {
  const additions = new Map();
  const signatures = new Map();
  for (const entry of changed) {
    if (!entry.after || isTest(entry.name)) continue;
    const added = new Set(entry.changes.filter(change => change.kind === 'added')
      .map(change => JSON.stringify([entry.name, change.name, change.line])));
    if (!added.size) continue;
    for (const candidate of functionsIn(entry.after, entry.name)) {
      if (!added.has(candidate.id)) continue;
      additions.set(candidate.id, candidate);
      if (candidate.body.length > 1200) continue;
      if (!signatures.has(candidate.signature)) signatures.set(candidate.signature, new Map());
      const index = signatures.get(candidate.signature);
      for (const [shingle, count] of shingles(candidate.body)) {
        if (!index.has(shingle)) index.set(shingle, []);
        index.get(shingle).push({ candidate, count });
      }
    }
  }
  if (!additions.size) return new Map();

  const exactQueries = new Map();
  for (const candidate of additions.values()) {
    if (!exactQueries.has(candidate.hash)) exactQueries.set(candidate.hash, []);
    exactQueries.get(candidate.hash).push(candidate);
  }
  function eligible(reference, candidate) {
    return reference.id !== candidate.id && (!additions.has(reference.id) || before(reference, candidate));
  }

  function select(candidate, reference, similarity, exact) {
    const best = candidate.match;
    if (best && (best.exact && !exact || best.exact === exact && best.similarity > similarity)) return;
    if (best && best.exact === exact && best.similarity === similarity) {
      const priorIsNew = additions.has(best.reference.id);
      const currentIsNew = additions.has(reference.id);
      if ((!priorIsNew && currentIsNew) || (priorIsNew === currentIsNew && !before(reference, best.reference))) return;
    }
    candidate.match = { reference: { id: reference.id, name: reference.name, file: reference.file, line: reference.line },
      similarity, exact };
  }

  for (const { file, text } of repositorySources()) {
    if (!isSource(file) || isTest(file) || !text) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const reference of functionsIn(source, file)) {
      for (const candidate of exactQueries.get(reference.hash) ?? []) {
        if (eligible(reference, candidate)) select(candidate, reference, 1, true);
      }
      const index = signatures.get(reference.signature);
      if (!index || reference.body.length > 1200) continue;
      const overlap = new Map();
      const referenceSize = reference.body.length - 2;
      for (const [shingle, count] of shingles(reference.body)) {
        for (const { candidate, count: candidateCount } of index.get(shingle) ?? []) {
          if (candidate.match?.exact || !eligible(reference, candidate)) continue;
          overlap.set(candidate, (overlap.get(candidate) ?? 0) + Math.min(count, candidateCount));
        }
      }
      for (const [candidate, shared] of overlap) {
        const similarity = (2 * shared) / (referenceSize + candidate.body.length - 2);
        if (similarity >= 0.8) select(candidate, reference, similarity, false);
      }
    }
  }

  const findings = new Map();
  for (const candidate of additions.values()) {
    if (!candidate.match) continue;
    const { reference, similarity, exact } = candidate.match;
    if (!findings.has(candidate.file)) findings.set(candidate.file, []);
    const relation = exact ? ' duplicates ' : ' is ' + Math.floor(similarity * 100) + '% similar to ';
    findings.get(candidate.file).push({
      line: candidate.line, severity: exact ? 'warning' : 'info',
      message: candidate.name + relation + reference.name + ' at ' + reference.file + ':' + reference.line + '.'
    });
  }
  return findings;
}
