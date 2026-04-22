import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'landing', 'favicon.svg');
const OUTPUTS = [
  { size: 16, path: path.join(ROOT, 'extension', 'icons', 'icon16.png') },
  { size: 48, path: path.join(ROOT, 'extension', 'icons', 'icon48.png') },
  { size: 128, path: path.join(ROOT, 'extension', 'icons', 'icon128.png') },
  { size: 64, path: path.join(ROOT, 'landing', 'favicon.png') },
  { size: 180, path: path.join(ROOT, 'landing', 'apple-touch-icon.png') },
];

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 256, height: 256, deviceScaleFactor: 1 } });
  const svgMarkup = await fs.readFile(SVG_PATH, 'utf8');
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svgMarkup, 'utf8').toString('base64')}`;

  await page.setContent(`
    <style>
      html, body { margin: 0; background: transparent; }
      .icon { width: 256px; height: 256px; display: block; }
    </style>
    <img class="icon" src="${svgUrl}">
  `);

  const icon = page.locator('.icon');
  for (const output of OUTPUTS) {
    await icon.screenshot({
      path: output.path,
      type: 'png',
      omitBackground: true,
      scale: 'device',
    });
    if (output.size !== 256) {
      const resized = await page.evaluate(async (size) => {
        const img = document.querySelector('.icon');
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        return canvas.toDataURL('image/png');
      }, output.size);
      const data = resized.replace(/^data:image\/png;base64,/, '');
      await fs.writeFile(output.path, Buffer.from(data, 'base64'));
    }
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
