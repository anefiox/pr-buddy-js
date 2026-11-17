import ts from 'typescript';
import { ruleIds } from './review-config.mjs';

function sourceComments(source) {
  const comments = new Map();
  function collect(ranges) {
    for (const range of ranges ?? []) comments.set(range.pos, range);
  }
  function visit(node) {
    collect(ts.getLeadingCommentRanges(source.text, node.pos));
    collect(ts.getTrailingCommentRanges(source.text, node.end));
    node.getChildren(source).forEach(visit);
  }
  visit(source);
  return [...comments.values()].sort((a, b) => a.pos - b.pos).flatMap(range => {
    const start = source.getLineAndCharacterOfPosition(range.pos);
    const lines = source.text.slice(range.pos, range.end).split('\n');
    return lines.map((raw, offset) => ({
      line: start.line + offset + 1,
      endLine: start.line + lines.length,
      inline: Boolean(source.text.slice(source.getPositionOfLineAndCharacter(start.line, 0), range.pos).trim()),
      text: raw.replace(/^\s*(?:\/\/|\/\*|\*)\s*/, '').replace(/\*\/\s*$/, '').trim()
    }));
  });
}

function nonSourceComments(text) {
  return text.split('\n').flatMap((raw, index) => {
    const match = /^\s*(?:#|\/\/|<!--)\s*(.*?)\s*(?:-->)?\s*$/.exec(raw);
    return match ? [{ line: index + 1, endLine: index + 1, inline: false, text: match[1] }] : [];
  });
}

export function applySuppressions(file, after, source, added, findings) {
  if (!after?.includes('prbuddy-ignore')) return { active: findings, suppressed: [], diagnostics: [] };
  const comments = source ? sourceComments(source) : nonSourceComments(after);
  const directives = [];
  const diagnostics = [];
  const suppressed = [];
  const issue = (line, message, severity = 'warning') => {
    diagnostics.push({ id: 'PRB900', severity, file, line, message });
  };

  for (const comment of comments) {
    const match = /^prbuddy-ignore(-file)?\b(.*)$/.exec(comment.text);
    if (!match) continue;
    const [, wholeFile, body] = match;
    const colon = body.indexOf(':');
    const ids = (colon < 0 ? body : body.slice(0, colon)).split(',').map(id => id.trim());
    const reason = colon < 0 ? '' : body.slice(colon + 1).trim();
    const changed = added.has(comment.line);
    if (!reason || ids.some(id => !ruleIds.has(id) || id === 'PRB900')) {
      if (changed) issue(comment.line, 'Suppression needs valid rule IDs and a reason. PRB900 cannot be suppressed inline.');
      continue;
    }
    directives.push({ ...comment, ids, reason, changed, used: new Set(),
      target: wholeFile ? null : comment.inline ? comment.line : comment.endLine + 1 });
  }

  const active = findings.filter(finding => {
    const matched = directives.filter(item => item.ids.includes(finding.id) &&
      (item.target === null || item.target === finding.line));
    if (!matched.length) return true;
    for (const item of matched) item.used.add(finding.id);
    const directive = matched.find(item => item.target !== null) ?? matched[0];
    suppressed.push({ ...finding, reason: directive.reason, suppressionLine: directive.line });
    return false;
  });
  for (const item of directives) {
    if (item.changed && item.ids.some(id => !item.used.has(id))) {
      issue(item.line, 'Suppression does not match an active finding for every listed rule.', 'info');
    }
  }
  return { active, suppressed, diagnostics };
}
