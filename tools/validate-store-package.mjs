import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

// Read the actual ZIP, not a potentially different source manifest. The store
// builder creates ordinary single-disk ZIPs; unsupported formats fail closed.
export function readStorePackage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22) throw new Error('Invalid store ZIP.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported store ZIP.');
  const count = bytes.readUInt16LE(end + 10);
  if (!count || count === 65535 || bytes.readUInt16LE(end + 8) !== count) throw new Error('Unsupported store ZIP entries.');
  const entries = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  const directoryEnd = offset + bytes.readUInt32LE(end + 12);
  if (directoryEnd !== end) throw new Error('Invalid store ZIP directory.');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid store ZIP entry.');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const expandedSize = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)) throw new Error('Unsupported store ZIP entry.');
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString('utf8');
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').includes('..') || entries.has(name)) {
      throw new Error('Unsafe or duplicate path in store ZIP.');
    }
    if (name.split('/').some(part => ['_metadata', 'types', 'node_modules'].includes(part))) throw new Error('Development-only files found in store ZIP.');
    entries.set(name, { localOffset, size, expandedSize, method });
    offset = next;
  }
  if (offset !== directoryEnd) throw new Error('Invalid store ZIP directory size.');
  const entry = entries.get('manifest.json');
  if (!entry || entry.expandedSize > 1024 * 1024) throw new Error('Missing or oversized root manifest.');
  const { localOffset, size, method, expandedSize } = entry;
  if (localOffset + 30 > end || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP manifest header.');
  const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
  if (dataOffset + size > bytes.readUInt32LE(end + 16)) throw new Error('Invalid ZIP manifest size.');
  const compressed = bytes.subarray(dataOffset, dataOffset + size);
  const decoded = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: 1024 * 1024 });
  if (decoded.length !== expandedSize) throw new Error('ZIP manifest size mismatch.');
  const manifest = JSON.parse(decoded.toString('utf8').replace(/^\uFEFF/, ''));
  if (manifest.manifest_version !== 3 || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)
    || manifest.version.split('.').some(part => Number(part) > 65535 || (part.length > 1 && part.startsWith('0')))
    || !manifest.version.split('.').some(part => Number(part) > 0)) throw new Error('Invalid MV3 store manifest version.');
  const origins = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || []),
    ...(manifest.content_scripts || []).flatMap(script => script.matches || [])];
  if (origins.some(origin => /https?:\/\/(?:localhost|127\.0\.0\.1):(?:8080|8090|8181)\//.test(origin))) throw new Error('Development host permissions found in store ZIP.');
  const resources = [manifest.background?.service_worker, manifest.options_page, manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}), ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])]),
    ...(manifest.declarative_net_request?.rule_resources || []).map(rule => rule.path),
    ...(manifest.web_accessible_resources || []).flatMap(resource => resource.resources || [])].filter(Boolean);
  if (resources.some(resource => !resource.includes('*') && !entries.has(resource))) throw new Error('A manifest resource is missing from the store ZIP.');
  return { manifest, entries: entries.size, sizeBytes: bytes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/validate-store-package.mjs <package.zip>');
    const result = readStorePackage(await fs.readFile(process.argv[2]));
    console.log(JSON.stringify({ version: result.manifest.version, entries: result.entries, sizeBytes: result.sizeBytes, valid: true }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
