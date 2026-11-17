#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { review, reviewOnline } from '../lib/review.mjs';
import { sarif } from '../lib/sarif.mjs';
import { severities } from '../lib/review-config.mjs';

const usage = 'Usage: prbuddy-js [base] [head] [--repo PATH] [--config PATH] [--online] [--staged | --uncommitted] [--json | --markdown | --sarif] [--fail-on info|warning|critical]';
const escape = value => String(value).replace(/[\\\x60*_[\]<>|&]/g, char => '&#' + char.charCodeAt(0) + ';').replace(/[\r\n]+/g, ' ');

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string', short: 'r', default: '.' },
      config: { type: 'string', short: 'c' },
      staged: { type: 'boolean' },
      uncommitted: { type: 'boolean', short: 'u' },
      json: { type: 'boolean' },
      markdown: { type: 'boolean' },
      sarif: { type: 'boolean' },
      online: { type: 'boolean' },
      'fail-on': { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log(usage);
  } else {
    const [base, head] = positionals;
    const formats = [values.json, values.markdown, values.sarif].filter(Boolean);
    if (positionals.length > 2 || (values.staged && (base || values.uncommitted)) ||
        (values.uncommitted && head) || formats.length > 1) throw new Error(usage);
    const override = values['fail-on'];
    if (override !== undefined && !Object.hasOwn(severities, override)) {
      throw new Error('--fail-on must be info, warning, or critical.');
    }
    const runReview = values.online ? reviewOnline : review;
    const report = await runReview(values.repo, {
      base, head, staged: values.staged, uncommitted: values.uncommitted, configPath: values.config
    });
    const threshold = override ?? report.failOn;
    if (values.sarif) {
      console.log(JSON.stringify(sarif(report), null, 2));
    } else if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const heading = values.markdown ? '## ' : '';
      const format = values.markdown ? escape : String;
      console.log(heading + 'PR Buddy');
      console.log(report.files.length + ' changed files · ' + report.findings.length + ' findings · ' + report.suppressed.length + ' suppressed · ' + report.mode);
      for (const file of report.files) {
        const name = file.status === 'R' ? file.oldFile + ' → ' + file.file : file.file;
        console.log('\n' + (values.markdown ? '### ' : '') + format(name) + (file.cosmetic ? ' (cosmetic)' : ''));
        for (const change of file.changes) {
          console.log('- ' + change.kind + ' · ' + format(change.name) + ' · line ' + change.line);
        }
        for (const finding of report.findings.filter(finding => finding.file === file.file)) {
          console.log('- ' + finding.severity + ' ' + finding.id + ' · line ' + finding.line + ' · ' + format(finding.message));
        }
        for (const finding of report.suppressed.filter(finding => finding.file === file.file)) {
          console.log('- suppressed ' + finding.id + ' · line ' + finding.line + ' · ' + format(finding.reason));
        }
      }
    }
    if (threshold && report.findings.some(finding => severities[finding.severity] >= severities[threshold])) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
