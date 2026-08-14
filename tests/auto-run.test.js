// auto-run.test.js — 1.4.0 自动投递 MVP 纯逻辑测试
// 覆盖：classifyJob / autoHardReject / buildAutoRunPreview / autoQuotaCheck / extractJobOutcome
// 从 service-worker.js 截取 1.4.0 auto-run 模块段，用 vm 加载并注入 mock 依赖。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

// 从 SW 源码中截取 "1.4.0 自动投递 MVP" 模块段（不含 async 投递执行，只截纯函数部分）
function extractAutoRunPureFns() {
  const sw = read('src/background/service-worker.js');
  const markerStart = '// 1.4.0 自动投递 MVP（startAutoRun 批处理器）';
  const start = sw.indexOf(markerStart);
  assert.ok(start >= 0, 'auto-run module marker not found');
  // 截取到 attemptJobDelivery 之前（纯函数部分）：classifyJob/autoHardReject/buildAutoRunPreview/autoQuotaCheck/extractJobOutcome
  const endMarker = 'async function attemptJobDelivery';
  const end = sw.indexOf(endMarker, start);
  assert.ok(end >= 0, 'attemptJobDelivery marker not found');
  // 找 attemptJobDelivery 前的函数定义边界：往前到 "// 单岗自动投递" 注释
  const fnStartMarker = '// 单岗自动投递';
  const fnStart = sw.lastIndexOf(fnStartMarker, end);
  assert.ok(fnStart > start, 'fnStart boundary not found');
  return sw.slice(start, fnStart);
}

// 从 SW 源码中截取 collectOnTab 附近的辅助函数（cityCodeToName / parseSalaryMidK）
function extractCollectHelpers() {
  const sw = read('src/background/service-worker.js');
  const start = sw.indexOf('// 1.4.0: BOSS 城市码 → 城市名');
  const end = sw.indexOf('function allExpectedPositions');
  assert.ok(start >= 0 && end > start, 'collect helper markers not found');
  return sw.slice(start, end);
}

function loadAutoRunCtx(seed = {}) {
  const state = {
    jobs: [],
    autoRun: null,
  };
  const sentJobIds = new Set(seed.sent || []);
  const CONFIG = {};
  const context = {
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    state,
    sentJobIds,
    CONFIG,
    DiagLogger: { userEvent() {}, info() {}, warn() {}, error() {} },
    ErrorLogger: { logError() {} },
    uniqueStrings: (arr) => Array.from(new Set((arr || []).filter(Boolean))),
    persistState: async () => {},
    pushState: () => {},
    getDailySendCount: async () => 0,
    chrome: { runtime: { sendMessage: () => {} }, storage: { local: { get: async () => ({}), set: async () => {} } } },
    bootRestored: Promise.resolve(),
    startSendV6: async () => {},
    stopSend: async () => {},
  };
  context.window = context;
  vm.createContext(context);
  // 注入纯函数
  const pure = extractAutoRunPureFns();
  vm.runInContext(pure, context, { filename: 'auto-run-pure.js' });
  // 注入 collect 辅助函数（cityCodeToName / parseSalaryMidK）
  const helpers = extractCollectHelpers();
  vm.runInContext(helpers, context, { filename: 'collect-helpers.js' });
  // 注入尝试函数桩（跳过真实投递）
  context.attemptJobDelivery = async (job, attemptId) => ({ attemptId, jobId: job.jobId || job.id, company: job.company || '', hr: job.hrName || '', outcome: 'delivered', reason: '', deliveredAt: Date.now(), attemptAt: Date.now() });
  return context;
}

function mkJob(over = {}) {
  return Object.assign({
    id: 'job1', jobId: 'job1', name: 'AI应用工程师', company: '测试公司', hrName: '王HR',
    aiScreen: { score: 80, applyScore: 80, interviewScore: 70, reason: 'ok', risks: [] },
  }, over);
}

async function main() {
  // ── classifyJob ──
  {
    const ctx = loadAutoRunCtx();
    const cfg = { thresholdAuto: 75, thresholdReview: 60 };
    assert.strictEqual(ctx.classifyJob(mkJob({ aiScreen: { applyScore: 80 } }), cfg).bucket, 'auto');
    assert.strictEqual(ctx.classifyJob(mkJob({ aiScreen: { applyScore: 70 } }), cfg).bucket, 'review');
    assert.strictEqual(ctx.classifyJob(mkJob({ aiScreen: { applyScore: 50 } }), cfg).bucket, 'skip');
    assert.strictEqual(ctx.classifyJob(mkJob({ aiScreen: { score: 90 } }), cfg).bucket, 'auto', 'fallback to score');
    assert.strictEqual(ctx.classifyJob(mkJob({ aiScreen: {} }), cfg).bucket, 'skip', 'no score -> skip');
    console.log('[PASS] classifyJob: auto/review/skip/fallback/no-score');
  }

  // ── autoHardReject ──
  {
    const ctx = loadAutoRunCtx();
    const job = mkJob({ excludeReason: '命中排除词：外包' });
    const r1 = ctx.autoHardReject(job, ctx.state);
    assert.ok(r1.includes('命中排除词：外包'), 'excludeReason caught');
    const r2 = ctx.autoHardReject(mkJob({}), ctx.state);
    assert.strictEqual(r2.length, 0, 'clean job no reject');
    // 已投
    const ctx2 = loadAutoRunCtx({ sent: ['job-sent'] });
    const jobSent = mkJob({ id: 'job-sent', jobId: 'job-sent' });
    assert.ok(ctx2.autoHardReject(jobSent, ctx2.state).includes('本机已送达'), 'sent caught');
    // 城市
    const ctx3 = loadAutoRunCtx();
    ctx3.state.autoRun = { config: { allowedCities: ['杭州'] } };
    const jobCity = mkJob({ cityName: '苏州' });
    assert.ok(ctx3.autoHardReject(jobCity, ctx3.state).some(r => r.includes('城市不符')), 'city mismatch caught');
    // 历史已沟通去重（M7）
    const ctx4 = loadAutoRunCtx();
    const handled = { '测试公司|王hr': 'sent' };
    const jobHr = mkJob({ company: '测试公司', hrName: '王HR' });
    assert.ok(ctx4.autoHardReject(jobHr, ctx4.state, handled).some(r => r.includes('历史已沟通')), 'same hr caught');
    const handled2 = { '测试公司|李hr': 'sent' };
    assert.ok(ctx4.autoHardReject(jobHr, ctx4.state, handled2).some(r => r.includes('同公司')), 'same company caught');
    // 经验硬门槛（M7c）
    const ctx5 = loadAutoRunCtx();
    const jobExp = mkJob({ experience: '3-5年' });
    assert.ok(ctx5.autoHardReject(jobExp, ctx5.state).some(r => r.includes('经验硬门槛: 3-5年')), 'exp 3-5y caught');
    assert.ok(ctx5.autoHardReject(mkJob({ experience: '1-3年' }), ctx5.state).some(r => r.includes('经验硬门槛')), 'exp 1-3y caught');
    const jobExpFree = mkJob({ experience: '经验不限' });
    assert.strictEqual(ctx5.autoHardReject(jobExpFree, ctx5.state).length, 0, 'exp-free not rejected');
    const jobExpFresh = mkJob({ experience: '应届生(校招)' });
    assert.strictEqual(ctx5.autoHardReject(jobExpFresh, ctx5.state).length, 0, 'fresh-grad not rejected');
    // JD 正文硬门槛（M7d）
    const ctx6 = loadAutoRunCtx();
    const job27 = mkJob({ desc: '毕业时间：2027年\n岗位要求：本科及以上' });
    assert.ok(ctx6.autoHardReject(job27, ctx6.state).some(r => r.includes('2027届')), '2027 grad caught');
    const jobJdExp = mkJob({ desc: '任职要求\n1、本科及以上学历，1年以上相关工作经验' });
    assert.ok(ctx6.autoHardReject(jobJdExp, ctx6.state).some(r => r.includes('JD经验硬门槛')), 'JD 1年+ caught');
    const jobOutsource = mkJob({ desc: '客户方使用前沿技术，外包员工也可参加培训' });
    assert.ok(ctx6.autoHardReject(jobOutsource, ctx6.state).some(r => r.includes('外包/代招')), 'outsource caught');
    const jobClean = mkJob({ desc: '本科及以上学历，接受2026届应届生，有项目经验者优先，Python熟练' });
    assert.strictEqual(ctx6.autoHardReject(jobClean, ctx6.state).length, 0, 'clean JD not rejected');
    const jobFreshJd = mkJob({ desc: '接受应届生无经验，有老师带教，Python熟练即可' });
    assert.strictEqual(ctx6.autoHardReject(jobFreshJd, ctx6.state).length, 0, 'fresh-friendly JD not rejected');
    const jobName27 = mkJob({ name: 'AI Agent 应用工程师-2027届', desc: '负责构建 AI Agent 应用' });
    assert.ok(ctx6.autoHardReject(jobName27, ctx6.state).some(r => r.includes('2027届')), 'name 2027 caught');
    const job985 = mkJob({ desc: '任职要求：985本科以上学历，善于沟通' });
    assert.ok(ctx6.autoHardReject(job985, ctx6.state).some(r => r.includes('学历硬门槛')), '985 caught');
    const jobExpCanApply = mkJob({ desc: '1-3年工作经验可投，接受优秀应届生' });
    assert.strictEqual(ctx6.autoHardReject(jobExpCanApply, ctx6.state).length, 0, '1-3年可投(接受应届) not rejected');
    console.log('[PASS] autoHardReject: exclude/sent/city/history-dedup/exp-gate/jd-gate');
  }

  // ── buildAutoRunPreview ──
  {
    const ctx = loadAutoRunCtx();
    ctx.state.jobs = [
      mkJob({ id: 'a1', jobId: 'a1', name: 'A岗', company: '甲', aiScreen: { applyScore: 85 } }),
      mkJob({ id: 'a2', jobId: 'a2', name: 'B岗', company: '乙', aiScreen: { applyScore: 65 } }),
      mkJob({ id: 'a3', jobId: 'a3', name: 'C岗', company: '丙', aiScreen: { applyScore: 40 } }),
      mkJob({ id: 'a4', jobId: 'a4', name: 'D岗', company: '丁', aiScreen: { applyScore: 90 }, excludeReason: '外包' }),
    ];
    const cfg = { thresholdAuto: 75, thresholdReview: 60, batchLimit: 10, dailyLimit: 30, allowedCities: [], sendImages: false };
    const pv = ctx.buildAutoRunPreview(['a1', 'a2', 'a3', 'a4'], cfg);
    assert.strictEqual(pv.counts.auto, 1, 'only a1 auto (a4 rejected)');
    assert.strictEqual(pv.counts.review, 1, 'a2 review');
    assert.strictEqual(pv.counts.skip, 1, 'a3 skip only (a4 is rejected)');
    assert.strictEqual(pv.counts.rejected, 1, 'a4 rejected');
    assert.strictEqual(pv.counts.total, 4);
    assert.ok(pv.auto[0].jobId === 'a1');
    console.log('[PASS] buildAutoRunPreview: counts/buckets/reject');
  }

  // ── autoQuotaCheck ──
  {
    const ctx = loadAutoRunCtx();
    const cfg = { batchLimit: 2, maxConsecutiveFail: 3, maxConsecutiveUncertain: 2, maxPerCompany: 2, maxPerHr: 1 };
    // 本批已达 2 成功
    const log1 = [
      { outcome: 'delivered', company: '甲', hr: '王HR' },
      { outcome: 'delivered', company: '甲', hr: '王HR' },
    ];
    const r1 = ctx.autoQuotaCheck(log1, mkJob({ company: '甲', hrName: '王HR' }), cfg);
    assert.ok(Array.isArray(r1), 'autoQuotaCheck returns array');
    assert.ok(r1.some(x => x.indexOf('达到本批上限') >= 0), 'batch limit reason present, got: ' + JSON.stringify(r1));
    // 连续失败 3
    const log2 = [
      { outcome: 'failed', company: '乙', hr: '' },
      { outcome: 'failed', company: '乙', hr: '' },
      { outcome: 'failed', company: '乙', hr: '' },
    ];
    assert.ok(ctx.autoQuotaCheck(log2, mkJob({ company: '丙' }), cfg).some(x => x.indexOf('连续失败') >= 0), 'consecutive fail');
    // 连续不确定 2
    const log3 = [
      { outcome: 'uncertain', company: '乙', hr: '' },
      { outcome: 'uncertain', company: '乙', hr: '' },
    ];
    assert.ok(ctx.autoQuotaCheck(log3, mkJob({ company: '丙' }), cfg).some(x => x.indexOf('连续不确定') >= 0), 'consecutive uncertain');
    // 同 HR 上限 1
    const log4 = [{ outcome: 'delivered', company: '甲', hr: '王HR' }];
    assert.ok(ctx.autoQuotaCheck(log4, mkJob({ company: '甲', hrName: '王HR' }), cfg).some(x => x.indexOf('同 HR') >= 0), 'same HR');
    // 干净情况
    const log5 = [{ outcome: 'delivered', company: '甲', hr: '李HR' }];
    assert.strictEqual(ctx.autoQuotaCheck(log5, mkJob({ company: '甲', hrName: '王HR' }), cfg).length, 0, 'clean no quota');
    console.log('[PASS] autoQuotaCheck: batch/consecutive/hr');
  }

  // ── extractJobOutcome ──
  {
    const ctx = loadAutoRunCtx();
    assert.strictEqual(ctx.extractJobOutcome([{ success: true }]).outcome, 'delivered');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, alreadyChatted: true }]).outcome, 'alreadyChatted');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, captchaDetected: true }]).outcome, 'captcha');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, error: '包含验证码' }]).outcome, 'captcha');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, error: '包含安全' }]).outcome, 'captcha');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, skipped: true }]).outcome, 'uncertain');
    assert.strictEqual(ctx.extractJobOutcome([{ success: false, error: '网络错误' }]).outcome, 'failed');
    assert.strictEqual(ctx.extractJobOutcome([]).outcome, 'uncertain');
    console.log('[PASS] extractJobOutcome: delivered/alreadyChatted/captcha/uncertain/failed');
  }

  // ── rankAutoJobs / parseSalaryMidK / cityCodeToName ──
  {
    const ctx = loadAutoRunCtx();
    // parseSalaryMidK
    assert.strictEqual(ctx.parseSalaryMidK('15-30K·14薪'), 22.5);
    assert.strictEqual(ctx.parseSalaryMidK('8-13K·13'), 10.5);
    assert.strictEqual(ctx.parseSalaryMidK('10K'), 10);
    assert.strictEqual(ctx.parseSalaryMidK(''), 0);
    // cityCodeToName
    assert.strictEqual(ctx.cityCodeToName('101210100'), '杭州');
    assert.strictEqual(ctx.cityCodeToName('999999'), '999999');
    // rankAutoJobs: applyScore 主导
    const jobs = [
      mkJob({ id: 'r1', jobId: 'r1', salary: '8-10K', salaryMidK: 9, cityName: '苏州', aiScreen: { applyScore: 90 } }),
      mkJob({ id: 'r2', jobId: 'r2', salary: '15-30K', salaryMidK: 22.5, cityName: '杭州', aiScreen: { applyScore: 85 } }),
      mkJob({ id: 'r3', jobId: 'r3', salary: '12-16K', salaryMidK: 14, cityName: '杭州', aiScreen: { applyScore: 80 } }),
    ];
    const cfg = { allowedCities: ['杭州'], targetSalaryK: 10 };
    const ranked = ctx.rankAutoJobs(jobs, cfg);
    assert.strictEqual(ranked[0].jobId, 'r2', 'r2 高apply+杭州+高薪 最优');
    assert.ok(ranked.every(r => typeof r.rank === 'number'), 'rank is number');
    // 城市白名单过滤效应：非杭州的 r1 应排最后
    assert.strictEqual(ranked[ranked.length - 1].jobId, 'r1', 'r1 非杭州排最后');
    console.log('[PASS] rankAutoJobs/parseSalaryMidK/cityCodeToName');
  }

  // ── sha256Text（M4 招呼语内容哈希） ──
  {
    // 从 SW 提取 sha256Text 函数
    const sw = read('src/background/service-worker.js');
    const mStart = sw.indexOf('function sha256Text(text)');
    const mEnd = sw.indexOf('async function generateJobGreeting');
    assert.ok(mStart >= 0 && mEnd > mStart, 'sha256Text markers not found');
    const fnSrc = sw.slice(mStart, mEnd);
    const ctx2 = loadAutoRunCtx();
    // 用独立上下文跑函数定义
    const c2 = vm.createContext({ console, Math });
    vm.runInContext(fnSrc, c2);
    const h1 = c2.sha256Text('hello');
    const h2 = c2.sha256Text('hello');
    const h3 = c2.sha256Text('hello world');
    assert.strictEqual(h1, h2, 'sha256Text deterministic');
    assert.notStrictEqual(h1, h3, 'sha256Text differs on content');
    assert.ok(String(h1).startsWith('h-'), 'hash prefix');
    console.log('[PASS] sha256Text: deterministic/content-bound');
  }

  // ── buildSendQueueV6 jobId 级 greeting 优先级（M4） ──
  {
    const sw = read('src/background/service-worker.js');
    const fnStart = sw.indexOf('function buildSendQueueV6(');
    const fnEnd = sw.indexOf('async function loadSendGreetingPreference');
    assert.ok(fnStart >= 0 && fnEnd > fnStart, 'buildSendQueueV6 markers not found');
    const fnSrc = sw.slice(fnStart, fnEnd);
    // 构造 context：包含 buildSendQueueV6 依赖的函数
    const c3 = vm.createContext({
      console,
      Date,
      sentJobIds: new Set(),
      state: {
        jobs: [ { jobId: 'j1', name: 'AI应用工程师', company: '测试公司', tags: ['AI'] } ],
        greetings: { 'j1': { text: '岗位级招呼语', variant: 'v1', sha256: 'h-x' }, 'AI': '分类级招呼语' },
        selectedPositions: ['AI'], customPositions: [],
        sendGreeting: true,
        jobCustom: {},
      },
      SINGLE_SEND_CONFIRMATION_VERSION: 3,
      sanitizeGeneratedGreeting: (t) => t || '',
      normalizeImageConsentKeys: (k) => k || [],
      uniqueStrings: (a) => Array.from(new Set((a || []).filter(Boolean))),
      matchJobToPosition: () => 'AI',
      DiagLogger: { info() {} },
    });
    vm.runInContext(fnSrc, c3, { filename: 'buildSendQueueV6.js' });
    const q = c3.buildSendQueueV6(c3.state, ['j1'], {});
    assert.strictEqual(q[0].greeting, '岗位级招呼语', 'jobId 级 greeting 优先于分类级');
    console.log('[PASS] buildSendQueueV6: jobId greeting priority');
  }

  // ── M5: normalizeJobRecord 五分类状态支持 ──
  {
    const idb = read('src/db/indexeddb.js');
    // 提取状态常量 + buildJobKey + normalizeJobRecord
    const cStart = idb.indexOf('const HANDLED_JOB_STATUSES');
    const cEnd = idb.indexOf('function mergeJobRecord');
    assert.ok(cStart >= 0 && cEnd > cStart, 'indexeddb markers not found');
    const src = idb.slice(cStart, cEnd);
    const c = vm.createContext({ console, Date, indexedDB: undefined });
    vm.runInContext(src, c, { filename: 'indexeddb-partial.js' });
    const r1 = c.normalizeJobRecord({ jobId: 'x1', status: 'delivered', deliveredAt: '2026-08-13T00:00:00Z', runId: 'run-1', attemptId: 'run-1-x1' });
    assert.strictEqual(r1.status, 'delivered');
    assert.strictEqual(r1.runId, 'run-1');
    assert.strictEqual(r1.attemptId, 'run-1-x1');
    assert.strictEqual(r1.deliveredAt, '2026-08-13T00:00:00Z');
    const r2 = c.normalizeJobRecord({ jobId: 'x2', status: 'uncertain' });
    assert.strictEqual(r2.status, 'uncertain');
    const r3 = c.normalizeJobRecord({ jobId: 'x3', status: 'stopped' });
    assert.strictEqual(r3.status, 'stopped');
    const r4 = c.normalizeJobRecord({ jobId: 'x4', status: 'bogus' });
    assert.strictEqual(r4.status, 'collected', 'bogus status falls back');
    console.log('[PASS] normalizeJobRecord: delivered/uncertain/stopped + M5 fields');
  }

  // ── M6: buildResponseMetrics 回复/约面分层统计 ──
  {
    const of = read('src/shared/outcome-feedback.js');
    const ctx = vm.createContext({ globalThis: {}, console, Date });
    ctx.globalThis = ctx;
    vm.runInContext(of, ctx, { filename: 'outcome-feedback.js' });
    const JobOutcomeFeedback = ctx.globalThis.JobOutcomeFeedback;
    const now = Date.now();
    const DAY = 86400000;
    // 样本不足（3条 delivered）→ sampleOk false，metrics null
    const small = [
      { status: 'delivered', deliveredAt: now, repliedAt: now + DAY, city: '杭州' },
      { status: 'delivered', deliveredAt: now, repliedAt: now + 2 * DAY, city: '杭州' },
      { status: 'delivered', deliveredAt: now, city: '苏州' },
    ];
    const rSmall = JobOutcomeFeedback.buildResponseMetrics(small);
    assert.strictEqual(rSmall.sampleOk, false);
    assert.strictEqual(rSmall.metrics, null);
    // 样本充足（5条），7天内回复 3 条，14天内约面 1 条
    const recs = [
      { status: 'delivered', deliveredAt: now - 10 * DAY, repliedAt: now - 8 * DAY, interviewAt: now - 3 * DAY, city: '杭州', frozenPrediction: { applyScore: 80 }, greetingVariant: 'v1' },
      { status: 'delivered', deliveredAt: now - 10 * DAY, repliedAt: now - 6 * DAY, city: '杭州', frozenPrediction: { applyScore: 85 }, greetingVariant: 'v1' },
      { status: 'delivered', deliveredAt: now - 10 * DAY, repliedAt: now - 4 * DAY, city: '苏州', frozenPrediction: { applyScore: 65 }, greetingVariant: 'v2' },
      { status: 'delivered', deliveredAt: now - 10 * DAY, city: '苏州', frozenPrediction: { applyScore: 50 }, greetingVariant: 'v2' },
      { status: 'delivered', deliveredAt: now - 10 * DAY, city: '杭州', frozenPrediction: { applyScore: 70 }, greetingVariant: 'v1' },
    ];
    const r = JobOutcomeFeedback.buildResponseMetrics(recs);
    assert.strictEqual(r.sampleOk, true);
    assert.strictEqual(r.metrics.n, 5);
    assert.strictEqual(r.metrics.repliedPct, 60, '3/5 replied');
    assert.ok(r.metrics.replied7dPct <= 100);
    assert.strictEqual(r.byCity['杭州'].n, 3);
    assert.strictEqual(r.byScoreBand.high.n, 2, 'applyScore>=75 → 2');
    console.log('[PASS] buildResponseMetrics: sample-gate/7d-14d/stratified');
  }

  console.log('All auto-run tests passed.');
  process.exit(0);
}

main().catch((e) => { console.error('AUTO_RUN_TEST_FAIL:', e); process.exit(1); });
