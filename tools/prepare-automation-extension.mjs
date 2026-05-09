#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAutomationExtension } from './lib/automation-extension.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..');

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const sourceDir = readArg('--source', path.join(repoRoot, 'extension'));
const outputDir = readArg('--output', path.join(workspaceRoot, '.playwright-mcp', 'extension-local-hosts'));
const result = await prepareAutomationExtension({ sourceDir, outputDir });

console.log(JSON.stringify({ ok: true, ...result }, null, 2));
