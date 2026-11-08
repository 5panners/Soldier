// Screenshot helper: node tools/shot.mjs out.png "debug.html?stance=ads&cam=side" [more urls...]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { startServer } from './serve.mjs';
const [out, ...urls] = process.argv.slice(2);
const server = await startServer(8765);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.VW || 900), height: Number(process.env.VH || 900) } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
let i = 0;
for (const u of urls) {
  await page.goto('http://localhost:8765/' + u);
  await page.waitForFunction("window.__done === true", null, { timeout: 90000 });
  await page.waitForTimeout(Number(process.env.WAIT || 300));
  const file = urls.length > 1 ? out.replace(/\.png$/, `_${i}.png`) : out;
  await page.screenshot({ path: file });
  i++;
}
await browser.close(); server.close();
