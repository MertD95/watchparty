import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const DIST_DIR = path.join(ROOT, 'dist', 'chrome-web-store');
const STAGE_DIR = path.join(DIST_DIR, 'extension');
const ZIP_PATH = path.join(DIST_DIR, 'watchparty-for-stremio.zip');

const EXCLUDED_NAMES = new Set(['_metadata', 'test']);
const DEV_LOCAL_LANDING_ORIGINS = new Set([
  'http://localhost:8080/*',
  'http://localhost:8090/*',
  'http://127.0.0.1:8080/*',
  'http://127.0.0.1:8090/*',
]);

async function copyDirectory(sourceDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function writeStoreManifest() {
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const optionalOrigins = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions.filter((origin) => !DEV_LOCAL_LANDING_ORIGINS.has(origin))
    : [];

  if (optionalOrigins.length > 0) {
    manifest.optional_host_permissions = optionalOrigins;
  } else {
    delete manifest.optional_host_permissions;
  }

  await fsp.writeFile(
    path.join(STAGE_DIR, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

async function createZipFromStage() {
  if (process.platform === 'win32') {
    const archiveCommand = `Compress-Archive -Path '${STAGE_DIR}\\*' -DestinationPath '${ZIP_PATH}' -Force`;
    await execFileAsync('powershell', ['-NoProfile', '-Command', archiveCommand], { windowsHide: true });
    return;
  }

  await execFileAsync('zip', ['-r', ZIP_PATH, '.'], {
    cwd: STAGE_DIR,
    windowsHide: true,
  });
}

async function ensureCleanOutput() {
  await fsp.rm(DIST_DIR, { recursive: true, force: true });
  await fsp.mkdir(STAGE_DIR, { recursive: true });
}

async function main() {
  await ensureCleanOutput();
  await copyDirectory(EXT_DIR, STAGE_DIR);
  await writeStoreManifest();
  await createZipFromStage();

  const manifest = JSON.parse(await fsp.readFile(path.join(STAGE_DIR, 'manifest.json'), 'utf8'));
  const optionalOrigins = manifest.optional_host_permissions || [];
  const removedOrigins = [...DEV_LOCAL_LANDING_ORIGINS].filter((origin) => !optionalOrigins.includes(origin));

  console.log(`Staged store extension in ${STAGE_DIR}`);
  console.log(`Created store zip at ${ZIP_PATH}`);
  if (removedOrigins.length > 0) {
    console.log(`Removed dev-only optional origins: ${removedOrigins.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
