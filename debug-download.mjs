import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:3008';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    const origOpen = window.open;
    window.open = function(url, ...args) {
      console.log('[window.open]', (url || '').slice(0, 200));
      return origOpen.call(this, url, ...args);
    };
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      console.log('[anchor.click]', this.href?.slice(0, 200), 'download:', this.download || '');
      return origAnchorClick.call(this);
    };
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (a && a.href) console.log('[anchor event]', a.href.slice(0, 200), 'download:', a.download || '');
    }, true);
  });

  page.on('console', msg => {
    if (msg.text().startsWith('[')) console.log(msg.text());
  });
  page.on('request', req => {
    if (req.url().includes('share') || req.url().includes('files')) {
      console.log('[REQ]', req.method(), req.url().slice(0, 150));
      if (req.postData()) console.log('  body:', req.postData()?.slice(0, 400));
    }
  });
  page.on('response', async resp => {
    if (resp.url().includes('share') || resp.url().includes('files')) {
      console.log('[RESP]', resp.status(), resp.url().slice(0, 100));
      const t = await resp.text().catch(() => '');
      console.log('  body:', t.slice(0, 300));
    }
  });

  await page.goto(`${BASE}/c/6999559a-5545-477e-bbe3-d002189acc26`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Make download buttons visible + clickable via CSS
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      .qwen-chat-package-comp-new-action-control-container-download {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
      }
      .upper-right-corner-item {
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
      }
    `;
    document.head.appendChild(style);
  });
  await page.waitForTimeout(500);

  const btns = await page.$$('.qwen-chat-package-comp-new-action-control-container-download');
  console.log('Download buttons:', btns.length);

  for (let i = 0; i < btns.length; i++) {
    console.log(`\n--- Click download ${i} ---`);
    try {
      await btns[i].scrollIntoViewIfNeeded();
      await btns[i].click({ force: true });
      await page.waitForTimeout(3000);
    } catch(e) {
      console.log('Error:', e.message.slice(0, 100));
    }
  }

  await browser.close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
