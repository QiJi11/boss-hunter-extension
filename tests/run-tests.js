const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

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
    ArrayBuffer,
    atob,
    crypto: webcrypto,
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
  vm.runInContext(read('src/shared/outcome-feedback.js'), context, { filename: 'outcome-feedback.js' });
  vm.runInContext(read('src/shared/greeting-safety.js'), context, { filename: 'greeting-safety.js' });
  vm.runInContext(read('src/shared/resume-image-consent.js'), context, { filename: 'resume-image-consent.js' });
  vm.runInContext(read('src/shared/settings-backup.js'), context, { filename: 'settings-backup.js' });
  return { context, storage };
}

function loadJobSender(storageSeed = {}) {
  const storage = { ...storageSeed };
  let textSendCount = 0;
  let imageSendCount = 0;
  let imageStorageReadCount = 0;
  const sentImageBytes = [];
  const context = {
    console,
    Blob,
    Uint8Array,
    ArrayBuffer,
    atob,
    crypto: webcrypto,
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    document: {
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            imageStorageReadCount += 1;
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
        },
      },
      runtime: {
        sendMessage() { return Promise.resolve(); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(read('src/shared/resume-image-consent.js'), context, { filename: 'resume-image-consent.js' });
  vm.runInContext(
    read('src/content/job-sender.js') + '\nglobalThis.__jobSender = JobSender;',
    context,
    { filename: 'job-sender.js' },
  );
  context.__jobSender.sendText = async () => {
    textSendCount += 1;
    return { success: true };
  };
  context.__jobSender.sendImage = async (blob) => {
    imageSendCount += 1;
    sentImageBytes.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
    return { success: true };
  };
  return {
    context,
    sender: context.__jobSender,
    counts() {
      return { text: textSendCount, image: imageSendCount, storageReads: imageStorageReadCount };
    },
    sentImageBytes,
  };
}

function loadPopupStateHelpers(initialState) {
  const state = { ...initialState };
  const context = {
    console,
    URL,
    Blob,
    Uint8Array,
    ArrayBuffer,
    btoa,
    setTimeout,
    clearTimeout,
    window: {},
    document: {
      addEventListener() {},
    },
    chrome: {
      runtime: {},
      storage: {
        local: {},
      },
    },
    Store: {
      get(key) { return state[key]; },
      set(key, value) { state[key] = value; },
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('src/popup/popup.js'), context, { filename: 'popup.js' });
  return { context, state };
}

function readServiceWorkerPolicy() {
  const serviceWorker = read('src/background/service-worker.js');
  const policyStart = serviceWorker.indexOf('function normalizeImageConsentKeys');
  const policyEnd = serviceWorker.indexOf('// ── #39 阶段1跳转恢复环', policyStart);
  const queueStart = serviceWorker.indexOf('function buildSendQueueV6');
  const queueEnd = serviceWorker.indexOf('// ── per-job 自定义招呼语', queueStart);
  const captchaStart = serviceWorker.indexOf('function isCurrentSingleSendQueue');
  const captchaEnd = serviceWorker.indexOf('// ── CAPTCHA 暂停后恢复投递', captchaStart);
  assert.ok(policyStart >= 0 && policyEnd > policyStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart);
  assert.ok(captchaStart >= 0 && captchaEnd > captchaStart);

  const context = {
    console,
    URL,
    crypto: webcrypto,
    Date,
    CONFIG: { RESUME_MAX_COUNT: 5 },
    DiagLogger: { info() {} },
    matchJobToPosition() { return 'AI Agent'; },
    uniqueStrings(values) {
      return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
    },
  };
  vm.createContext(context);
  vm.runInContext(read('src/shared/greeting-safety.js'), context, { filename: 'greeting-safety.js' });
  vm.runInContext(
    `const pendingSingleSendConfirmations = new Map();
     const SINGLE_SEND_CONFIRMATION_VERSION = 3;
     const SINGLE_SEND_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
     const sentJobIds = new Set();
     ${serviceWorker.slice(policyStart, policyEnd)}
     ${serviceWorker.slice(queueStart, queueEnd)}
     ${serviceWorker.slice(captchaStart, captchaEnd)}
     globalThis.__sendPolicy = {
       createSingleSendConfirmation,
       consumeSingleSendConfirmation,
       buildSendQueueV6,
       isCurrentSingleSendQueue
     };`,
    context,
    { filename: 'service-worker-policy.js' },
  );
  return context.__sendPolicy;
}

function loadOutcomeFeedbackWorker(storageSeed = {}, sendResults = [], jobs = []) {
  const storage = { ...storageSeed };
  const serviceWorker = read('src/background/service-worker.js');
  const start = serviceWorker.indexOf('function findSendResultByJobId');
  const end = serviceWorker.indexOf('// ── #39 阶段1跳转恢复环', start);
  assert.ok(start >= 0 && end > start);
  const context = {
    console,
    Date,
    URL,
    state: { sendResults, jobs },
    STORAGE_KEYS: {
      SW: {
        OUTCOME_FEEDBACK: 'sw:outcomeFeedback',
        SEND_RESULTS: 'sw:sendResults',
        JOBS: 'sw:jobs',
      },
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key in storage).map((key) => [key, storage[key]]));
          },
          async set(patch) {
            Object.assign(storage, patch);
          },
        },
      },
      runtime: {
        id: 'test-extension',
        getURL(pathname) {
          return 'chrome-extension://test-extension/' + (pathname || '');
        },
      },
    },
    findStateJobById(jobId) {
      return jobs.find((job) => String(job.id || job.jobId) === String(jobId)) || null;
    },
  };
  vm.createContext(context);
  vm.runInContext(read('src/shared/outcome-feedback.js'), context, { filename: 'outcome-feedback.js' });
  vm.runInContext(
    `${serviceWorker.slice(start, end)}
     globalThis.__outcomeFeedbackWorker = {
       getOutcomeFeedbackPromptContext,
       getJobOutcomeFeedback,
       recordJobOutcome
     };`,
    context,
    { filename: 'outcome-feedback-worker.js' },
  );
  return { worker: context.__outcomeFeedbackWorker, storage };
}

function loadWorkerSendPolicy(greetingSetting) {
  const contentScript = read('src/content/content.js');
  const workerStart = contentScript.indexOf('async function handleWorkerSend');
  const workerEnd = contentScript.indexOf('// ════════════════════════════════════════════════════════════════', workerStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);
  const callOrder = [];
  const context = {
    console,
    Date,
    uniqueStrings(values) {
      return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
    },
    async handleCheckGreetingSetting() {
      callOrder.push('check');
      return greetingSetting;
    },
    JobSender: {
      async sendSingle() {
        callOrder.push('send');
        return { success: true };
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(read('src/shared/greeting-safety.js'), context, { filename: 'greeting-safety.js' });
  vm.runInContext(
    `${contentScript.slice(workerStart, workerEnd)}
     globalThis.__handleWorkerSend = handleWorkerSend;`,
    context,
    { filename: 'content-worker-policy.js' },
  );
  return { handleWorkerSend: context.__handleWorkerSend, callOrder };
}

async function main() {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '1.4.0');
  assert.deepEqual(manifest.host_permissions, ['*://*.zhipin.com/*', 'https://*/*', 'http://*/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  manifest.content_scripts
    .filter((entry) => entry.js.includes('src/content/content.js'))
    .forEach((entry) => {
      assert.ok(
        entry.js.indexOf('src/shared/greeting-safety.js') < entry.js.indexOf('src/content/content.js'),
        'greeting-safety.js must load before content.js',
      );
    });

  const { context } = loadSharedScripts();
  const migrated = context.normalizeFeatureSettings({});
  assert.equal(migrated.aiScreeningEnabled, true);
  assert.equal(migrated.autoResumeReplyEnabled, false);
  assert.equal(migrated.autoResumeId, '');
  assert.equal(migrated.autoResumeReplyConsentVersion, 0);
  assert.equal(migrated.backupVersion, 2);
  assert.equal(migrated.outcomeFeedbackLearningEnabled, false);

  const feedback = context.JobOutcomeFeedback;
  const normalizedFeedback = feedback.normalizeRecords([
    {
      jobId: 'job-high',
      outcome: 'replied',
      scoreBand: 'high',
      recordedAt: 100,
      company: '不应保存的公司',
      chatText: '不应保存的聊天内容',
    },
    { jobId: 'job-high', outcome: 'interview', scoreBand: 'high', recordedAt: 200 },
    { jobId: 'job-low', outcome: 'notFit', scoreBand: 'low', recordedAt: 150 },
    { jobId: 'missing-outcome', scoreBand: 'mid', recordedAt: 300 },
  ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizedFeedback)),
    [
      { jobId: 'job-high', outcome: 'interview', scoreBand: 'high', recordedAt: 200 },
      { jobId: 'job-low', outcome: 'notFit', scoreBand: 'low', recordedAt: 150 },
    ],
  );
  const feedbackRecord = feedback.createRecord({ jobId: 'job-mid', outcome: 'noResponse', score: 62 });
  assert.equal(feedbackRecord.scoreBand, 'mid');
  const replacedFeedback = feedback.upsertRecord(normalizedFeedback, {
    jobId: 'job-low',
    outcome: 'replied',
    scoreBand: 'low',
    recordedAt: 300,
  });
  assert.equal(replacedFeedback.filter((record) => record.jobId === 'job-low').length, 1);
  assert.equal(replacedFeedback.find((record) => record.jobId === 'job-low').outcome, 'replied');
  const oversizedFeedback = feedback.normalizeRecords(Array.from(
    { length: feedback.MAX_RECORDS + 1 },
    (_, index) => ({
      jobId: 'job-' + index,
      outcome: 'noResponse',
      scoreBand: 'mid',
      recordedAt: index + 1,
    }),
  ));
  assert.equal(oversizedFeedback.length, feedback.MAX_RECORDS);
  assert.equal(oversizedFeedback[0].jobId, 'job-' + feedback.MAX_RECORDS);
  assert.equal(oversizedFeedback.at(-1).jobId, 'job-1');
  assert.deepEqual(
    JSON.parse(JSON.stringify(feedback.recordsByJobId(replacedFeedback, ['job-low', 'missing']))),
    { 'job-low': { jobId: 'job-low', outcome: 'replied', scoreBand: 'low', recordedAt: 300 } },
  );
  const feedbackPrompt = feedback.buildPromptContext([
    { jobId: 'sensitive-job-id', outcome: 'interview', scoreBand: 'high', recordedAt: 1, company: '秘密公司' },
    { jobId: 'other-job', outcome: 'notFit', scoreBand: 'low', recordedAt: 2, resume: '私密简历' },
  ]);
  assert.match(feedbackPrompt, /总样本 2 条/);
  assert.doesNotMatch(feedbackPrompt, /sensitive-job-id|秘密公司|私密简历/);

  const outcomeWorkerHarness = loadOutcomeFeedbackWorker(
    {
      'sw:sendResults': [{ jobId: 'job-confirmed', success: true }],
      'sw:jobs': [{ id: 'job-confirmed', aiScreen: { score: 88 } }],
    },
    [],
    [],
  );
  const storedOutcome = await outcomeWorkerHarness.worker.recordJobOutcome({
    jobId: 'job-confirmed',
    outcome: 'interview',
  });
  assert.equal(storedOutcome.record.outcome, 'interview');
  assert.equal(storedOutcome.record.scoreBand, 'high');
  assert.deepEqual(
    Object.keys(outcomeWorkerHarness.storage['sw:outcomeFeedback'][0]).sort(),
    ['jobId', 'outcome', 'recordedAt', 'scoreBand'],
  );
  await assert.rejects(
    () => outcomeWorkerHarness.worker.recordJobOutcome({ jobId: 'job-unconfirmed', outcome: 'replied' }),
    /已确认送达/,
  );
  await outcomeWorkerHarness.worker.recordJobOutcome({ jobId: 'job-confirmed', outcome: 'clear' });
  assert.deepEqual(JSON.parse(JSON.stringify(outcomeWorkerHarness.storage['sw:outcomeFeedback'])), []);

  const feedbackPromptHarness = loadOutcomeFeedbackWorker({
    'sw:outcomeFeedback': [
      { jobId: 'one', outcome: 'replied', scoreBand: 'high', recordedAt: 1 },
      { jobId: 'two', outcome: 'interview', scoreBand: 'high', recordedAt: 2 },
      { jobId: 'three', outcome: 'notFit', scoreBand: 'low', recordedAt: 3 },
      { jobId: 'four', outcome: 'noResponse', scoreBand: 'mid', recordedAt: 4 },
      { jobId: 'five', outcome: 'replied', scoreBand: 'mid', recordedAt: 5 },
    ],
  });
  const learningPrompt = await feedbackPromptHarness.worker.getOutcomeFeedbackPromptContext();
  assert.match(learningPrompt, /总样本 5 条/);
  assert.doesNotMatch(learningPrompt, /jobId|one|two|three|four|five/);

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
    autoResumeReplyConsentVersion: 0,
  });
  const normalBackup = await seeded.context.SettingsBackup.readBackupSnapshot();
  assert.equal(normalBackup.version, 2);
  assert.equal('apiKey' in normalBackup.aiConfig, false);
  assert.equal('textResume' in normalBackup, false);
  assert.equal('resumeImages' in normalBackup, false);
  assert.equal('autoResumeId' in normalBackup.featureSettings, false);
  assert.equal('outcomeFeedbackLearningEnabled' in normalBackup.featureSettings, false);

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
  assert.equal(seeded.storage.autoResumeReplyConsentVersion, 0);
  assert.equal(seeded.storage.apiKey, 'sk-local-secret-value');
  assert.equal(seeded.storage.textResume, 'private resume');

  const unsafeAutoImport = seeded.context.SettingsBackup.normalizeImportPayload({
    version: 2,
    featureSettings: {
      autoResumeReplyEnabled: true,
      autoResumeId: '在线简历-A',
      autoResumeReplyConsentVersion: 1,
    },
  });
  assert.equal(unsafeAutoImport.featureSettings.autoResumeReplyEnabled, false);
  assert.equal(unsafeAutoImport.featureSettings.autoResumeReplyConsentVersion, 0);

  seeded.storage.autoResumeReplyEnabled = true;
  seeded.storage.autoResumeReplyConsentVersion = 1;
  await seeded.context.SettingsBackup.applySnapshotToStorage({
    textResume: 'updated private resume',
  }, { preserveAutoResumeConsent: true });
  assert.equal(seeded.storage.autoResumeReplyEnabled, true);
  assert.equal(seeded.storage.autoResumeReplyConsentVersion, 1);

  await seeded.context.SettingsBackup.applySnapshotToStorage({
    version: 2,
    filterState: context.normalizeFilterStateDefaults({}),
  });
  assert.equal(seeded.storage.autoResumeReplyEnabled, false);
  assert.equal(seeded.storage.autoResumeReplyConsentVersion, 0);

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
  // 双维度筛选：prompt 含能投/能进字段，screenSingleJob 归一化两维
  assert.match(sw, /applyScore/);
  assert.match(sw, /interviewScore/);
  assert.match(sw, /能投/);
  assert.match(sw, /能进/);
  assert.match(sw, /applyScore: Math\.max\(0, Math\.min\(100, Number\(parsed\.applyScore/);
  assert.match(sw, /sendResult\.alreadyChatted\) sentJobIds\.delete/);
  assert.match(sw, /updateJobStatus\(item\.jobId, 'sent'\)/);
  assert.match(sw, /updateJobStatus\(_it\.jobId, 'alreadyChatted'\)/);
  assert.match(sw, /findSendResultByJobId\(msg\.payload\.jobId\)/);
  assert.doesNotMatch(sw, /updateJobStatus\(_it\.jobId, 'alreadyChatted'\);[\s\S]{0,80}state\._v6MissedJobs/);
  assert.doesNotMatch(sw, /async function recordV6Failure[\s\S]{0,180}sentJobIds\.add/);
  assert.doesNotMatch(sw, /function recordV6TerminalResult[\s\S]{0,180}sentJobIds\.add/);
  assert.match(sw, /if \(msg\.payload\.success\) \{\s*sentJobIds\.add/);
  assert.doesNotMatch(sw, /success:\s*true,\s*\n\s*alreadyChatted:\s*true/);
  assert.match(sw, /case MSG\.GET_JOB_OUTCOMES:/);
  assert.match(sw, /case MSG\.RECORD_JOB_OUTCOME:/);
  assert.match(sw, /findConfirmedSendResult/);
  assert.match(sw, /FEATURE_KEYS\.OUTCOME_FEEDBACK_LEARNING_ENABLED/);
  assert.match(sw, /records\.length >= 5/);
  assert.match(sw, /JobOutcomeFeedback\.createRecord/);

  const popup = read('src/popup/popup.js');
  assert.match(popup, /var TEST_BRIDGE_ENABLED=false;\s*\n\s*if\(!TEST_BRIDGE_ENABLED\)return;/);
  const popupHtml = read('src/popup/popup.html');
  assert.match(popupHtml, /id="compositeAiScreeningEnabled" checked/);
  assert.match(popupHtml, /id="compositeOutcomeFeedbackLearningEnabled"/);
  assert.match(popupHtml, /id="compositeClearOutcomeFeedbackBtn"/);
  assert.match(popupHtml, /shared\/outcome-feedback\.js/);
  assert.match(popupHtml, /id="compositeAutoResumeReplyEnabled"/);
  assert.match(popupHtml, /id="btnSend">逐岗复核</);
  assert.match(popupHtml, /id="singleSendOverlay"/);
  assert.match(popupHtml, /id="singleSendSendImages"/);
  assert.doesNotMatch(popupHtml, /id="singleSendSendImages"[^>]*checked/);
  assert.match(popupHtml, /shared\/resume-image-consent\.js/);
  assert.match(popupHtml, /BOSS 自带“自动打招呼”必须关闭/);
  assert.match(read('src/popup/events-b.js'), /single-send-image-card/);
  assert.match(popupHtml, /id="compositeAiApiKey" type="password"/);
  assert.match(read('src/options/options.html'), /<script src="\.\.\/shared\/constants\.js"><\/script>/);
  assert.match(read('src/options/options.html'), /id="outcomeFeedbackLearningEnabled"/);
  assert.match(read('src/options/options.js'), /preserveAutoResumeConsent: true/);
  manifest.content_scripts.forEach((contentScript) => {
    const senderIndex = contentScript.js.indexOf('src/content/job-sender.js');
    if (senderIndex >= 0) {
      assert.ok(contentScript.js.indexOf('src/shared/resume-image-consent.js') < senderIndex);
    }
  });

  const content = read('src/content/content.js');
  assert.match(content, /const AUTO_RESUME_REPLY_CONSENT_VERSION = 1/);
  assert.match(content, /autoResumeReplyEnabled === true/);
  assert.match(content, /autoResumeReplyConsentVersion/);
  assert.match(content, /AUTO_RESUME_REPLY_CONSENT_VERSION/);
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
  // 2026-08-08 回归：图片简历曾在未获得当前岗位许可时随文字一起发送。
  assert.match(content, /allowed: job\.sendImages === true/);
  const jobSender = read('src/content/job-sender.js');
  assert.match(jobSender, /async sendSingle\(greeting, jobId, imgOpts, textOpts\)/);
  assert.match(jobSender, /_prepareResumeImages\(jobId, imgOpts\.expectedImageKeys\)/);
  assert.match(jobSender, /image_consent_mismatch/);
  assert.match(jobSender, /actual\.length === expected\.length/);
  const eventsB = read('src/popup/events-b.js');
  assert.doesNotMatch(eventsB, /\|\|job\.aiGreeting\|\|/);
  assert.match(eventsB, /sanitizeGeneratedGreeting\(\s*customGreeting\|\|/);
  assert.match(eventsB, /seal:true/);
  assert.match(eventsB, /sendImages:payload\.sendImages/);
  assert.match(eventsB, /type:MSG\.CONFIRM_SINGLE_SEND,[\s\S]*token:token/);
  assert.doesNotMatch(eventsB, /type:MSG\.CONFIRM_SINGLE_SEND,[\s\S]{0,200}sendImages:/);
  assert.match(eventsB, /if\(custom\.noImages\)return\[\]/);
  assert.match(eventsB, /greeting:preview\.greeting/);
  const renderReview = read('src/popup/render-review.js');
  assert.match(renderReview, /item\.success!==true/);
  assert.match(renderReview, /MSG\.RECORD_JOB_OUTCOME/);
  assert.match(renderReview, /MSG\.GET_JOB_OUTCOMES/);
  assert.match(eventsB, /imageKeys:preview\.imageKeys/);
  assert.match(eventsB, /await resumeImageConsentKeys\(images\)/);
  assert.match(eventsB, /img\.src=image\.fullSrc\|\|image\.src/);
  assert.match(eventsB, /blockedNames:companyNamesForGroup\(g\)/);
  assert.match(eventsB, /blockedNames:companyNamesForGroup\(group\)\.concat/);
  assert.match(popup, /syncDefaultGroupImages\(previousImages,images\)/);
  assert.match(popup, /preserveAutoResumeConsent:true/);
  assert.match(read('src/popup/render-b.js'), /aiGreeting=sanitizeGeneratedGreeting\(aiGreeting,companyNames\)/);
  assert.doesNotMatch(sw, /\(job && job\.aiGreeting\)/);
  assert.match(sw, /imageKeys: sendImages \? normalizeImageConsentKeys\(sendOptions\.imageKeys\) : \[\]/);
  assert.match(sw, /imageKeys: normalizeImageConsentKeys\(confirmation\.imageKeys\)/);
  assert.match(sw, /greeting: String\(confirmation\.greeting \|\| ''\)\.trim\(\)/);
  assert.match(sw, /confirmedGreeting: singleSendConfirmation\.greeting/);
  assert.match(sw, /sendConfirmedImages = singleSendConfirmation\.sendImages === true/);
  assert.match(sw, /!confirmedGreeting && jcGreeting/);
  assert.match(sw, /ensureBossDefaultGreetingDisabled/);
  assert.match(sw, /evaluateBossGreetingSafety\(read\)/);
  assert.match(sw, /if \(hasConfirmedGreeting\) \{\s*\/\/ 逐岗 token 已锁定文字；此处不读取含图片 Data URL 的 ui:jobCustom。/);
  assert.match(sw, /resumeFromCaptchaPause[\s\S]*ensureBossDefaultGreetingDisabled/);
  assert.doesNotMatch(sw, /ensureGreetingEnabled|_enableGreetingViaSettingsPage|GREETING_AUTO_ENABLED/);
  assert.doesNotMatch(content, /ENABLE_GREETING_SETTING|handleEnableGreetingSetting|updateGreetingV2/);
  assert.match(content, /click:greetingBlocked/);
  assert.match(content, /GREETING_IDENTITY_REVIEW_REQUIRED/);
  assert.doesNotMatch(read('src/shared/constants.js'), /GREETING_AUTO_ENABLED|ENABLE_GREETING_SETTING/);
  assert.doesNotMatch(read('src/content/selectors.js'), /ENABLE_GREETING_SETTING/);
  assert.match(sw, /confirmationVersion: SINGLE_SEND_CONFIRMATION_VERSION/);
  assert.match(sw, /const SINGLE_SEND_CONFIRMATION_VERSION = 3/);
  assert.match(sw, /PAUSED_TASK_REVIEW_REQUIRED/);
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

  // ── 核心纯函数：matchJobToExpected（岗位归类"单一真相源"） ──
  const ctx2 = loadSharedScripts().context;
  const sendPolicy = readServiceWorkerPolicy();
  const textOnlyToken = sendPolicy.createSingleSendConfirmation({
    jobId: 'job1',
    greeting: '您好，我有 Agent 项目经验，方便沟通吗？',
    sendImages: false,
    imageKeys: ['sha256-a|resume.png'],
    blockedNames: ['陈俊豪'],
  });
  const textOnlyConfirmation = sendPolicy.consumeSingleSendConfirmation(textOnlyToken, 'job1');
  assert.equal(textOnlyConfirmation.sendImages, false);
  assert.deepEqual(Array.from(textOnlyConfirmation.imageKeys), ['sha256-a|resume.png']);
  assert.ok(textOnlyConfirmation.expiresAt > Date.now());
  assert.equal(sendPolicy.consumeSingleSendConfirmation(textOnlyToken, 'job1'), null);

  const imageToken = sendPolicy.createSingleSendConfirmation({
    jobId: 'job2',
    greeting: '您好，我有 RAG 项目经验，方便沟通吗？',
    sendImages: true,
    imageKeys: ['sha256-a|resume.png', 'sha256-b|resume-2.png'],
    blockedNames: [],
  });
  const imageConfirmation = sendPolicy.consumeSingleSendConfirmation(imageToken, 'job2');
  assert.equal(imageConfirmation.sendImages, true);
  assert.deepEqual(
    Array.from(imageConfirmation.imageKeys),
    ['sha256-a|resume.png', 'sha256-b|resume-2.png'],
  );

  const confirmedQueue = sendPolicy.buildSendQueueV6({
    jobs: [{ id: 'job1', name: 'AI Agent 工程师', company: '示例公司' }],
    pickerPositions: [],
    customPositions: [],
    greetings: { 'AI Agent': '旧组级招呼语' },
    sendGreeting: false,
    jobCustom: { job1: { customGreeting: '旧岗位级招呼语' } },
  }, ['job1'], {
    confirmedGreeting: '已复核招呼语',
    sendImages: false,
    imageKeys: ['sha256-a|resume.png'],
    blockedNames: ['陈俊豪'],
    confirmationExpiresAt: textOnlyConfirmation.expiresAt,
  });
  assert.equal(confirmedQueue[0].greeting, '已复核招呼语');
  assert.equal(confirmedQueue[0].sendImages, false);
  assert.deepEqual(Array.from(confirmedQueue[0].imageKeys), []);
  assert.equal(confirmedQueue[0].confirmationVersion, 3);
  assert.equal(confirmedQueue[0].confirmationExpiresAt, textOnlyConfirmation.expiresAt);

  assert.throws(
    () => sendPolicy.buildSendQueueV6({
      jobs: [{ id: 'job1', name: 'AI Agent 工程师', company: '新公司' }],
      pickerPositions: [],
      customPositions: [],
      greetings: {},
      sendGreeting: true,
      jobCustom: {},
    }, ['job1'], {
      confirmedGreeting: '您好，我对新公司的岗位很感兴趣，方便沟通吗？',
      sendImages: false,
      imageKeys: [],
      blockedNames: ['旧公司'],
      confirmationExpiresAt: Date.now() + 60000,
    }),
    (error) => error && error.errorCode === 'GREETING_REVIEW_REQUIRED',
  );

  const currentPausedQueue = [{
    greeting: '已复核招呼语',
    confirmationVersion: 3,
    confirmationExpiresAt: Date.now() + 60000,
    sendImages: true,
    imageKeys: ['sha256-a|resume.png'],
  }];
  assert.equal(sendPolicy.isCurrentSingleSendQueue(currentPausedQueue), true);
  const stalePausedQueueCases = [
    ['old confirmation version', [{ ...currentPausedQueue[0], confirmationVersion: 2 }]],
    ['missing approved image hashes', [{ ...currentPausedQueue[0], imageKeys: [] }]],
    ['missing confirmation expiry', [{ ...currentPausedQueue[0], confirmationExpiresAt: 0 }]],
    ['expired confirmation', [{ ...currentPausedQueue[0], confirmationExpiresAt: Date.now() - 1 }]],
    ['legacy multi-job queue', currentPausedQueue.concat(currentPausedQueue)],
  ];
  for (const [scenario, queue] of stalePausedQueueCases) {
    assert.equal(sendPolicy.isCurrentSingleSendQueue(queue), false, scenario);
  }

  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx2.evaluateBossGreetingSafety({ success: true, enabled: false }))),
    { ok: true },
  );
  assert.equal(
    ctx2.evaluateBossGreetingSafety({ success: true, enabled: true, templateId: 7 }).errorCode,
    'BOSS_DEFAULT_GREETING_ENABLED',
  );
  assert.equal(
    ctx2.evaluateBossGreetingSafety({ success: false, error: 'network' }).errorCode,
    'BOSS_GREETING_STATUS_UNKNOWN',
  );
  const workerCases = [
    {
      scenario: 'disabled greeting setting allows send',
      greetingSetting: { success: true, enabled: false },
      expiresAt: Date.now() + 60000,
      expectedSuccess: true,
      expectedOrder: ['check', 'send'],
    },
    {
      scenario: 'enabled greeting setting blocks send',
      greetingSetting: { success: true, enabled: true, templateId: 7 },
      expiresAt: Date.now() + 60000,
      expectedSuccess: false,
      expectedOrder: ['check'],
      expectedErrorCode: 'BOSS_DEFAULT_GREETING_ENABLED',
    },
    {
      scenario: 'unknown greeting setting blocks send',
      greetingSetting: { success: false, error: 'network' },
      expiresAt: Date.now() + 60000,
      expectedSuccess: false,
      expectedOrder: ['check'],
      expectedErrorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
    },
    {
      scenario: 'expired confirmation blocks before setting check',
      greetingSetting: { success: true, enabled: false },
      expiresAt: Date.now() - 1,
      expectedSuccess: false,
      expectedOrder: [],
      expectedErrorCode: 'CONFIRMATION_EXPIRED',
    },
  ];
  for (const workerCase of workerCases) {
    const workerPolicy = loadWorkerSendPolicy(workerCase.greetingSetting);
    const workerResult = await workerPolicy.handleWorkerSend({
      job: {
        jobId: 'job-worker',
        greeting: '您好，我有 Agent 项目经验，方便沟通吗？',
        blockedNames: [],
        confirmationExpiresAt: workerCase.expiresAt,
        sendImages: false,
        imageKeys: [],
      },
    });
    assert.equal(workerResult.success, workerCase.expectedSuccess, workerCase.scenario);
    assert.deepEqual(workerPolicy.callOrder, workerCase.expectedOrder, workerCase.scenario);
    if (workerCase.expectedErrorCode) {
      assert.equal(workerResult.errorCode, workerCase.expectedErrorCode, workerCase.scenario);
    }
  }
  const oldStoredImageKey = await ctx2.resumeImageConsentKey({
    name: 'resume.png',
    type: 'image/png',
    data: [1, 2, 3],
  });
  const dataUrlImageKey = await ctx2.resumeImageConsentKey({
    name: 'resume.png',
    fullSrc: 'data:image/png;base64,AQID',
  });
  assert.equal(oldStoredImageKey, dataUrlImageKey);
  assert.match(oldStoredImageKey, /^sha256-[0-9a-f]{64}\|resume\.png$/);
  const sameIdDifferentContentKey = await ctx2.resumeImageConsentKey({
    id: 'same-id',
    name: 'resume.png',
    data: [9, 9, 9],
  });
  assert.notEqual(oldStoredImageKey, sameIdDifferentContentKey);
  const previewPreferredKey = await ctx2.resumeImageConsentKey({
    name: 'resume.png',
    data: [1, 2, 3],
    fullSrc: 'data:image/png;base64,CQkJ',
  });
  const previewOnlyKey = await ctx2.resumeImageConsentKey({
    name: 'resume.png',
    fullSrc: 'data:image/png;base64,CQkJ',
  });
  assert.equal(previewPreferredKey, previewOnlyKey);

  const defaultImageA = { id: 'image-a', name: 'a.png' };
  const defaultImageB = { id: 'image-b', name: 'b.png' };
  const customImage = { id: 'custom-image', name: 'custom.png' };
  const popupHelpers = loadPopupStateHelpers({
    groups: [
      { images: [defaultImageA] },
      { images: [customImage] },
    ],
  });
  popupHelpers.context.syncDefaultGroupImages([defaultImageA], [defaultImageB]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(popupHelpers.state.groups)),
    [
      { images: [defaultImageB] },
      { images: [customImage] },
    ],
  );

  const approvedImage = {
    id: 'resume-image-1',
    name: 'resume.png',
    fullSrc: 'data:image/png;base64,AQID',
  };
  const approvedImageKey = await ctx2.resumeImageConsentKey(approvedImage);
  const noConsentSender = loadJobSender({
    resumeImages: [approvedImage],
  });
  const noConsentResult = await noConsentSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
  );
  assert.equal(noConsentResult.success, true);
  assert.deepEqual(noConsentSender.counts(), { text: 1, image: 0, storageReads: 0 });

  const mismatchSender = loadJobSender({
    'ui:jobCustom': { job1: { images: [approvedImage] } },
    resumeImages: [],
  });
  const mismatchResult = await mismatchSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
    { allowed: true, expectedImageKeys: ['other-image|resume.png'] },
    {},
  );
  assert.equal(mismatchResult.error, 'image_consent_mismatch');
  assert.deepEqual(mismatchSender.counts(), { text: 0, image: 0, storageReads: 1 });

  const replacedBytesSender = loadJobSender({
    'ui:jobCustom': {
      job1: {
        images: [{
          id: approvedImage.id,
          name: approvedImage.name,
          fullSrc: 'data:image/png;base64,CQkJ',
        }],
      },
    },
    resumeImages: [],
  });
  const replacedBytesResult = await replacedBytesSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
    { allowed: true, expectedImageKeys: [approvedImageKey] },
    {},
  );
  assert.equal(replacedBytesResult.error, 'image_consent_mismatch');
  assert.deepEqual(replacedBytesSender.counts(), { text: 0, image: 0, storageReads: 1 });

  const approvedSender = loadJobSender({
    'ui:jobCustom': { job1: { images: [approvedImage] } },
    resumeImages: [],
  });
  const approvedResult = await approvedSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
    { allowed: true, expectedImageKeys: [approvedImageKey] },
    {},
  );
  assert.equal(approvedResult.success, true);
  assert.deepEqual(approvedSender.counts(), { text: 1, image: 1, storageReads: 1 });
  assert.deepEqual(approvedSender.sentImageBytes, [[1, 2, 3]]);

  const previewPreferredImage = {
    id: 'dual-source',
    name: 'resume.png',
    data: [1, 2, 3],
    fullSrc: 'data:image/png;base64,CQkJ',
  };
  const previewPreferredSender = loadJobSender({
    'ui:jobCustom': { job1: { images: [previewPreferredImage] } },
    resumeImages: [],
  });
  const previewPreferredResult = await previewPreferredSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
    { allowed: true, expectedImageKeys: [previewPreferredKey] },
    {},
  );
  assert.equal(previewPreferredResult.success, true);
  assert.deepEqual(previewPreferredSender.sentImageBytes, [[9, 9, 9]]);

  const clearedSender = loadJobSender({
    'ui:jobCustom': { job1: { noImages: true, images: [approvedImage] } },
    resumeImages: [],
  });
  const clearedResult = await clearedSender.sender.sendSingle(
    '您好，我有相关项目经验，方便沟通吗？',
    'job1',
    { allowed: true, expectedImageKeys: [approvedImageKey] },
    {},
  );
  assert.equal(clearedResult.error, 'image_consent_mismatch');
  assert.deepEqual(clearedSender.counts(), { text: 0, image: 0, storageReads: 1 });

  const imageB = {
    id: 'resume-image-2',
    name: 'resume-2.png',
    fullSrc: 'data:image/png;base64,BAUG',
  };
  const approvedImageBKey = await ctx2.resumeImageConsentKey(imageB);
  const imageMutationCases = [
    {
      name: 'order changed',
      images: [imageB, approvedImage],
      expected: [approvedImageKey, approvedImageBKey],
    },
    {
      name: 'image added',
      images: [approvedImage, imageB],
      expected: [approvedImageKey],
    },
    {
      name: 'image removed',
      images: [approvedImage],
      expected: [approvedImageKey, approvedImageBKey],
    },
  ];
  for (const imageCase of imageMutationCases) {
    const sender = loadJobSender({
      'ui:jobCustom': { job1: { images: imageCase.images } },
      resumeImages: [],
    });
    const sendResult = await sender.sender.sendSingle(
      '您好，我有相关项目经验，方便沟通吗？',
      'job1',
      { allowed: true, expectedImageKeys: imageCase.expected },
      {},
    );
    assert.equal(sendResult.error, 'image_consent_mismatch', imageCase.name);
    assert.deepEqual(sender.counts(), { text: 0, image: 0, storageReads: 1 }, imageCase.name);
  }

  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好！我是张三，我有 Agent 与 RAG 项目经验，方便沟通吗？'),
    '您好！我有 Agent 与 RAG 项目经验，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('李经理您好，我对后端岗位很感兴趣，方便沟通吗？——张三'),
    '您好，我对后端岗位很感兴趣，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好！我是应届生，有 Agent 项目经验，方便沟通吗？'),
    '您好！我是应届生，有 Agent 项目经验，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我曾在字节跳动公司负责 RAG 项目，方便沟通吗？'),
    '您好，我曾在相关团队负责 RAG 项目，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我对星海科技的岗位很感兴趣，方便沟通吗？', ['星海科技']),
    '您好，我对相关团队的岗位很感兴趣，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我叫 Alice，有 RAG 项目经验。'),
    '您好，有 RAG 项目经验。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我是候选人张三，有后端项目经验。'),
    '您好，有后端项目经验。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我加入阿里巴巴，有后端项目经验。'),
    '您好，我加入相关团队，有后端项目经验。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我有后端项目经验。此致，张三'),
    '您好，我有后端项目经验。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，张三具备 Agent 与 RAG 项目经验，方便沟通吗？'),
    '您好，具备 Agent 与 RAG 项目经验，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，希望与李总进一步沟通岗位细节。'),
    '您好，希望与您进一步沟通岗位细节。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我服务过海尔客户，有相关交付经验。'),
    '您好，我服务过相关客户，有相关交付经验。'
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx2.extractGreetingBlockedNames('项目经历：服务过海尔客户'))),
    ['海尔'],
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，候选人张三有后端项目经验。'),
    '您好，有后端项目经验。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我与产品经理协作过，方便沟通吗？'),
    '您好，我与产品经理协作过，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，希望和王伟一起沟通岗位细节。'),
    '您好，希望和相关人员一起沟通岗位细节。'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我曾为海尔交付 RAG 项目，方便沟通吗？'),
    '您好，我曾为相关客户交付 RAG 项目，方便沟通吗？'
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我的名字是陈俊豪，有 Agent 项目经验，方便沟通吗？'),
    '您好，有 Agent 项目经验，方便沟通吗？'
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx2.extractGreetingBlockedNames('陈俊豪\n软件工程应届生\nAgent 项目'))),
    ['陈俊豪'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx2.extractGreetingBlockedNames('姓名：陈俊豪\n求职方向：AI Agent'))),
    ['陈俊豪'],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx2.extractGreetingBlockedNames('个人信息\n陈俊豪｜软件工程应届生\nAgent 项目'))),
    ['陈俊豪'],
  );
  const resumeBlockedNames = JSON.parse(JSON.stringify(ctx2.extractGreetingBlockedNames(
    '陈俊豪\n项目经历：参与过海尔数字化项目\n工作经历：在字节跳动做过 RAG 项目'
  )));
  assert.deepEqual(resumeBlockedNames, ['陈俊豪', '字节跳动', '海尔']);
  assert.equal(
    ctx2.sanitizeGeneratedGreeting(
      '您好，我参与过海尔数字化项目，希望与您沟通。',
      resumeBlockedNames,
    ),
    '您好，我参与过相关客户数字化项目，希望与您沟通。',
  );
  const supplyChainBlockedNames = JSON.parse(JSON.stringify(
    ctx2.extractGreetingBlockedNames('项目经历：服务海尔供应链')
  ));
  assert.deepEqual(supplyChainBlockedNames, ['海尔']);
  assert.equal(
    ctx2.sanitizeGeneratedGreeting('您好，我服务海尔供应链，希望与您沟通。'),
    '您好，我服务相关客户供应链，希望与您沟通。',
  );
  const standaloneResumeBlockedNames = JSON.parse(JSON.stringify(
    ctx2.extractGreetingBlockedNames(
      '工作经历\n北京字节跳动\n项目经历\n海尔供应链项目'
    )
  ));
  assert.deepEqual(standaloneResumeBlockedNames, ['北京字节跳动', '海尔']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      ctx2.extractGreetingBlockedNames('工作经历\n后端开发工程师\n负责 RAG 项目')
    )),
    [],
  );
  assert.equal(
    ctx2.sanitizeGeneratedGreeting(
      '您好，曾做过北京字节跳动内部平台与海尔供应链项目，方便沟通吗？',
      standaloneResumeBlockedNames,
    ),
    '您好，曾做过相关客户供应链项目，方便沟通吗？',
  );
  // 正常归类：岗位名含 custom 词
  assert.equal(ctx2.matchJobToExpected({ name: 'AI Agent开发工程师', tags: ['AI', '后端'] }, [], ['AI Agent']), 'AI Agent');
  // picker 严格：完整分词命中
  assert.equal(ctx2.matchJobToExpected({ name: 'AI产品经理', tags: ['产品'] }, ['AI 产品经理'], []), 'AI 产品经理');
  // 跨组误纳保护：picker「AI产品经理」不应被 tag「产品」蹭进纯产品岗
  assert.notEqual(ctx2.matchJobToExpected({ name: '后端工程师', tags: ['产品'] }, ['AI 产品经理'], []), 'AI 产品经理');
  // 无期望 → 其他
  assert.equal(ctx2.matchJobToExpected({ name: 'Java工程师' }, [], []), '其他');

  // ── detectCompanyRisk（外包/疑似机构/正常） ──
  assert.equal(ctx2.detectCompanyRisk({ name: 'Python开发', company: '软通动力', tags: ['外包'] }).type, 'outsource');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI 全栈工程师', company: '安徽亮剑文化传媒', salary: '35-50K' }).type, 'suspicious');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI漫剧全栈制作', company: '杭州承影载文文化' }).type, 'suspicious');
  assert.equal(ctx2.detectCompanyRisk({ name: '后端开发', company: '阿里巴巴' }), null);
  // M7e 修复：匿名代招/猎头特征出现在 JD 正文时也应识别为外包（科锐代招案例）
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI大模型应用开发工程师', company: '深圳某大型计算机软件公司', desc: '认证资质\n人力资源服务许可证\n劳务派遣经营许可证\n张女士\n上海科之锐\n·\n猎头顾问' }).type, 'outsource', 'JD含代招资质应识别');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI大模型应用开发工程师', company: '深圳某大型计算机软件公司', desc: '代招公司：深圳某大型计算机软件公司' }).type, 'outsource', 'JD含代招公司应识别');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI应用工程师', company: '某某科技', desc: '负责Agent与RAG开发，包含算法调优与系统测试' }), null, '普通JD不误判外包');
  // M7e 补充：匿名公司名（某大型/某知名/代招公司）识别为代招外包（插件 desc 未采集资质区的兜底）
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI大模型应用开发工程师', company: '深圳某大型计算机软件公司', desc: '岗位职责RAG开发' }).type, 'outsource', '某大型匿名公司识别');
  assert.equal(ctx2.detectCompanyRisk({ name: '后端开发', company: '杭州某知名互联网科技有限公司', desc: '负责后端开发' }).type, 'outsource', '某知名匿名公司识别');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI开发', company: '杭州智创科技', desc: '负责Agent开发' }), null, '实名公司不误判');
  // M7f：采集到的资质区标记（daizhaoTag）识别代招；工商信息识别新成立公司风险
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI大模型应用开发工程师', company: '某某科技', desc: 'RAG开发', daizhaoTag: '代招公司：深圳某大型计算机软件公司' }).type, 'outsource', 'daizhaoTag识别代招');
  var newCo = ctx2.detectCompanyRisk({ name: 'AI Agent应用开发工程师', company: '杭州汇隆智域智能科技', desc: 'Agent开发', companyInfo: '工商信息\n公司名称\n杭州汇隆智域智能科技有限公司\n成立日期\n2026-05-25\n注册资金\n200万' });
  assert.equal(newCo && newCo.type, 'newcompany', '成立<6个月识别为新公司风险');
  assert.equal(ctx2.detectCompanyRisk({ name: 'AI开发', company: '杭州智创科技', desc: 'Agent开发', companyInfo: '成立日期\n2019-03-15\n注册资金\n5000万' }), null, '老公司不误判');

  // ── findExcludeKeywordHit（排除词命中） ──
  assert.equal(ctx2.findExcludeKeywordHit({ name: '销售专员', company: 'X公司' }, ['销售']), '销售');
  assert.equal(ctx2.findExcludeKeywordHit({ name: 'Java工程师', company: 'X公司' }, ['销售']), '');
  // M7e 修复：AI 评分理由/风险里的字面词（如"客服运营""算法""测试"作为风险提示）不当作岗位排除词命中
  assert.equal(ctx2.findExcludeKeywordHit({ name: 'AI Agent应用开发工程师', company: 'X公司', aiScreen: { reason: '需确认职责以开发为主而非客服运营', risks: ['算法实现或运营相关风险'] } }, ['运营', '算法']), '', 'AI评分理由不应触发排除词');
  // M7e 修复：技术/职责词只匹配岗位头，不匹配 JD 正文（避免"参与系统测试"被"测试"整体误杀）
  assert.equal(ctx2.findExcludeKeywordHit({ name: 'Agent 开发工程师', company: 'X公司', desc: '负责全流程开发，包含单元测试、系统测试与上线运维，参与算法调优' }, ['测试', '算法', '运维']), '', 'JD正文中的技术/职责词不应触发排除词');
  assert.equal(ctx2.findExcludeKeywordHit({ name: 'Agent 测试工程师', company: 'X公司', desc: '负责Agent评测' }, ['测试']), '测试', '岗位名含测试仍应命中');
  assert.equal(ctx2.findExcludeKeywordHit({ name: '智能体开发工程师', company: 'X公司', desc: '负责测试与上线' }, ['测试']), '', 'JD正文的测试词不应命中（非测试岗）');
  // M7e 修复：强岗位类型词全文匹配仍生效
  assert.equal(ctx2.findExcludeKeywordHit({ name: 'AI开发工程师', company: 'X公司', desc: '本岗位为外包驻场岗位，驻场客户现场' }, ['外包']), '外包', '外包强词JD正文仍命中');
  assert.equal(ctx2.findExcludeKeywordHit({ name: '后端开发工程师', company: 'X公司', desc: '负责客服系统与销售数据的后端开发' }, ['销售']), '销售', '销售强词JD正文仍命中');

  // ── extractExperienceFromTags（年限识别） ──
  assert.equal(ctx2.extractExperienceFromTags(['1-3年', '本科']), '1-3年');
  assert.equal(ctx2.extractExperienceFromTags(['经验不限', '本科']), '经验不限');
  assert.equal(ctx2.extractExperienceFromTags(['10年以上', '硕士']), '10年以上');
  assert.equal(ctx2.extractExperienceFromTags(['本科', 'Java']), '');

  console.log('All extension policy tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
