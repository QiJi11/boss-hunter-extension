import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const hasFile = (path) => existsSync(resolve(root, path));

test('valid MV3 manifest and required UI entrypoints', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, '猎职');
  assert.equal(manifest.action.default_title, '猎职');
  assert.ok(hasFile(manifest.background.service_worker), 'missing background service worker');
  assert.ok(hasFile(manifest.side_panel.default_path), 'missing side panel');
  assert.ok(hasFile(manifest.options_page), 'missing options page');
  for (const path of Object.values(manifest.icons)) assert.ok(hasFile(path), 'missing icon ' + path);
});

test('all registered content scripts exist', () => {
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);
  for (const entry of manifest.content_scripts) {
    assert.ok(entry.matches?.length > 0, 'content script without URL scope');
    for (const path of entry.js ?? []) assert.ok(hasFile(path), 'missing script ' + path);
  }
});

test('no debugger permission (browser connection safety boundary)', () => {
  assert.ok(!manifest.permissions.includes('debugger'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('sidePanel'));
});

test('dangerous broad host permissions remain an explicit review finding', () => {
  const broad = manifest.host_permissions.filter((p) => p === 'https://*/*' || p === 'http://*/*' || p === '<all_urls>');
  if (broad.length) console.warn('REVIEW_REQUIRED: broad host_permissions are still present; do not publish without a provider-permission audit:', broad.join(', '));
  assert.ok(manifest.host_permissions.some((p) => p.includes('zhipin.com')), 'expected scoped BOSS access');
});

test('sensitive configuration export requires explicit confirmation', () => {
  const options = readFileSync(resolve(root, 'src/options/options.js'), 'utf8');
  assert.match(options, /containsSensitiveData && !window\.confirm\(/);
  const promptIndex = options.indexOf('window.confirm(');
  const downloadIndex = options.indexOf('downloadBackup(snapshot)');
  assert.ok(promptIndex >= 0 && downloadIndex > promptIndex, 'confirmation must precede download');
});
