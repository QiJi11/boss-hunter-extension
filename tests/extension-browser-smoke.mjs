// Real Chromium MV3 smoke for the extension settings and side-panel HTML.
// Everything runs in a disposable extension copy/profile with synthetic values only.
// No BOSS account, job application, API request, or real secret is used.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = {
  key: 'sk-SYNTHETIC-ONLY-DO-NOT-USE-20261011',
  resume: 'SYNTHETIC RESUME, NO PERSONAL DATA, NO CONTACT DETAILS',
};
let folder;
let context;
let extensionId;
let worker;

before(async () => {
  folder = mkdtempSync(join(tmpdir(), 'liezhi-mv3-smoke-'));
  const extensionDir = join(folder, 'extension');
  cpSync(ROOT, extensionDir, {
    recursive: true,
    filter(source) {
      const parts = relative(ROOT, source).split(sep);
      return !parts.some((part) => part === '.git' || part === 'node_modules' || part === '.github');
    },
  });
  // The real released manifest is separately checked by the static CI.
  // This test-only copy must have no BOSS host permissions or content scripts.
  const manifestPath = join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, '猎职');
  manifest.host_permissions = [];
  manifest.content_scripts = [];
  manifest.web_accessible_resources = [];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    serviceWorkers: 'allow',
    args: [
      '--disable-extensions-except=' + extensionDir,
      '--load-extension=' + extensionDir,
    ],
  });
  // Guard against unintended outbound requests from extension-owned pages.
  await context.route('**/*', (route) => {
    const uri = new URL(route.request().url());
    if (uri.protocol === 'chrome-extension:') return route.continue();
    return route.abort('blockedbyclient');
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  extensionId = worker.url().split('/')[2];
  assert.match(extensionId, /^[a-p]{32}$/);

  await worker.evaluate(async (data) => {
    await chrome.storage.local.set({
      'apiKey': data.key,
      'textResume': data.resume,
      'sw:aiConfig': {
        provider: 'synthetic-provider',
        baseUrl: 'https://invalid.example/v1',
        apiKey: data.key,
        model: 'synthetic-test-model',
        scoreThreshold: 60,
      },
    });
  }, fixture);
});

after(async () => {
  await context?.close();
  if (folder) rmSync(folder, { recursive: true, force: true });
});

async function openOptions() {
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((value) =>
    document.getElementById('apiKey')?.value === value,
    fixture.key, { timeout: 15000 });
  return page;
}

test('real MV3 extension loads its side-panel page and branded options', { timeout: 30000 }, async () => {
  const page = await openOptions();
  try {
    assert.match(await page.title(), /猎职/);
    assert.match(await page.locator('h1.title').innerText(), /猎职/);
    const side = await context.newPage();
    try {
      await side.goto('chrome-extension://' + extensionId + '/src/popup/popup.html', { waitUntil: 'domcontentloaded' });
      await side.locator('#hdrTitle').waitFor({ timeout: 15000 });
      assert.match(await side.locator('#hdrTitle').innerText(), /猎职/);
    } finally {
      await side.close();
    }
  } finally {
    await page.close();
  }
});

test('sensitive backup is cancelled without generating a file', { timeout: 30000 }, async () => {
  const page = await openOptions();
  const messages = [];
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.dismiss();
  });
  try {
    await page.locator('#exportBtn').click();
    await page.waitForFunction(() => document.getElementById('importStatus')?.textContent?.includes('已取消导出'));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /API Key/);
    assert.match(messages[0], /明文/);
    assert.equal(downloads.length, 0);
    assert.equal(await page.locator('#exportBtn').isDisabled(), false);
  } finally {
    await page.close();
  }
});

test('sensitive backup requires explicit approval and only exports synthetic fixture', { timeout: 30000 }, async () => {
  const page = await openOptions();
  let prompted = 0;
  page.on('dialog', async (dialog) => {
    prompted++;
    await dialog.accept();
  });
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 12000 });
    await page.locator('#exportBtn').click();
    const file = await downloadPromise;
    const data = JSON.parse(readFileSync(await file.path(), 'utf8'));
    assert.equal(prompted, 1);
    assert.equal(data.aiConfig.apiKey, fixture.key);
    assert.equal(data.textResume, fixture.resume);
    assert.match(file.suggestedFilename(), /^liezhi-backup-/);
  } finally {
    await page.close();
  }
});

test('non-sensitive configuration backup does not display unnecessary warning', { timeout: 30000 }, async () => {
  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      apiKey: '',
      textResume: '',
      'sw:aiConfig': {
        provider: 'synthetic',
        baseUrl: 'https://invalid.example/v1',
        apiKey: '',
        model: 'synthetic-model',
        scoreThreshold: 60,
      },
    });
  });
  const page = await openOptionsWithoutSecret();
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  try {
    const downloadPromise = page.waitForEvent('download', { timeout: 12000 });
    await page.locator('#exportBtn').click();
    const download = await downloadPromise;
    const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(dialogs, 0);
    assert.equal(data.aiConfig.apiKey, '');
    assert.equal(data.textResume, null);
  } finally {
    await page.close();
  }
});

async function openOptionsWithoutSecret() {
  const page = await context.newPage();
  await page.goto('chrome-extension://' + extensionId + '/src/options/options.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('apiKey')?.value === '');
  return page;
}
