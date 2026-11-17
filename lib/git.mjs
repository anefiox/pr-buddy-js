import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isGenerated } from './source.mjs';

const outputLimit = 64 * 1024 * 1024;
function git(dir, args, input) {
  try {
    return execFileSync('git', ['-C', dir, '--literal-pathspecs', ...args], {
      encoding: 'buffer', maxBuffer: outputLimit, windowsHide: true,
      input: input === undefined ? undefined : Buffer.from(input),
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(detail);
  }
}

const text = (root, args) => git(root, args).toString('utf8');
const nulFields = value => value.split('\0').slice(0, -1);
const commit = (root, ref) => text(root, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']).trim();

function defaultBase(root) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      return commit(root, ref);
    } catch {
      // Try the next conventional base ref.
    }
  }
  throw new Error('Supply a base branch or commit. No main or master ref was found.');
}

function decode(buffer) {
  if (buffer === null || buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function workingFile(root, file, maxSize = outputLimit) {
  const full = path.join(root, file);
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > maxSize) return null;
    const real = fs.realpathSync(full);
    const relative = path.relative(fs.realpathSync(root), real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return fs.readFileSync(real);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function gitFile(root, spec) {
  if (text(root, ['cat-file', '-t', spec]).trim() !== 'blob') return null;
  return git(root, ['cat-file', 'blob', spec]);
}

function indexedFiles(root, head, staged) {
  const args = staged ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', head];
  const files = new Map();
  for (const entry of nulFields(text(root, args))) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (!/^100(?:644|755)$/.test(mode) || (staged ? id !== '0' : type !== 'blob')) continue;
    files.set(entry.slice(tab + 1), staged ? type : id);
  }
  return files;
}

function* repositorySources(root, head, staged, uncommitted, include) {
  const maxSourceSize = 1024 * 1024;
  if (uncommitted) {
    const files = nulFields(text(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
    for (const file of [...new Set(files)].sort()) {
      if (include(file)) yield { file, text: decode(workingFile(root, file, maxSourceSize)) };
    }
    return;
  }

  const files = [...indexedFiles(root, head, staged)].filter(([file]) => include(file));
  const ids = [...new Set(files.map(([, id]) => id))];
  if (!ids.length) return;
  const sizes = new Map(textForBatch(root, ids).trimEnd().split('\n').map(line => {
    const [id, size] = line.split(' ');
    return [id, Number(size)];
  }));
  // Batch blob reads to keep Git process overhead low and cap each read.
  let batch = [];
  let bytes = 0;
  for (const entry of files) {
    const size = sizes.get(entry[1]);
    if (!Number.isSafeInteger(size) || size > maxSourceSize) continue;
    if (batch.length >= 512 || bytes + size > 8 * 1024 * 1024) {
      yield* readBatch(root, batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += size;
  }
  if (batch.length) yield* readBatch(root, batch);
}

function textForBatch(root, ids) {
  return git(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], ids.join('\n') + '\n')
    .toString('utf8');
}

function* readBatch(root, files) {
  const data = git(root, ['cat-file', '--batch'], files.map(([, id]) => id).join('\n') + '\n');
  let offset = 0;
  for (const [file, id] of files) {
    const end = data.indexOf(10, offset);
    const [actual, type, sizeText] = data.toString('utf8', offset, end).split(' ');
    const size = Number(sizeText);
    if (end < offset || actual !== id || type !== 'blob' || !Number.isSafeInteger(size) ||
        size < 0 || data[end + 1 + size] !== 10) {
      throw new Error('Could not read a source blob from the Git snapshot.');
    }
    yield { file, text: decode(data.subarray(end + 1, end + 1 + size)) };
    offset = end + size + 2;
  }
}

export function readChanges(dir, { base, head, staged, uncommitted, configPath }) {
  const root = text(dir, ['rev-parse', '--show-toplevel']).trimEnd();
  const headCommit = commit(root, head ?? 'HEAD');
  const baseCommit = staged ? headCommit : base ? commit(root, base) : defaultBase(root);
  const baseline = staged ? headCommit : text(root, ['merge-base', baseCommit, headCommit]).trim();
  const configSpec = baseCommit + ':prbuddy.json';
  const configEntry = configPath === undefined ?
    text(root, ['ls-tree', baseCommit, '--', 'prbuddy.json']) : '';
  if (configEntry && !/^100(?:644|755) blob /.test(configEntry)) throw new Error('prbuddy.json must be a regular file.');
  const configBuffer = configEntry ? gitFile(root, configSpec) : null;
  const configText = decode(configBuffer);
  if (configBuffer && configText === null) throw new Error('prbuddy.json must contain UTF-8 text.');
  const comparison = staged ? ['--cached', baseline] : uncommitted ? [baseline] : [baseline, headCommit];
  const fields = nulFields(text(root, [
    'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', ...comparison, '--'
  ]));
  const paths = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++][0];
    const first = fields[i++];
    if (status === 'U') throw new Error('Resolve the Git conflict in ' + first + ' before reviewing.');
    const second = status === 'R' || status === 'C' ? fields[i++] : first;
    paths.push({ status, oldFile: status === 'A' ? null : first, file: status === 'D' ? null : second });
  }
  if (uncommitted) {
    const known = new Map(paths.map(entry => [entry.file ?? entry.oldFile, entry]));
    for (const file of nulFields(text(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
      const entry = known.get(file);
      if (!entry) paths.push({ status: 'A', oldFile: null, file });
      else if (!entry.file) Object.assign(entry, { status: 'M', file });
    }
  }

  const files = paths.filter(entry => !isGenerated(entry.file ?? entry.oldFile)).map(entry => {
    const { oldFile, file } = entry;
    const before = oldFile ? gitFile(root, baseline + ':' + oldFile) : null;
    const after = file ? uncommitted ? workingFile(root, file) :
      gitFile(root, (staged ? ':' : headCommit + ':') + file) : null;
    return { ...entry, before: decode(before), after: decode(after) };
  });
  return {
    root, baseline, configText, mode: staged ? 'staged' : uncommitted ? 'working tree' : 'commits', files,
    sources: include => repositorySources(root, headCommit, staged, uncommitted, file => !isGenerated(file) && include(file))
  };
}
