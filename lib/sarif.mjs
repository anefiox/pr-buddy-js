import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ruleDefinitions } from './review-config.mjs';

const levels = { critical: 'error', warning: 'warning', info: 'note' };

export function sarif(report) {
  const ruleIndex = new Map(ruleDefinitions.map(([id], index) => [id, index]));
  const rules = ruleDefinitions.map(([id, title, severity]) => ({
    id,
    shortDescription: { text: title },
    defaultConfiguration: { level: levels[severity] }
  }));
  const results = [...report.findings, ...report.suppressed].map(finding => ({
    ...(finding.reason ? { suppressions: [{ kind: 'inSource', justification: finding.reason }] } : {}),
    ruleId: finding.id,
    ruleIndex: ruleIndex.get(finding.id),
    level: levels[finding.severity],
    message: { text: finding.message },
    locations: [{
      physicalLocation: {
        artifactLocation: {
          uri: finding.file.split('/').map(encodeURIComponent).join('/'),
          uriBaseId: '%SRCROOT%'
        },
        region: { startLine: finding.line }
      }
    }]
  }));
  return {
    $schema: 'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'PR Buddy JS', rules } },
      originalUriBaseIds: { '%SRCROOT%': { uri: pathToFileURL(report.root + path.sep).href } },
      results
    }]
  };
}
