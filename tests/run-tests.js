const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function loadSharedScripts(storageSeed = {}) {
  const storage = { ...storageSeed };
  const context = {
    console,
    URL,
    Blob,
    Uint8Array,
    Date,
    setTimeout,
    clearTimeout,
    window: {},
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (keys == null) return { ...storage };
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
        },
      },
      permissions: {
        async contains() { return false; },
        async request() { return true; },
      },
    },
  };
  context.window = context;
  context.getResumeImages = async () => [];
  context.saveResumeImages = async () => {};
  context.clearResumeImages = async () => {};
  vm.createContext(context);
  vm.runInContext(read('src/shared/constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('src/shared/settings-backup.js'), context, { filename: 'settings-backup.js' });
  return { context, storage };
}

async function main() {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.3.3');
  assert.deepEqual(manifest.host_permissions, ['*://*.zhipin.com/*', 'https://*/*', 'http://*/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);

  const { context } = loadSharedScripts();
  const migrated = context.normalizeFeatureSettings({});
  assert.equal(migrated.aiScreeningEnabled, true);
  assert.equal(migrated.autoResumeReplyEnabled, false);
  assert.equal(migrated.autoResumeId, '');
  assert.equal(migrated.backupVersion, 2);

  const filter = context.normalizeFilterStateDefaults({});
  assert.deepEqual(Array.from(filter.selectedCities), ['101210100', '101020100', '101190400', '101210400']);
  assert.ok(Array.from(filter.customPositions).includes('AI Agent'));
  assert.ok(Array.from(filter.excludeKeywords).includes('外包'));
  assert.ok(Array.from(filter.excludeKeywords).includes('实习'));
  assert.deepEqual(Array.from(filter.jobTypes), ['全职']);
  assert.deepEqual(Array.from(filter.education), ['本科']);

  const seeded = loadSharedScripts({
    apiKey: 'sk-local-secret-value',
    textResume: 'private resume',
    resumeImages: [{ name: 'resume.png', type: 'image/png', data: [1, 2, 3] }],
    'sw:aiConfig': {
      provider: 'custom',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-local-secret-value',
      model: 'model-a',
      scoreThreshold: 80,
    },
    aiScreeningEnabled: true,
    autoResumeReplyEnabled: false,
    autoResumeId: '',
  });
  const normalBackup = await seeded.context.SettingsBackup.readBackupSnapshot();
  assert.equal(normalBackup.version, 2);
  assert.equal('apiKey' in normalBackup.aiConfig, false);
  assert.equal('textResume' in normalBackup, false);
  assert.equal('resumeImages' in normalBackup, false);
  assert.equal('autoResumeId' in normalBackup.featureSettings, false);

  const sensitiveBackup = await seeded.context.SettingsBackup.readBackupSnapshot({ sensitive: true });
  assert.equal(sensitiveBackup.aiConfig.apiKey, 'sk-local-secret-value');
  assert.equal(sensitiveBackup.textResume, 'private resume');
  assert.equal(Array.isArray(sensitiveBackup.resumeImages), true);

  const partialImport = seeded.context.SettingsBackup.normalizeImportPayload({
    version: 2,
    featureSettings: { aiScreeningEnabled: false },
  });
  await seeded.context.SettingsBackup.applySnapshotToStorage(partialImport);
  assert.equal(seeded.storage.aiScreeningEnabled, false);
  assert.equal(seeded.storage.autoResumeReplyEnabled, false);
  assert.equal(seeded.storage.autoResumeId, '');
  assert.equal(seeded.storage.apiKey, 'sk-local-secret-value');
  assert.equal(seeded.storage.textResume, 'private resume');

  const unsafeAutoImport = seeded.context.SettingsBackup.normalizeImportPayload({
    version: 2,
    featureSettings: { autoResumeReplyEnabled: true },
  });
  assert.equal(unsafeAutoImport.featureSettings.autoResumeReplyEnabled, false);

  assert.equal(
    seeded.context.SettingsBackup.getProviderOriginPattern('https://api.example.com/v1'),
    'https://api.example.com/*',
  );
  assert.equal(
    await seeded.context.SettingsBackup.requestImportProviderPermission({ aiConfig: { baseUrl: 'https://api.example.com/v1' } })
      .then((permission) => permission.origin),
    'https://api.example.com/*',
  );
  assert.throws(
    () => seeded.context.SettingsBackup.getProviderOriginPattern('file:///tmp/model'),
    /HTTP\/HTTPS/,
  );

  const sw = read('src/background/service-worker.js');
  assert.match(sw, /case 'START_SEND':[\s\S]{0,500}SEND_DISABLED/);
  assert.match(sw, /case MSG\.CONFIRM_SINGLE_SEND:/);
  assert.match(sw, /jobIds\.length !== 1/);
  assert.match(sw, /pendingSingleSendConfirmations/);
  assert.match(sw, /singleSendLaunchInProgress/);
  assert.match(sw, /reason: 'AI 岗位筛选已关闭'/);
  assert.match(sw, /isTrustedPopupSender\(sender\)/);
  assert.match(sw, /sendResult\.alreadyChatted\) sentJobIds\.delete/);
  assert.match(sw, /updateJobStatus\(item\.jobId, 'sent'\)/);
  assert.match(sw, /updateJobStatus\(_it\.jobId, 'alreadyChatted'\)/);
  assert.match(sw, /findSendResultByJobId\(msg\.payload\.jobId\)/);
  assert.doesNotMatch(sw, /updateJobStatus\(_it\.jobId, 'alreadyChatted'\);[\s\S]{0,80}state\._v6MissedJobs/);
  assert.doesNotMatch(sw, /async function recordV6Failure[\s\S]{0,180}sentJobIds\.add/);
  assert.doesNotMatch(sw, /function recordV6TerminalResult[\s\S]{0,180}sentJobIds\.add/);
  assert.match(sw, /if \(msg\.payload\.success\) \{\s*sentJobIds\.add/);
  assert.doesNotMatch(sw, /success:\s*true,\s*\n\s*alreadyChatted:\s*true/);

  const popup = read('src/popup/popup.js');
  assert.match(popup, /var TEST_BRIDGE_ENABLED=false;\s*\n\s*if\(!TEST_BRIDGE_ENABLED\)return;/);
  const popupHtml = read('src/popup/popup.html');
  assert.match(popupHtml, /id="compositeAiScreeningEnabled" checked/);
  assert.match(popupHtml, /id="compositeAutoResumeReplyEnabled"/);
  assert.match(popupHtml, /id="btnSend">逐岗复核</);
  assert.match(popupHtml, /id="singleSendOverlay"/);
  assert.match(popupHtml, /id="compositeAiApiKey" type="password"/);

  const content = read('src/content/content.js');
  assert.match(content, /autoResumeReplyEnabled === true/);
  assert.match(content, /ChatMonitor\.stop\(\)/);
  assert.match(content, /chrome\.storage\.onChanged\.addListener/);

  const chatMonitor = read('src/content/chat-monitor.js');
  assert.match(chatMonitor, /this\.resumeId/);
  assert.match(chatMonitor, /status-delivery/);
  assert.match(chatMonitor, /matchesSelectedResume/);
  assert.match(chatMonitor, /autoResumeReplyHandledKeys/);
  assert.match(chatMonitor, /this\.resumeId = nextResumeId/);
  assert.match(chatMonitor, /dataset\.zitouChecked = '1'/);
  assert.doesNotMatch(chatMonitor, /querySelector\(SELECTORS\.chatDetail\.resumeItem\)/);
  assert.doesNotMatch(sw, /_v6RepairQueue/);
  assert.match(sw, /任务中断：已建立沟通，需人工核对对话后再决定是否重试/);
  const removedRepairSymbols = /REPAIR_MISSED|WORKER_REPAIR|runRepairV6|startRepairMissed|applyRepairResult|repairSingle|hasTextInHistory|hasImageInHistory/;
  assert.doesNotMatch(sw, removedRepairSymbols);
  assert.doesNotMatch(content, removedRepairSymbols);
  assert.doesNotMatch(read('src/content/job-sender.js'), removedRepairSymbols);
  assert.doesNotMatch(read('src/shared/constants.js'), removedRepairSymbols);
  assert.doesNotMatch(read('src/content/selectors.js'), removedRepairSymbols);

  const sourceEvidence = JSON.parse(read('.source-evidence.json'));
  assert.equal(sourceEvidence.sources.length, 2);
  assert.equal(sourceEvidence.sources[0].fileCount, 38);
  assert.equal(sourceEvidence.sources[1].fileCount, 43);

  console.log('All extension policy tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
