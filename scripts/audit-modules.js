#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set(['node_modules', '.git']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function countMatches(content, regex) {
  return (content.match(regex) || []).length;
}

function analyzeFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replaceAll('\\', '/');
  const lines = content.split('\n').length;

  return {
    file: rel,
    lines,
    handleInteractionRefs: countMatches(content, /handleInteraction\s*\(/g),
    emptyCatch: countMatches(content, /catch\s*\{\s*\}/g),
    swallowCatch: countMatches(content, /\.catch\s*\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/g),
    setInterval: countMatches(content, /setInterval\s*\(/g),
    sqlAlterTable: countMatches(content, /ALTER\s+TABLE/gi),
    poolQuery: countMatches(content, /pool\.query\s*\(/g),
    processExit: countMatches(content, /process\.exit\s*\(/g),
  };
}

function riskScore(m) {
  let s = 0;
  if (m.lines > 2000) s += 4;
  else if (m.lines > 1000) s += 3;
  else if (m.lines > 500) s += 2;
  else if (m.lines > 250) s += 1;

  s += m.emptyCatch * 3;
  s += m.swallowCatch * 2;
  s += Math.min(m.setInterval, 3);
  s += Math.min(m.sqlAlterTable * 2, 4);
  s += Math.min(Math.floor(m.poolQuery / 20), 3);

  if (s >= 12) return 'high';
  if (s >= 6) return 'medium';
  return 'low';
}

const files = walk(ROOT)
  .filter((f) => !f.includes(`${path.sep}tests${path.sep}`))
  .sort();

const modules = files.map(analyzeFile).map((m) => ({ ...m, risk: riskScore(m) }));
const summary = {
  generatedAt: new Date().toISOString(),
  totalFiles: modules.length,
  highRisk: modules.filter((m) => m.risk === 'high').length,
  mediumRisk: modules.filter((m) => m.risk === 'medium').length,
  lowRisk: modules.filter((m) => m.risk === 'low').length,
  topByLines: [...modules].sort((a, b) => b.lines - a.lines).slice(0, 10),
  topByEmptyCatch: [...modules].sort((a, b) => b.emptyCatch - a.emptyCatch).slice(0, 10),
  topByPoolQuery: [...modules].sort((a, b) => b.poolQuery - a.poolQuery).slice(0, 10),
};

const output = { summary, modules };
const outPath = path.join(ROOT, 'docs/audit/modules-metrics-2026-03-19.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`Wrote ${outPath}`);
console.log(`Files analyzed: ${summary.totalFiles}`);
console.log(`Risk distribution -> high:${summary.highRisk}, medium:${summary.mediumRisk}, low:${summary.lowRisk}`);
