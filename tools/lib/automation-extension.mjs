import fs from 'node:fs/promises';
import path from 'node:path';

const LOCAL_WATCHPARTY_ORIGIN_PATTERNS = new Set([
  'http://localhost:8080/*',
  'http://localhost:8090/*',
  'http://127.0.0.1:8080/*',
  'http://127.0.0.1:8090/*',
]);

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function isLocalWatchPartyPattern(pattern) {
  return LOCAL_WATCHPARTY_ORIGIN_PATTERNS.has(pattern);
}

function hasContentScriptFile(script, filename) {
  return Array.isArray(script?.js) && script.js.includes(filename);
}

function patchManifestForLocalAutomation(manifest) {
  const optionalHostPermissions = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions
    : [];
  const localOrigins = optionalHostPermissions.filter(isLocalWatchPartyPattern);
  if (localOrigins.length === 0) {
    throw new Error('No local WatchParty optional host permissions were found in manifest.json');
  }

  const hostPermissions = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions
    : [];

  manifest.host_permissions = unique([...hostPermissions, ...localOrigins]);
  manifest.optional_host_permissions = optionalHostPermissions.filter((pattern) => !localOrigins.includes(pattern));
  manifest.name = `${manifest.name || 'WatchParty'} (Local Automation)`;

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const bridgeScript = contentScripts.find((script) => hasContentScriptFile(script, 'content.js'));
  if (!bridgeScript) {
    throw new Error('Could not find the WatchParty landing content script in manifest.json');
  }
  bridgeScript.matches = unique([...(Array.isArray(bridgeScript.matches) ? bridgeScript.matches : []), ...localOrigins]);

  return manifest;
}

export async function prepareAutomationExtension({ sourceDir, outputDir } = {}) {
  if (!sourceDir) throw new Error('sourceDir is required');
  if (!outputDir) throw new Error('outputDir is required');

  const resolvedSource = path.resolve(sourceDir);
  const resolvedOutput = path.resolve(outputDir);
  const sourceManifestPath = path.join(resolvedSource, 'manifest.json');
  const outputManifestPath = path.join(resolvedOutput, 'manifest.json');

  const manifest = JSON.parse(await fs.readFile(sourceManifestPath, 'utf8'));
  patchManifestForLocalAutomation(manifest);

  await fs.rm(resolvedOutput, { recursive: true, force: true });
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.cp(resolvedSource, resolvedOutput, { recursive: true });
  await fs.writeFile(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    sourceDir: resolvedSource,
    outputDir: resolvedOutput,
    localOrigins: manifest.host_permissions.filter(isLocalWatchPartyPattern),
    bridgeMatches: manifest.content_scripts
      .find((script) => hasContentScriptFile(script, 'content.js'))
      ?.matches
      ?.filter(isLocalWatchPartyPattern) || [],
  };
}

export const automationExtensionConstants = {
  LOCAL_WATCHPARTY_ORIGIN_PATTERNS: [...LOCAL_WATCHPARTY_ORIGIN_PATTERNS],
};
