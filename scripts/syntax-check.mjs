import fs from 'node:fs';
import path from 'node:path';

const extensionDir = path.resolve('extension');
const files = fs.readdirSync(extensionDir)
  .filter((name) => name.endsWith('.js'))
  .sort();

let failed = false;

for (const name of files) {
  const fullPath = path.join(extensionDir, name);
  try {
    new Function(fs.readFileSync(fullPath, 'utf8'));
    console.log(`OK ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

if (failed) {
  process.exit(1);
}
