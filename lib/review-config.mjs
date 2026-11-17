import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const severities = { info: 1, warning: 2, critical: 3 };
export const ruleDefinitions = [
  ['PRB001', 'Empty catch block', 'warning'],
  ['PRB005', 'TypeScript checking suppressed', 'warning'],
  ['PRB010', 'Hard-coded secret', 'critical'],
  ['PRB011', 'Debugger statement', 'warning'],
  ['PRB101', 'Behavior changed without test edits', 'warning'],
  ['PRB103', 'Skipped, focused, or TODO test', 'warning'],
  ['PRB201', 'Build or CI configuration changed', 'info'],
  ['PRB202', 'npm dependency added', 'info'],
  ['PRB301', 'Unused module-local declaration', 'warning'],
  ['PRB302', 'Duplicate function body', 'warning'],
  ['PRB900', 'Invalid or unused suppression', 'warning']
];
export const ruleIds = new Set(ruleDefinitions.map(([id]) => id));

export function reviewConfig(text, file = 'prbuddy.json') {
  const parsed = ts.parseConfigFileTextToJson(file, text ?? '{}');
  if (parsed.error) throw new Error(file + ': ' + ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const value = parsed.config;
  const object = input => input && typeof input === 'object' && !Array.isArray(input);
  if (!object(value) || Object.keys(value).some(key => !['ignore', 'rules', 'failOn'].includes(key))) {
    throw new Error(file + ' must be an object with ignore, rules, or failOn.');
  }
  const { ignore = [], rules = {}, failOn } = value;
  if (!Array.isArray(ignore) || ignore.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
    throw new Error('ignore must be an array of nonempty glob patterns.');
  }
  if (failOn !== undefined && !Object.hasOwn(severities, failOn)) {
    throw new Error('failOn must be info, warning, or critical.');
  }
  if (!object(rules)) throw new Error('rules must be an object keyed by rule ID.');
  for (const [id, setting] of Object.entries(rules)) {
    if (!ruleIds.has(id)) throw new Error('Unknown rule: ' + id);
    if (!['on', 'off', ...Object.keys(severities)].includes(setting)) {
      throw new Error('Rule ' + id + ' must be on, off, info, warning, or critical.');
    }
  }
  const globs = ignore.map(pattern => {
    const glob = pattern.replace(/^\//, '').replace(/\/$/, '/**');
    return !pattern.startsWith('/') && !glob.includes('/') ? '**/' + glob : glob;
  });
  return { failOn, rules, ignores: file => globs.some(glob => path.posix.matchesGlob(file, glob)) };
}

export function explicitConfig(file) {
  return file === undefined ? undefined : fs.readFileSync(file, 'utf8');
}
