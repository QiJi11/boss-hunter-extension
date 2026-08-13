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
    console.log('[PASS] autoHardReject: exclude/sent/city');
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

  console.log('All auto-run tests passed.');
  process.exit(0);
}

main().catch((e) => { console.error('AUTO_RUN_TEST_FAIL:', e); process.exit(1); });
