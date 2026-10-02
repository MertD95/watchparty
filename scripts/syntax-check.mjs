import fs from 'node:fs';
import path from 'node:path';

const files = ['extension', 'landing'].flatMap((directory) => fs.readdirSync(path.resolve(directory))
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => path.join(directory, name)));

let failed = false;

for (const name of files) {
  const fullPath = path.resolve(name);
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
