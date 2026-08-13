// Service Worker — 消息中枢 + OpenAI-compatible AI 代理
importScripts('/src/shared/constants.js');
importScripts('/src/shared/greeting-safety.js');
importScripts('/src/shared/outcome-feedback.js');
importScripts('/src/db/indexeddb.js');
importScripts('/src/shared/error-logger.js');
importScripts('/src/shared/diag-logger.js');
importScripts('/src/shared/device-id.js');
// 诊断包：SW 启动事件（冷启动/被消息唤醒都会走到这里）。
// 纯内存 push + 异步节流落盘，不阻塞 boot-restore 链路（#33/#36 竞态红线）。
try { DiagLogger.userEvent('sw.lifecycle', 'SW started (cold start or wake)'); } catch (_) {}
const DEFAULT_AI_CONFIG = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4.1-mini',
  scoreThreshold: 80,
};

async function migrateSettingsV2() {
  const keys = [
    'apiKey', STORAGE_KEYS.SW.AI_CONFIG, STORAGE_KEYS.UI.FILTER_STATE,
    FEATURE_KEYS.AI_SCREENING_ENABLED, FEATURE_KEYS.AUTO_RESUME_REPLY_ENABLED,
    FEATURE_KEYS.AUTO_RESUME_ID, FEATURE_KEYS.AUTO_RESUME_CONSENT_VERSION,
    FEATURE_KEYS.BACKUP_VERSION, FEATURE_KEYS.OUTCOME_FEEDBACK_LEARNING_ENABLED,
  ];
  const result = await chrome.storage.local.get(keys);
  const patch = {};
  if (!result[STORAGE_KEYS.SW.AI_CONFIG]) {
    const merged = Object.assign({}, DEFAULT_AI_CONFIG, result.apiKey ? { apiKey: result.apiKey } : {});
    patch[STORAGE_KEYS.SW.AI_CONFIG] = merged;
  }
  const features = normalizeFeatureSettings(result);
  Object.assign(patch, features);
  patch[STORAGE_KEYS.UI.FILTER_STATE] = normalizeFilterStateDefaults(result[STORAGE_KEYS.UI.FILTER_STATE]);
  await chrome.storage.local.set(patch);
}

function normalizeAiBaseUrl(baseUrl) {
  var url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) url = DEFAULT_AI_CONFIG.baseUrl;
  return /\/chat\/completions$/.test(url) ? url : url + '/chat/completions';
}

function normalizeAiConfig(raw) {
  var cfg = Object.assign({}, DEFAULT_AI_CONFIG, raw || {});
  cfg.provider = cfg.provider || 'openai-compatible';
  cfg.baseUrl = String(cfg.baseUrl || DEFAULT_AI_CONFIG.baseUrl).trim().replace(/\/+$/, '');
  cfg.apiKey = String(cfg.apiKey || '').trim();
  cfg.model = String(cfg.model || DEFAULT_AI_CONFIG.model).trim();
  var threshold = Number(cfg.scoreThreshold);
  cfg.scoreThreshold = Number.isFinite(threshold)
    ? Math.max(0, Math.min(100, threshold))
    : DEFAULT_AI_CONFIG.scoreThreshold;
  return cfg;
}

async function getAiConfig() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SW.AI_CONFIG, 'apiKey']);
  return normalizeAiConfig(Object.assign({}, result[STORAGE_KEYS.SW.AI_CONFIG] || {}, result.apiKey && !(result[STORAGE_KEYS.SW.AI_CONFIG] || {}).apiKey ? { apiKey: result.apiKey } : {}));
}

async function saveAiConfig(config) {
  const cfg = normalizeAiConfig(config);
  await chrome.storage.local.set({ [STORAGE_KEYS.SW.AI_CONFIG]: cfg, apiKey: cfg.apiKey });
  return cfg;
}

async function getTextResume() {
  const result = await chrome.storage.local.get(['textResume', STORAGE_KEYS.SW.TEXT_RESUME]);
  return result.textResume || result[STORAGE_KEYS.SW.TEXT_RESUME] || '';
}

// ── OpenAI-compatible API ──
async function callOpenAICompatible(config, messages, maxTokens = 2000, timeoutMs = 12000, label = '', responseFormat) {
  const cfg = normalizeAiConfig(config);
  if (!cfg.apiKey) throw new Error('请先在设置页配置 AI API Key');
  if (!cfg.model) throw new Error('请先在设置页配置 AI 模型');
  const tag = label ? `[TIMING][${label}]` : '[TIMING]';
  const t0 = Date.now();
  const body = {
    model: cfg.model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
  };
  if (responseFormat) body.response_format = responseFormat;
  const bodyStr = JSON.stringify(body);
  const tBodyReady = Date.now();
  const bodyKB = (bodyStr.length / 1024).toFixed(1);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let tFetchStart, tFetchEnd, tParseEnd;
  try {
    tFetchStart = Date.now();
    const resp = await fetch(normalizeAiBaseUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: bodyStr,
      signal: controller.signal,
    });
    tFetchEnd = Date.now();
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '未知错误');
      console.error(`[猎职]${tag} HTTP ${resp.status} after fetch=${tFetchEnd - tFetchStart}ms`);
      throw new Error(`API 错误 ${resp.status}: ${errText.substring(0, 200)}`);
    }
    const data = await resp.json();
    tParseEnd = Date.now();
    if (!data.choices || !data.choices.length) throw new Error('API 返回空结果');
    return data.choices[0].message.content;
  } catch (err) {
    clearTimeout(timeoutId);
    const tErr = Date.now();
    const phase = tFetchEnd ? 'parse' : (tFetchStart ? 'fetch' : 'pre');
    const fetchElapsed = tFetchStart ? ((tFetchEnd || tErr) - tFetchStart) : 0;
    const msg = `${tag} ${err.name} phase=${phase} fetchElapsed=${fetchElapsed}ms TOTAL=${tErr - t0}ms timeoutBudget=${timeoutMs}ms msg=${err.message}`;
    console.error(`[猎职]${msg}`);
    ErrorLogger.logError(msg, err.stack, 'callOpenAICompatible');
    if (err.name === 'AbortError') throw new Error(`请求超时（${timeoutMs/1000}秒），请检查网络`);
    throw err;
  }
}

function extractJsonObject(text) {
  var raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  var match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 未返回 JSON');
  return JSON.parse(match[0]);
}

function buildJobScreenPrompt(job, resumeText, expected, feedbackContext) {
  var excludeKeywords = uniqueStrings(state.excludeKeywords || []);
  var feedbackSection = feedbackContext ? '\n\n' + feedbackContext : '';
  return `请判断这个岗位是否适合投递。只返回 JSON，不要 Markdown。\n\n[简历]\n${resumeText || '未提供文字简历'}\n\n[用户期望方向]\n${expected || ''}\n\n[排除规则]\n排除关键词：${excludeKeywords.join(' / ') || '无'}\n重点识别并降低评分：外包、驻场、培训推广、销售/主播/客服、讲师岗、剪辑/视频制作、游戏前端、把销售/运营包装成 AI 应用开发的岗位、非真实开发岗。${feedbackSection}\n\n[岗位]\n标题：${job.name || ''}\n公司：${job.company || ''}\n薪资：${job.salary || ''}\n标签：${(job.tags || []).join(' / ')}\nJD：${String(job.desc || job.description || job.detail || '').slice(0, 1500)}\n\n返回格式：{"score":0,"applyScore":0,"applyReason":"","interviewScore":0,"interviewReason":"","reason":"","risks":[]}\nscore 为 0-100 的综合匹配分；applyScore 为 0-100 的"能投"分（可投递性，匹配+无风险），applyReason 不超过 30 字说明能投理由；interviewScore 为 0-100 的"能进"分（进面可能性，简历竞争力 vs 岗位要求），interviewReason 不超过 30 字说明能进理由；reason 不超过 40 字；risks 是字符串数组，命中排除规则时写明具体风险。`;
}

async function screenSingleJob(cfg, job, resumeText, expected, feedbackContext) {
  const messages = [
    { role: 'system', content: '你是招聘岗位匹配助手。严格输出一个 JSON 对象，字段为 score、applyScore、applyReason、interviewScore、interviewReason、reason、risks。不要生成招呼语。' },
    { role: 'user', content: buildJobScreenPrompt(job, resumeText, expected, feedbackContext) },
  ];
  let text;
  try {
    text = await callOpenAICompatible(cfg, messages, 900, 60000, `screen:${job.id || job.name}`, { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 900, 60000, `screen:${job.id || job.name}`);
  }
  const parsed = extractJsonObject(text);
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score || 0))),
    applyScore: Math.max(0, Math.min(100, Number(parsed.applyScore !== undefined ? parsed.applyScore : parsed.score || 0))),
    applyReason: String(parsed.applyReason || '').slice(0, 80),
    interviewScore: Math.max(0, Math.min(100, Number(parsed.interviewScore !== undefined ? parsed.interviewScore : parsed.score || 0))),
    interviewReason: String(parsed.interviewReason || '').slice(0, 80),
    reason: String(parsed.reason || '').slice(0, 160),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 5) : [],
  };
}

function buildEmptyBatchOverview() {
  return {
    headline: '',
    good: [],
    bad: [],
    nextFocus: [],
    pitfalls: [],
    coverage: {
      totalJobs: 0,
      jobsWithJD: 0,
      pendingJobs: 0,
      completedBatches: 0,
    },
    updatedAt: 0,
  };
}

function buildEmptyCollectionSummary() {
  return {
    startedAt: 0,
    updatedAt: 0,
    cities: [],
    keywords: [],
    tasksTotal: 0,
    tasksDone: 0,
    rawJobs: 0,
    matchedJobs: 0,
    visibleJobs: 0,
    positionFilteredJobs: 0,
    duplicateJobs: 0,
    postRuleFilteredJobs: 0,
    emptyTasks: 0,
    failedTasks: 0,
    checkedJobs: 0,
    excludedJobs: 0,
    historySkippedJobs: 0,
    groups: 0,
    taskSummaries: [],
  };
}

function buildEmptyAiOverviewSummary(reason) {
  return {
    status: reason ? 'skipped' : 'idle',
    reason: reason || '',
    totalJobs: 0,
    jobsWithJD: 0,
    pendingJobs: 0,
    failedJdJobs: 0,
    completedBatches: 0,
    updatedAt: 0,
  };
}

function countCheckedJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) { return !!job && job.checked !== false; }).length;
}

function countExcludedJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) { return !!(job && job.excludeReason); }).length;
}

function countHistorySkippedJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) { return !!(job && job.historySkipReason); }).length;
}

function countEmptyCollectTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(function(task) { return task && task.status === 'ok' && !Number(task.rawJobs || 0); }).length;
}

function countFailedCollectTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter(function(task) { return task && task.status === 'failed'; }).length;
}

function countFailedJdJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) { return job && job.jdStatus === 'failed'; }).length;
}

function hasBatchOverviewContent(overview) {
  return !!(overview && (overview.headline || (overview.good || []).length || (overview.bad || []).length || (overview.nextFocus || []).length || (overview.pitfalls || []).length));
}

function summarizeGroups(clusters) {
  return Object.keys(clusters || {}).filter(function(key) {
    return Array.isArray(clusters[key]) && clusters[key].length > 0;
  }).length;
}

function updateCollectionSummary(patch) {
  state.collectionSummary = Object.assign({}, state.collectionSummary || buildEmptyCollectionSummary(), patch || {}, { updatedAt: Date.now() });
  try {
    DiagLogger.info('sw.collect.diag', 'summary raw=' + state.collectionSummary.rawJobs + ' matched=' + state.collectionSummary.matchedJobs + ' visible=' + state.collectionSummary.visibleJobs + ' checked=' + state.collectionSummary.checkedJobs + ' excluded=' + state.collectionSummary.excludedJobs + ' historySkipped=' + state.collectionSummary.historySkippedJobs);
  } catch (_) {}
}

function updateAiOverviewSummary(patch) {
  state.aiOverviewSummary = Object.assign({}, state.aiOverviewSummary || buildEmptyAiOverviewSummary(), patch || {}, { updatedAt: Date.now() });
  try {
    DiagLogger.info('sw.aiOverview.diag', 'status=' + state.aiOverviewSummary.status + ' reason=' + (state.aiOverviewSummary.reason || '') + ' jobs=' + state.aiOverviewSummary.totalJobs + ' jd=' + state.aiOverviewSummary.jobsWithJD + '/' + state.aiOverviewSummary.totalJobs);
  } catch (_) {}
}

function createJobHydrationMeta(job) {
  if (!job) return null;
  if (!job.jdStatus) job.jdStatus = (job.detail || job.desc || job.description) ? 'success' : 'pending';
  if (typeof job.jdAttempts !== 'number') job.jdAttempts = 0;
  if (typeof job.jdLastError !== 'string') job.jdLastError = '';
  return job;
}

function ensureJobHydrationMeta(jobs) {
  (Array.isArray(jobs) ? jobs : []).forEach(createJobHydrationMeta);
}

function findStateJobById(jobId) {
  var jobs = Array.isArray(state.jobs) ? state.jobs : [];
  for (var i = 0; i < jobs.length; i++) {
    var job = jobs[i];
    if (job && String(job.jobId || job.id || '') === String(jobId || '')) return job;
  }
  return null;
}

function mapJobToRecord(job, status, source, patch) {
  var extra = patch || {};
  return {
    jobKey: extra.jobKey || (job && (job.jobKey || job.jobId || job.id || job.link || job.jobLink)),
    jobId: extra.jobId || (job && (job.jobId || job.id)) || '',
    jobLink: extra.jobLink || (job && (job.jobLink || job.link || job.url)) || '',
    positionName: extra.positionName || (job && (job.positionName || job.name || job.title)) || '',
    companyName: extra.companyName || (job && (job.companyName || job.company)) || '',
    hrName: extra.hrName || (job && (job.hrName || job.bossName)) || '',
    city: extra.city || (job && (job.city || job.location)) || '',
    salary: extra.salary || (job && job.salary) || '',
    status: status || 'collected',
    source: source || '',
    error: extra.error || '',
    firstCollectedAt: extra.firstCollectedAt || undefined,
    lastSeenAt: extra.lastSeenAt || undefined,
    lastHandledAt: extra.lastHandledAt || undefined,
  };
}

/**
 * 将采集到的岗位异步写入 IndexedDB，用于后续查重、回溯和备份。
 */
function saveCollectedJobRecords(jobs, source) {
  if (typeof saveJobRecords !== 'function') return Promise.resolve([]);
  var records = (Array.isArray(jobs) ? jobs : []).map(function(job) {
    return mapJobToRecord(job, 'collected', source || 'collect');
  });
  if (!records.length) return Promise.resolve([]);
  return saveJobRecords(records).catch(function(e) {
    try { DiagLogger.warn('sw.jobRecords', '保存采集岗位记录失败: ' + (e && e.message || e)); } catch (_) {}
    return [];
  });
}

function mapSendResultStatus(result) {
  if (!result) return 'failed';
  if (result.alreadyChatted) return 'alreadyChatted';
  if (result.success) return 'sent';
  var error = String(result.error || '');
  if (result.missed || /未投递/.test(error)) return 'unsent';
  if (result.skipped) return 'skipped';
  return 'failed';
}

function normalizeJobIdentityText(value) {
  return String(value || '').trim().toLowerCase();
}

async function buildHandledHrSet() {
  var set = {};
  if (typeof getJobRecords !== 'function') return set;
  try {
    var records = await getJobRecords();
    (Array.isArray(records) ? records : []).forEach(function(record) {
      var status = String(record && record.status || '');
      if (status !== 'sent' && status !== 'alreadyChatted') return;
      var hr = normalizeJobIdentityText(record.hrName);
      var company = normalizeJobIdentityText(record.companyName || record.company);
      if (hr && company) set[company + '|' + hr] = status;
    });
  } catch (e) {
    try { DiagLogger.warn('sw.jobRecords', '读取历史 HR 记录失败: ' + (e && e.message || e)); } catch (_) {}
  }
  return set;
}

async function applyPostCollectRules(jobs, options) {
  var opts = options || {};
  var excludeKeywords = uniqueStrings(opts.excludeKeywords || state.excludeKeywords || []);
  var skipHistoryEnabled = opts.skipHistoryEnabled !== false;
  var excludeOutsource = opts.excludeOutsource !== false;
  var excludeSuspicious = opts.excludeSuspicious !== false;
  var handledHrSet = skipHistoryEnabled ? await buildHandledHrSet() : {};
  return (Array.isArray(jobs) ? jobs : []).map(function(job) {
    var excludeHit = findExcludeKeywordHit(job, excludeKeywords);
    if (excludeHit) {
      job.checked = false;
      job.excludeReason = '命中排除词：' + excludeHit;
    } else {
      job.excludeReason = '';
    }
    // 公司风险：外包 / 疑似机构。按开关决定是否排除 + 打标记供卡片展示。
    var risk = (typeof detectCompanyRisk === 'function') ? detectCompanyRisk(job) : null;
    if (risk) {
      job.companyRisk = risk;
      if ((risk.type === 'outsource' && excludeOutsource) || (risk.type === 'suspicious' && excludeSuspicious)) {
        job.checked = false;
        if (!job.excludeReason) job.excludeReason = '命中公司风险：' + risk.label;
      }
    } else {
      job.companyRisk = null;
    }
    var hr = normalizeJobIdentityText(job && (job.hrName || job.bossName));
    var company = normalizeJobIdentityText(job && (job.companyName || job.company));
    var historyStatus = hr && company ? handledHrSet[company + '|' + hr] : '';
    if (historyStatus) {
      job.checked = false;
      job.historySkipReason = historyStatus === 'alreadyChatted' ? '已沟通过同 HR' : '已投过同 HR';
    } else {
      job.historySkipReason = '';
    }
    return job;
  });
}

function mergeCollectedJobsById(jobs) {
  var byId = {};
  var out = [];
  (Array.isArray(jobs) ? jobs : []).forEach(function(job) {
    if (!job) return;
    var id = String(job.jobId || job.id || job.jobLink || job.link || '').trim();
    if (!id) return;
    if (!byId[id]) {
      byId[id] = job;
      job.matchedKeywords = uniqueStrings(job.matchedKeywords || (job.searchKeyword ? [job.searchKeyword] : []));
      out.push(job);
      return;
    }
    var existing = byId[id];
    existing.matchedKeywords = uniqueStrings((existing.matchedKeywords || []).concat(job.matchedKeywords || [], job.searchKeyword || []));
    if (!existing.searchKeyword && job.searchKeyword) existing.searchKeyword = job.searchKeyword;
    if (!existing.detail && job.detail) existing.detail = job.detail;
    if (!existing.desc && job.desc) existing.desc = job.desc;
    if (!existing.description && job.description) existing.description = job.description;
  });
  return out;
}

/**
 * 将投递结果异步回写岗位记录，更新为最终处理状态。
 */
function saveHandledJobRecords(results, source) {
  if (typeof saveJobRecords !== 'function') return Promise.resolve([]);
  var records = (Array.isArray(results) ? results : []).map(function(result) {
    var job = findStateJobById(result && result.jobId);
    return mapJobToRecord(job, mapSendResultStatus(result), source || 'send', {
      jobId: result && result.jobId,
      positionName: result && result.positionName,
      companyName: result && result.companyName,
      hrName: result && result.hrName,
      error: result && result.error,
      lastHandledAt: result && result.time ? new Date(result.time).toISOString() : new Date().toISOString(),
    });
  });
  if (!records.length) return Promise.resolve([]);
  return saveJobRecords(records).catch(function(e) {
    try { DiagLogger.warn('sw.jobRecords', '保存投递岗位记录失败: ' + (e && e.message || e)); } catch (_) {}
    return [];
  });
}

function countJobsWithJD(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) {
    return !!String(job && (job.detail || job.desc || job.description) || '').trim();
  }).length;
}

function countPendingJdJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter(function(job) {
    return job && job.jdStatus !== 'success';
  }).length;
}

function buildBatchOverviewPrompt(jobs, expected) {
  var compactJobs = (Array.isArray(jobs) ? jobs : []).map(function(job) {
    return {
      title: String(job && job.name || ''),
      company: String(job && job.company || ''),
      salary: String(job && job.salary || ''),
      tags: Array.isArray(job && job.tags) ? job.tags.slice(0, 6) : [],
      score: Number(job && job.aiScreen && job.aiScreen.score || 0),
      reason: String(job && job.aiScreen && job.aiScreen.reason || ''),
      checked: !!(job && job.checked),
      jdSnippet: String(job && (job.detail || job.desc || job.description) || '').trim().slice(0, 180),
    };
  });
  return [
    '请对这一整批岗位做一次整体认知筛选，只返回 JSON，不要 Markdown。',
    '',
    '[用户期望方向]',
    expected || '未提供',
    '',
    '[岗位列表]',
    JSON.stringify(compactJobs, null, 2),
    '',
    '返回格式：{"headline":"","good":[],"bad":[],"nextFocus":[],"pitfalls":[]}',
    'good 和 bad 分别写整批岗位的优点和缺点；nextFocus 写下次筛选应调整的方向；pitfalls 写应该避开的坑。每个数组 2-4 条。'
  ].join('\n');
}

function normalizeBatchOverview(raw, jobs, completedBatches) {
  var parsed = raw && typeof raw === 'object' ? raw : {};
  function cleanList(value) {
    return Array.isArray(value) ? value.map(String).map(function(item) {
      return item.trim();
    }).filter(Boolean).slice(0, 4) : [];
  }
  return {
    headline: String(parsed.headline || '').trim().slice(0, 120),
    good: cleanList(parsed.good),
    bad: cleanList(parsed.bad),
    nextFocus: cleanList(parsed.nextFocus),
    pitfalls: cleanList(parsed.pitfalls),
    coverage: {
      totalJobs: Array.isArray(jobs) ? jobs.length : 0,
      jobsWithJD: countJobsWithJD(jobs),
      pendingJobs: countPendingJdJobs(jobs),
      completedBatches: Number(completedBatches || 0),
    },
    updatedAt: Date.now(),
  };
}

async function generateBatchOverview(jobs, completedBatches) {
  var cfg = await getAiConfig();
  if (!cfg.apiKey || !cfg.model || !Array.isArray(jobs) || !jobs.length) {
    return buildEmptyBatchOverview();
  }
  var expected = allExpectedPositions(state).join(' / ');
  var messages = [
    { role: 'system', content: '你是求职批量筛选分析助手。严格输出一个 JSON 对象，字段为 headline、good、bad、nextFocus、pitfalls。' },
    { role: 'user', content: buildBatchOverviewPrompt(jobs, expected) }
  ];
  var text;
  try {
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'batch-overview', { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'batch-overview');
  }
  return normalizeBatchOverview(extractJsonObject(text), jobs, completedBatches);
}

/**
 * 规范化岗位摘要样本，作为“AI 改筛选条件”额外上下文。
 */
function buildRecentJobSamples(jobs, limit) {
  return (Array.isArray(jobs) ? jobs : []).slice(0, Math.max(0, Number(limit || 0))).map(function(job) {
    return {
      title: String(job && job.name || ''),
      company: String(job && job.company || ''),
      salary: String(job && job.salary || ''),
      tags: Array.isArray(job && job.tags) ? job.tags.slice(0, 6) : [],
      score: Number(job && job.aiScreen && job.aiScreen.score || 0),
      reason: String(job && job.aiScreen && job.aiScreen.reason || ''),
      excludeReason: String(job && job.excludeReason || ''),
      historySkipReason: String(job && job.historySkipReason || ''),
      searchKeyword: String(job && job.searchKeyword || ''),
    };
  });
}

/**
 * 生成筛选条件修改建议，只返回标准 JSON。
 */
async function generateFilterSuggestion(input) {
  var cfg = await getAiConfig();
  if (!cfg.apiKey || !cfg.model) throw new Error('请先在 AI 设置中保存 API Key 和模型');
  var payload = input && typeof input === 'object' ? input : {};
  var messages = [
    {
      role: 'system',
      content: '你是招聘筛选条件助手。只输出 JSON。字段缺失表示保持当前值不变；空数组或空字符串表示重置为不限；城市、行业、筛选项全部使用页面展示文案，不要 code；未识别项放到 ignored；未识别岗位词放到 customPositions。可用 excludeKeywords 表达应排除的岗位关键词，skipHistoryEnabled 控制是否跳过已投过的同 HR。'
    },
    {
      role: 'user',
      content: [
        '请根据用户说明修改求职筛选条件，只返回 JSON，不要解释。',
        '',
        '[用户说明]',
        String(payload.prompt || ''),
        '',
        '[当前筛选条件]',
        JSON.stringify(payload.filterState || {}, null, 2),
        '',
        '[文字简历]',
        String(payload.resumeText || '未提供'),
        '',
        '[最近岗位摘要样本]',
        JSON.stringify(payload.jobSamples || [], null, 2),
        '',
        '返回格式：{"summary":"","changes":{"selectedCities":[],"selectedPositions":[],"customPositions":[],"hrActiveFilter":"","selectedIndustries":[],"workAreas":[],"jobTypes":[],"salaryRanges":[],"experience":[],"education":[],"companySizes":[],"fundingStages":[],"excludeKeywords":[],"skipHistoryEnabled":true,"skipHistoryScope":"hr"},"ignored":[]}'
      ].join('\n')
    }
  ];
  var text;
  try {
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'filter-suggestion', { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'filter-suggestion');
  }
  var parsed = extractJsonObject(text);
  return {
    summary: String(parsed.summary || '').trim(),
    changes: parsed.changes && typeof parsed.changes === 'object' ? parsed.changes : {},
    ignored: Array.isArray(parsed.ignored) ? parsed.ignored.map(String).filter(Boolean).slice(0, 20) : [],
  };
}

async function applyAiScreeningToJobs(jobs) {
  const featureState = await chrome.storage.local.get([
    FEATURE_KEYS.AI_SCREENING_ENABLED,
    FEATURE_KEYS.OUTCOME_FEEDBACK_LEARNING_ENABLED,
  ]);
  if (featureState[FEATURE_KEYS.AI_SCREENING_ENABLED] === false) {
    state.aiScreeningProgress = { done: 0, total: 0, disabled: true };
    return jobs || [];
  }
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  if (!cfg.apiKey || !cfg.model || !jobs || !jobs.length) {
    state.aiScreeningProgress = {
      done: 0,
      total: (jobs || []).length,
      enabled: true,
      unconfigured: !cfg.apiKey || !cfg.model,
    };
    pushState();
    // 未配置 AI：默认全勾选（排除词/公司风险岗位在 applyPostCollectRules 中再取消）。
    (jobs || []).forEach(function(job) {
      if (job.checked === undefined) job.checked = true;
    });
    return jobs || [];
  }
  const threshold = cfg.scoreThreshold;
  const expected = allExpectedPositions(state).join(' / ');
  const feedbackContext = featureState[FEATURE_KEYS.OUTCOME_FEEDBACK_LEARNING_ENABLED] === true
    ? await getOutcomeFeedbackPromptContext()
    : '';
  const CONCURRENCY = 2;
  const BATCH_SIZE = 6; // 每批岗位数：批间持久化 + 短暂延迟，避免长时间高负载导致 SW 挂起/浏览器崩溃
  // 保活：Grok 单岗响应 40s+，超过 Chrome SW 空闲终止阈值（30s）。
  // 实测有效方式：setInterval 每 8s 创建一个 1s 后触发的 alarm，制造"待处理事件"，
  // 让 SW 在等待 Grok 响应期间保持活跃，不被 Chrome 空闲终止杀（否则筛选 promise 冻结）。
  state._screeningActive = true;
  var _screenKeepaliveTimer = setInterval(function() {
    try { chrome.alarms.create(_screenKeepaliveAlarm, { when: Date.now() + 1000 }).catch(function(){}); } catch (_) {}
  }, 8000);
  state._screenKeepaliveTimer = _screenKeepaliveTimer;
  // 断点续筛：从已完成的 done 开始（SW 重启后 state 恢复，继续未完成部分）
  let done = state.aiScreeningProgress && typeof state.aiScreeningProgress.done === 'number'
    ? Math.min(state.aiScreeningProgress.done, jobs.length)
    : 0;
  state.aiScreeningProgress = { done: done, total: jobs.length };
  pushState();

  for (let start = done; start < jobs.length; start += BATCH_SIZE) {
    const batchEnd = Math.min(start + BATCH_SIZE, jobs.length);
    const batch = jobs.slice(start, batchEnd);
    let idx = start;

    async function worker() {
      while (idx < batchEnd) {
        const current = jobs[idx++];
        try {
          const screening = await screenSingleJob(cfg, current, resumeText, expected, feedbackContext);
          current.aiScreen = screening;
          current.checked = screening.score >= threshold;
          current.status = screening.score >= threshold ? 'recommended' : 'manualReview';
          if (Object.prototype.hasOwnProperty.call(current, 'aiGreeting')) delete current.aiGreeting;
        } catch (err) {
          current.aiScreen = {
            score: 0,
            applyScore: 0,
            applyReason: 'AI筛选失败',
            interviewScore: 0,
            interviewReason: 'AI筛选失败',
            reason: 'AI筛选失败，请人工确认',
            risks: [err.message || 'AI error'],
            failed: true,
          };
          if (current.checked === undefined) current.checked = true;
          current.status = 'manualReview';
          ErrorLogger.logError(err.message || String(err), err?.stack, 'AI screening failed');
        }
        done++;
        state.aiScreeningProgress = { done: done, total: jobs.length };
        state.jobs = jobs;
        pushState();
        // 持久化筛选进度，SW 重启后可断点续筛
        try { chrome.storage.local.set({ 'aiScreeningProgress': state.aiScreeningProgress }).catch(() => {}); } catch (_) {}
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batchEnd - start) }, () => worker()));
    // 批间短暂延迟 + 持久化，给 SW 喘息，降低长任务挂起风险
    await new Promise(r => setTimeout(r, 300));
  }
  state.aiScreeningProgress = { done: jobs.length, total: jobs.length };
  state._screeningActive = false;
  if (state._screenKeepaliveTimer) { clearInterval(state._screenKeepaliveTimer); state._screenKeepaliveTimer = null; }
  try { chrome.alarms.clear(_screenKeepaliveAlarm).catch(function(){}); } catch (_) {}
  pushState();
  return jobs;
}

async function fetchJobDetailText(jobLink) {
  if (!jobLink) return '';
  const tab = await chrome.tabs.create({ url: jobLink, active: false });
  const tabId = tab.id;
  try {
    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_JOB_DETAIL' });
    return (resp && resp.success && resp.detail) ? String(resp.detail).trim() : '';
  } catch (_) {
    return '';
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (_) {}
  }
}

let jdHydrationRunning = false;

function buildJdHydrationProgress(jobs, running, completedBatches, stalledBatches) {
  var list = Array.isArray(jobs) ? jobs : [];
  var success = list.filter(function(job) { return job && job.jdStatus === 'success'; }).length;
  var pending = list.filter(function(job) { return job && job.jdStatus !== 'success'; }).length;
  var failed = list.filter(function(job) { return job && job.jdStatus === 'failed'; }).length;
  return {
    running: !!running,
    done: success,
    total: list.length,
    success: success,
    failed: failed,
    pending: pending,
    completedBatches: Number(completedBatches || 0),
    stalledBatches: Number(stalledBatches || 0),
  };
}

async function refreshBatchOverview(force) {
  var jobs = Array.isArray(state.jobs) ? state.jobs : [];
  if (!jobs.length) {
    state.aiBatchOverview = buildEmptyBatchOverview();
    updateAiOverviewSummary(Object.assign(buildEmptyAiOverviewSummary('无岗位可分析'), {
      status: 'skipped',
    }));
    pushState();
    return;
  }
  try {
    var featureState = await chrome.storage.local.get(FEATURE_KEYS.AI_SCREENING_ENABLED);
    if (featureState[FEATURE_KEYS.AI_SCREENING_ENABLED] === false) {
      state.aiBatchOverview = buildEmptyBatchOverview();
      updateAiOverviewSummary({
        status: 'skipped',
        reason: 'AI 岗位筛选已关闭',
        totalJobs: jobs.length,
        jobsWithJD: countJobsWithJD(jobs),
        pendingJobs: countPendingJdJobs(jobs),
        failedJdJobs: countFailedJdJobs(jobs),
        completedBatches: state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0,
      });
      pushState();
      return;
    }
    var cfg = await getAiConfig();
    if (!cfg.apiKey || !cfg.model) {
      state.aiBatchOverview = buildEmptyBatchOverview();
      updateAiOverviewSummary({
        status: 'skipped',
        reason: '未配置 AI API Key 或模型',
        totalJobs: jobs.length,
        jobsWithJD: countJobsWithJD(jobs),
        pendingJobs: countPendingJdJobs(jobs),
        failedJdJobs: countFailedJdJobs(jobs),
        completedBatches: state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0,
      });
      pushState();
      return;
    }
    updateAiOverviewSummary({
      status: 'running',
      reason: '',
      totalJobs: jobs.length,
      jobsWithJD: countJobsWithJD(jobs),
      pendingJobs: countPendingJdJobs(jobs),
      failedJdJobs: countFailedJdJobs(jobs),
      completedBatches: state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0,
    });
    var overview = await generateBatchOverview(jobs, state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0);
    state.aiBatchOverview = overview;
    updateAiOverviewSummary({
      status: hasBatchOverviewContent(overview) ? 'ready' : 'empty',
      reason: hasBatchOverviewContent(overview) ? '' : 'AI 返回空总览',
      totalJobs: jobs.length,
      jobsWithJD: countJobsWithJD(jobs),
      pendingJobs: countPendingJdJobs(jobs),
      failedJdJobs: countFailedJdJobs(jobs),
      completedBatches: state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0,
    });
    pushState();
  } catch (e) {
    ErrorLogger.logError(e.message || String(e), e?.stack, 'generate batch overview failed');
    updateAiOverviewSummary({
      status: 'failed',
      reason: (e && e.message || String(e)).slice(0, 160),
      totalJobs: jobs.length,
      jobsWithJD: countJobsWithJD(jobs),
      pendingJobs: countPendingJdJobs(jobs),
      failedJdJobs: countFailedJdJobs(jobs),
      completedBatches: state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0,
    });
    if (force || !state.aiBatchOverview) {
      state.aiBatchOverview = normalizeBatchOverview({}, jobs, state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0);
      pushState();
    }
  }
}

async function runSingleJdHydrationBatch(jobs, batchJobs) {
  var queue = Array.isArray(batchJobs) ? batchJobs : [];
  var idx = 0;
  var successCount = 0;
  async function worker() {
    while (idx < queue.length) {
      var job = queue[idx++];
      createJobHydrationMeta(job);
      job.jdStatus = 'pending';
      job.jdAttempts += 1;
      var detail = '';
      try {
        detail = await fetchJobDetailText(job.link);
      } catch (e) {
        job.jdLastError = e.message || String(e);
      }
      if (detail) {
        job.detail = detail;
        job.desc = detail;
        job.jdStatus = 'success';
        job.jdLastError = '';
        successCount += 1;
      } else {
        job.jdStatus = 'failed';
        if (!job.jdLastError) job.jdLastError = 'JD 详情为空';
      }
      state.jobs = jobs;
      pushState();
    }
  }
  await Promise.all(Array.from({
    length: Math.min(CONFIG.JD_HYDRATION_CONCURRENCY || 2, Math.max(queue.length, 1))
  }, function() { return worker(); }));
  return successCount;
}

async function scheduleJdHydration(options) {
  if (jdHydrationRunning) return;
  var opts = options || {};
  var jobs = Array.isArray(state.jobs) ? state.jobs : [];
  ensureJobHydrationMeta(jobs);
  jdHydrationRunning = true;
  var completedBatches = state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0;
  var stalledBatches = 0;
  state.jdHydrationProgress = buildJdHydrationProgress(jobs, true, completedBatches, stalledBatches);
  updateAiOverviewSummary({
    status: state.aiOverviewSummary && state.aiOverviewSummary.status || 'idle',
    totalJobs: jobs.length,
    jobsWithJD: countJobsWithJD(jobs),
    pendingJobs: countPendingJdJobs(jobs),
    failedJdJobs: countFailedJdJobs(jobs),
    completedBatches: completedBatches,
  });
  pushState();

  try {
    while (true) {
      var pending = jobs.filter(function(job) {
        createJobHydrationMeta(job);
        return job && job.link && job.jdStatus !== 'success';
      });
      if (!pending.length) break;
      var currentBatch = pending.slice(0, CONFIG.JD_HYDRATION_BATCH_SIZE || 12);
      var newSuccess = await runSingleJdHydrationBatch(jobs, currentBatch);
      completedBatches += 1;
      stalledBatches = newSuccess > 0 ? 0 : stalledBatches + 1;
      state.jdSamples = sampleJDs(clusterJobs(jobs, state.selectedPositions, state.customPositions), 5);
      state.jdHydrationProgress = buildJdHydrationProgress(jobs, true, completedBatches, stalledBatches);
      updateAiOverviewSummary({
        status: state.aiOverviewSummary && state.aiOverviewSummary.status || 'idle',
        totalJobs: jobs.length,
        jobsWithJD: countJobsWithJD(jobs),
        pendingJobs: countPendingJdJobs(jobs),
        failedJdJobs: countFailedJdJobs(jobs),
        completedBatches: completedBatches,
      });
      pushState();
      if (newSuccess > 0 || completedBatches === 1 || opts.forceOverviewRefresh) {
        await refreshBatchOverview(false);
      }
      if (stalledBatches >= (CONFIG.JD_HYDRATION_STALL_LIMIT || 2)) break;
    }
  } finally {
    jdHydrationRunning = false;
    state.jdHydrationProgress = buildJdHydrationProgress(jobs, false, completedBatches, stalledBatches);
    updateAiOverviewSummary({
      status: state.aiOverviewSummary && state.aiOverviewSummary.status || 'idle',
      reason: stalledBatches >= (CONFIG.JD_HYDRATION_STALL_LIMIT || 2) && countPendingJdJobs(jobs) ? 'JD 补拉连续无新增，已暂停' : (state.aiOverviewSummary && state.aiOverviewSummary.reason || ''),
      totalJobs: jobs.length,
      jobsWithJD: countJobsWithJD(jobs),
      pendingJobs: countPendingJdJobs(jobs),
      failedJdJobs: countFailedJdJobs(jobs),
      completedBatches: completedBatches,
    });
    pushState();
  }
}

async function generateGreeting(apiKey, resumeImages, jdSamples, category) {
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  const systemPrompt = '你是求职者本人，正在 BOSS 直聘上给 HR 发送招呼语。只输出招呼语正文，不要输出解释、标题、Markdown 或字数统计。';
  const jdText = (jdSamples || []).slice(0, 5).map((jd, i) => {
    return `${i + 1}. ${jd.title || ''}\n${(jd.tags || []).join(' / ')}\n${String(jd.desc || '').slice(0, 500)}`;
  }).join('\n\n');
  const userPrompt = `请根据简历和岗位方向生成一段 70-110 字招呼语。\n\n[简历]\n${resumeText || '未提供文字简历，请根据岗位方向写通用但真诚的招呼语。'}\n\n[应聘方向]\n${category}\n\n[岗位样本]\n${jdText || '暂无岗位样本'}\n\n要求：以“您好”开头；只说 1-2 个与岗位最相关的真实匹配点；口语、自然、简短；结尾用“方便沟通吗”或同类问句。不要写求职者姓名、招聘者姓名、客户名、公司名、学校名或署名；不要声称已发送、已附上或稍后发送简历/附件。`;
  const generated = await callOpenAICompatible(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 500, 120000, `greeting:${category}`);
  return sanitizeGeneratedGreeting(generated);
}

// ── Resume image cache (compressed, reused across batch calls) ──
let _cachedResumeImages = null;

// Blob → base64（不含 data URL 前缀）
function _blobToBase64(blob) {
  return new Promise(r => {
    const reader = new FileReader();
    reader.onloadend = () => r(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

// 自适应压缩单张简历图至目标 base64 体积以内。
// 当前 AI 主路径使用文字简历；保留压缩能力供原发送链和后续多模态增强复用。
async function _compressResumeImage(bitmap, targetBytes) {
  // 档位由清晰到压缩，命中 targetBytes 即停，逐档收紧到 400px/q0.4 兜底。
  const STEPS = [
    { w: 640, q: 0.78 },
    { w: 640, q: 0.7 },
    { w: 640, q: 0.6 },
    { w: 560, q: 0.5 },
    { w: 480, q: 0.45 },
    { w: 400, q: 0.4 },
  ];
  let lastBase64 = null;
  for (const step of STEPS) {
    let w = bitmap.width, h = bitmap.height;
    if (w > step.w) { h = Math.round(h * step.w / w); w = step.w; }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: step.q });
    const base64 = await _blobToBase64(blob);
    lastBase64 = base64;
    // base64 长度即近似字节数（每字符 1 byte），略大于实际解码字节，做体积闸足够保守。
    if (base64.length <= targetBytes) {
      return base64;
    }
  }
  // 所有档位都超目标：返回最小那档（已是 400px/q0.4），尽力而为
  return lastBase64;
}

async function loadResumeImages() {
  if (_cachedResumeImages !== null) return _cachedResumeImages;

  try {
    const { resumeImages: stored } = await chrome.storage.local.get('resumeImages');
    if (!stored || !Array.isArray(stored) || stored.length === 0) {
      _cachedResumeImages = [];
      return [];
    }

    // 最多 2 张简历图，保留压缩缓存供发送链路和后续多模态 AI 复用。
    const toProcess = stored.slice(0, 2);
    const targetBytes = 90 * 1024;
    const results = [];

    for (const s of toProcess) {
      const bytes = new Uint8Array(s.data);
      const mimeType = s.type || 'image/png';

      try {
        const blob = new Blob([bytes], { type: mimeType });
        const bitmap = await createImageBitmap(blob);
        const base64 = await _compressResumeImage(bitmap, targetBytes);
        bitmap.close();
        results.push({ type: 'image/jpeg', base64 });
      } catch (e) {
        // 压缩失败降级：不发原图（必 413），而是缩到 400px/q0.4 再试一次；仍失败则跳过这张图。
        // 取舍：宁可少喂一张图也不让超大图阻断招呼语，也不发必 413 的大图。
        console.warn('[猎职] Image compress fallback:', e.message);
        ErrorLogger.logError(e.message, e.stack, 'Image compress fallback');
        try {
          const blob = new Blob([bytes], { type: mimeType });
          const bitmap = await createImageBitmap(blob);
          let w = bitmap.width, h = bitmap.height;
          if (w > 400) { h = Math.round(h * 400 / w); w = 400; }
          const canvas = new OffscreenCanvas(w, h);
          canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
          const cblob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.4 });
          bitmap.close();
          const base64 = await _blobToBase64(cblob);
          results.push({ type: 'image/jpeg', base64 });
        } catch (e2) {
          console.warn('[猎职] Image compress fallback failed, skip image:', e2.message);
          ErrorLogger.logError(e2.message, e2.stack, 'Image compress fallback skip');
        }
      }
    }

    _cachedResumeImages = results;
    return results;
  } catch (e) {
    console.warn('[猎职] Failed to load resume images:', e);
    ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages');
    _cachedResumeImages = [];
    return [];
  }
}

// 商业化：重写迁移到后端 /rewrite（藏 Key，复用 /greeting 计费闸口，堵白嫖漏）。
// apiKey 参数保留仅为兼容调用方签名（doRewriteGreeting 仍传入），后端不再用客户端 Key。
async function rewriteGreeting(apiKey, originalGreeting, instruction, blockedNames) {
  const cfg = await getAiConfig();
  const rewritten = await callOpenAICompatible(cfg, [
    { role: 'system', content: '你是求职助手，帮助用户优化 BOSS 直聘招呼语。只输出重写后的招呼语正文。不得添加求职者姓名、招聘者姓名、客户名、公司名或署名。' },
    { role: 'user', content: `原招呼语：\n${originalGreeting}\n\n重写要求：${instruction}\n\n输出要求：70-120字，真诚、自然、简短；只保留 1-2 个岗位匹配点；不要声称已发送或附上简历/附件。` },
  ], 500, 60000, 'rewrite');
  return sanitizeGeneratedGreeting(rewritten, blockedNames);
}

// ── 状态管理 ──
let state = {
  phase: 'idle',
  jobs: [],
  greetings: {},
  aiScreeningProgress: { done: 0, total: 0 },
  aiBatchOverview: buildEmptyBatchOverview(),
  aiOverviewSummary: buildEmptyAiOverviewSummary(),
  collectionSummary: buildEmptyCollectionSummary(),
  jdHydrationProgress: { running: false, done: 0, total: 0, success: 0, failed: 0, pending: 0, completedBatches: 0, stalledBatches: 0 },
  jobCustom: {},            // per-job 自定义（来自 ui:jobCustom）：{[jobId]:{customGreeting,images,...}}，发送前从 storage 灌入；buildSendQueueV6 按 jobId 取 customGreeting 覆盖组级招呼语
  greetingProgress: { done: 0, total: 0 },
  sendProgress: { sent: 0, total: 0 },
  autoReplyCount: 0,
  sendResults: [],
  sendDuration: 0,
  searchUrlParams: null,    // 原始搜索 URL 参数，发送阶段导航回正确搜索结果页
  chatTabId: null,
  sendQueue: [],        // [{jobId, positionName, companyName, jobLink, greeting}]
  sendIndex: 0,
  searchTabId: null,
  sendGreeting: true,
  sendPhase: '',            // '' | 'stage1' | 'stage2'
  sendQueueV6: [],          // [{jobId, hrName, hrCompany, greeting, positionName, companyName}]
  _v6CurrentBatchQueue: [],  // 本批原始队列快照：终态补齐已取走但未落账的岗位
  sendQueueV6Index: 0,
  _v6WorkerTabIds: [],      // worker tab id 数组
  _v6WorkerWindowIds: [],   // worker tab 所在的独立后台窗口 id 数组
  _v6SearchReady: false,    // 搜索 tab CS 就绪标记
  _v6WorkerTabsReady: new Set(),  // 已就绪的 worker tab id 集合
  _v6MissedJobs: [],        // 已建联但未确认送达的岗位，终态时提示用户逐岗人工核对
  originalMainWindowId: null,
  // ── 1.4.0 自动投递（MVP）状态 ──
  autoRun: null,            // { runId, config, status, frozenJobIds, attemptLog[], preview }
};

// 中断恢复用：发送过的 jobId 集合
const sentJobIds = new Set();

// 发送批次开始时间（计算总耗时用，不持久化）
let sendStartTime = 0;

// 硬中止：stopSend 触发后立即了结 runStage1 的 pending promise（不等 120s 超时）
// abortStage1 在 runStage1 期间被设为可触发的函数；stopSend 调用它让 stage1 立刻 settle。
let abortStage1 = null;
// 全局停止标记：startSendV6/runWorkerLoop 在各阶段边界检查，停了立即 bail
let sendAborted = false;
// 1.4.0 自动投递独立停止标记：不受 startSendV6 内部 sendAborted 重置影响
let autoRunAbort = false;
const pendingSingleSendConfirmations = new Map();
let singleSendLaunchInProgress = false;
const SINGLE_SEND_CONFIRMATION_VERSION = 3;
const SINGLE_SEND_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

function normalizeImageConsentKeys(imageKeys) {
  return (Array.isArray(imageKeys) ? imageKeys : [])
    .slice(0, CONFIG.RESUME_MAX_COUNT)
    .map(function(key) { return String(key || '').trim().slice(0, 512); })
    .filter(Boolean);
}

function createSingleSendConfirmation(confirmation) {
  var now = Date.now();
  // 顺带清理已过期 token（防 Map 无限增长）
  pendingSingleSendConfirmations.forEach(function(rec, key) {
    if (rec && rec.expiresAt < now) pendingSingleSendConfirmations.delete(key);
  });
  var token = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
  pendingSingleSendConfirmations.set(token, {
    jobId: String(confirmation.jobId),
    greeting: String(confirmation.greeting || '').trim(),
    sendImages: confirmation.sendImages === true,
    imageKeys: normalizeImageConsentKeys(confirmation.imageKeys),
    blockedNames: uniqueStrings(confirmation.blockedNames),
    expiresAt: now + SINGLE_SEND_CONFIRMATION_TTL_MS,
  });
  return token;
}

function updateJobStatus(jobId, status) {
  var job = findStateJobById(jobId);
  if (!job) return;
  job.status = status;
  if (status === 'sent' || status === 'alreadyChatted' || status === 'skipped') {
    job.checked = false;
  }
}

function findSendResultByJobId(jobId) {
  for (var i = state.sendResults.length - 1; i >= 0; i--) {
    if (state.sendResults[i] && String(state.sendResults[i].jobId) === String(jobId)) {
      return state.sendResults[i];
    }
  }
  return null;
}

let confirmedDeliveryPersistChain = Promise.resolve();

function persistConfirmedDelivery() {
  const snapshot = {
    [STORAGE_KEYS.SW.JOBS]: state.jobs.slice(),
    [STORAGE_KEYS.SW.SENT_JOB_IDS]: Array.from(sentJobIds),
    [STORAGE_KEYS.SW.SEND_RESULTS]: state.sendResults.slice(),
  };
  confirmedDeliveryPersistChain = confirmedDeliveryPersistChain
    .catch(() => {})
    .then(() => chrome.storage.local.set(snapshot))
    .catch((error) => {
      try { ErrorLogger.logError(error.message || String(error), error.stack, 'confirmed delivery persistence failed'); } catch (_) {}
    });
  return confirmedDeliveryPersistChain;
}

async function readOutcomeFeedbackRecords() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SW.OUTCOME_FEEDBACK);
  return JobOutcomeFeedback.normalizeRecords(stored[STORAGE_KEYS.SW.OUTCOME_FEEDBACK]);
}

async function getOutcomeFeedbackPromptContext() {
  const records = await readOutcomeFeedbackRecords();
  return records.length >= 5 ? JobOutcomeFeedback.buildPromptContext(records) : '';
}

async function getJobOutcomeFeedback(jobIds) {
  const records = await readOutcomeFeedbackRecords();
  return {
    records: JobOutcomeFeedback.recordsByJobId(records, jobIds),
    summary: JobOutcomeFeedback.buildSummary(records),
  };
}

async function findConfirmedSendResult(jobId) {
  const inMemory = findSendResultByJobId(jobId);
  if (inMemory && inMemory.success === true) return inMemory;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SW.SEND_RESULTS);
  return (Array.isArray(stored[STORAGE_KEYS.SW.SEND_RESULTS])
    ? stored[STORAGE_KEYS.SW.SEND_RESULTS]
    : []).find(function (sendResult) {
    return sendResult
      && sendResult.success === true
      && String(sendResult.jobId) === String(jobId);
  }) || null;
}

async function findFeedbackScore(jobId) {
  const inMemory = findStateJobById(jobId);
  if (inMemory && inMemory.aiScreen) return inMemory.aiScreen.score;
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SW.JOBS);
  const jobs = Array.isArray(stored[STORAGE_KEYS.SW.JOBS]) ? stored[STORAGE_KEYS.SW.JOBS] : [];
  const persisted = jobs.find(function (job) {
    return String(job && (job.id || job.jobId)) === String(jobId);
  });
  return persisted && persisted.aiScreen ? persisted.aiScreen.score : undefined;
}

async function recordJobOutcome(message) {
  const sendResult = await findConfirmedSendResult(message && message.jobId);
  if (!sendResult || sendResult.success !== true) {
    throw new Error('只能为已确认送达的岗位标记后续结果');
  }
  const existing = await readOutcomeFeedbackRecords();
  if (message.outcome === 'clear') {
    const remaining = JobOutcomeFeedback.removeRecord(existing, message.jobId);
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.OUTCOME_FEEDBACK]: remaining });
    return { record: null, summary: JobOutcomeFeedback.buildSummary(remaining) };
  }
  const record = JobOutcomeFeedback.createRecord({
    jobId: message.jobId,
    outcome: message.outcome,
    score: await findFeedbackScore(message.jobId),
  });
  if (!record) throw new Error('反馈结果不支持');
  const records = JobOutcomeFeedback.upsertRecord(existing, record);
  await chrome.storage.local.set({ [STORAGE_KEYS.SW.OUTCOME_FEEDBACK]: records });
  return {
    record: record,
    summary: JobOutcomeFeedback.buildSummary(records),
  };
}

function consumeSingleSendConfirmation(token, jobId) {
  var record = pendingSingleSendConfirmations.get(String(token || ''));
  pendingSingleSendConfirmations.delete(String(token || ''));
  if (!record
    || record.jobId !== String(jobId)
    || record.expiresAt < Date.now()) return null;
  return record;
}

function isTrustedPopupSender(sender) {
  if (!sender) return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  var url = String(sender.url || '');
  if (url !== chrome.runtime.getURL('src/popup/popup.html')) return false;
  try {
    var extOrigin = new URL(chrome.runtime.getURL('')).origin;
    if (new URL(url).origin !== extOrigin) return false;
  } catch (_) { return false; }
  return true;
}

// ── #39 阶段1跳转恢复环（纯内存，SW 若死整个任务走既有 resume 路径） ──
// 现象：同 HR 新岗位点「立即沟通」→ BOSS 把搜索页整页跳 /web/geek/chat，确认弹窗弹在
// 消息页，搜索页 CS 死亡，EXTRACT_COMPLETE 永远不来 → stage1 卡到超时。
// 恢复：消息页 CS 点确认弹窗 → 该岗按建联成功落账 → goBack 回搜索页 → 重发剩余队列。
let _stage1SentQueue = null;       // runStage1 首次 doSend 发出的原始队列（恢复重发不重置，基准恒定）
let _stage1DoneJobIds = new Set(); // 本轮 stage1 已处理过的 jobId（itemDone 即 done，无论成败）——重发切片按它过滤，不依赖下标
let _stage1RecoveryActive = false; // 恢复序列进行中防重入
let _stage1RecoveryCount = 0;      // 单次 runStage1 内恢复次数（上限 STAGE1_RECOVERY_MAX）
let _stage1ResendQueue = null;     // runStage1 闭包暴露：重发剩余队列切片 + 重置总超时
let _stage1ForceSettle = null;     // runStage1 闭包暴露：恢复不能续时强制 settle，汇入现有终态路径
const STAGE1_RECOVERY_MAX = 30;

function claimNextJob(state) {
  if (state.sendQueueV6Index >= state.sendQueueV6.length) return null;
  var job = state.sendQueueV6[state.sendQueueV6Index];
  state.sendQueueV6Index++;
  return job;
}

function buildSendQueueV6(state, jobIds, sendOptions) {
  // 用「期望岗位名」作为 greeting key，与 B 页 / clusterJobs 完全一致
  // （旧实现用 job.tags[0]=BOSS卡片标签当 key，与生成时的岗位名 key 错配 → greeting 取空）
  var picker = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  var custom = Array.isArray(state.customPositions) ? state.customPositions : [];
  return jobIds
    .filter(function(id) { return !sentJobIds.has(id); })
    .map(function(id) {
      var job = state.jobs.find(function(j) { return (j.jobId || j.id) === id; });
      if (!job) { console.warn('[猎职] buildSendQueueV6: 未找到 job id=' + id); }
      var category = job ? matchJobToPosition(job, picker, custom) : '其他';
      var jobCompanyNames = job ? [job.company, job.companyName] : [];
      var reviewedGreeting = sendOptions && typeof sendOptions.confirmedGreeting === 'string'
        ? sendOptions.confirmedGreeting.trim()
        : '';
      var confirmedGreeting = '';
      if (reviewedGreeting) {
        var currentBlockedNames = jobCompanyNames.concat(sendOptions && sendOptions.blockedNames);
        var checkedGreeting = sanitizeGeneratedGreeting(reviewedGreeting, currentBlockedNames);
        if (!checkedGreeting || checkedGreeting !== reviewedGreeting) {
          var greetingReviewError = new Error('招呼语关联信息已变化，请重新逐岗复核');
          greetingReviewError.errorCode = 'GREETING_REVIEW_REQUIRED';
          throw greetingReviewError;
        }
        confirmedGreeting = reviewedGreeting;
      }
      // 1.4.0: 每岗自动生成招呼语优先（autoRun 预生成存 state.greetings[jobId]={text,...}）
      var autoJobGreeting = '';
      var _autoGreet = state.greetings && state.greetings[id];
      if (_autoGreet && typeof _autoGreet === 'object' && typeof _autoGreet.text === 'string' && _autoGreet.text) {
        autoJobGreeting = sanitizeGeneratedGreeting(_autoGreet.text, jobCompanyNames);
      } else if (typeof _autoGreet === 'string' && _autoGreet) {
        autoJobGreeting = sanitizeGeneratedGreeting(_autoGreet, jobCompanyNames);
      }
      var greeting = confirmedGreeting || (
        state.sendGreeting === false
          ? ''
          : (autoJobGreeting || sanitizeGeneratedGreeting(state.greetings[category] || '', jobCompanyNames))
      );
      // per-job 自定义招呼语优先：该岗设了非空 customGreeting → 覆盖组级招呼语；为空/未设则保持组级 fallback（行为不变）
      var jcEntry = state.jobCustom && state.jobCustom[id];
      var jcGreeting = jcEntry && typeof jcEntry.customGreeting === 'string'
        ? sanitizeGeneratedGreeting(jcEntry.customGreeting, jobCompanyNames)
        : '';
      if (state.sendGreeting !== false && !confirmedGreeting && jcGreeting) {
        greeting = jcGreeting;
        try { DiagLogger.info('sw.send', 'buildSendQueueV6：jobId=' + id + ' 用 per-job 自定义招呼语 len=' + jcGreeting.length); } catch (_) {}
      }
      var sendImages = !!(sendOptions && sendOptions.sendImages);
      return {
        jobId: id,
        hrName: '',
        hrCompany: '',
        greeting: greeting,
        confirmationVersion: SINGLE_SEND_CONFIRMATION_VERSION,
        confirmationExpiresAt: Number(sendOptions && sendOptions.confirmationExpiresAt) || 0,
        sendImages: sendImages,
        imageKeys: sendImages ? normalizeImageConsentKeys(sendOptions.imageKeys) : [],
        blockedNames: uniqueStrings(sendOptions && sendOptions.blockedNames),
        positionName: job ? (job.name || job.positionName || '') : '',
        companyName: job ? (job.company || job.companyName || '') : '',
        jobLink: job ? (job.jobLink || 'https://www.zhipin.com/job_detail/' + (job.id || job.jobId) + '.html') : ''
      };
    });
}

// ── per-job 自定义招呼语：从 ui:jobCustom 灌入 state.jobCustom ──
// buildSendQueueV6 是同步函数，无法自己 await storage；故在每次建队前（startSendV6 / 恢复路径）先异步灌好。
// popup 发送前会强制落盘 ui:jobCustom（绕过 300ms 防抖），保证这里读到的是最新自定义招呼语。
async function loadJobCustomIntoState() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.UI.JOB_CUSTOM);
    state.jobCustom = r[STORAGE_KEYS.UI.JOB_CUSTOM] || {};
  } catch (_) {
    state.jobCustom = state.jobCustom || {};
  }
}

async function loadSendGreetingPreference() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
    const fs = r[STORAGE_KEYS.UI.FILTER_STATE] || {};
    state.sendGreeting = fs.sendGreeting !== false;
  } catch (_) {
    state.sendGreeting = true;
  }
}

// ── 空/占位招呼语保险丝 ──
// greeting 为空或等于生成失败占位串的岗位发出去就是空消息，
// 一律不入队，记一条失败 sendResults（结构对齐 stage1 提取失败的 skipped 记录）。
var GREETING_PLACEHOLDERS = ['生成失败，请刷新', '请重新上传清晰的简历图片'];
function isGreetingMissing(g) {
  var t = (g || '').trim();
  return !t || GREETING_PLACEHOLDERS.indexOf(t) >= 0;
}
function dropMissingGreetingJobs() {
  if (state.sendGreeting === false) return;
  var dropped = state.sendQueueV6.filter(function(item) { return isGreetingMissing(item.greeting); });
  if (!dropped.length) return;
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return !isGreetingMissing(item.greeting); });
  for (var i = 0; i < dropped.length; i++) {
    recordV6TerminalResult(dropped[i], {
      skipped: true,
      error: 'AI招呼语缺失，未投递（请刷新重新采集）',
    });
  }
  console.warn('[猎职] 空招呼语保险丝：剔除', dropped.length, '个岗位不入队');
  pushState();
}

/** 为未产出 worker 结果的队列项补记一次终态 sendResults。 */
function recordV6TerminalResult(item, opts) {
  if (!item || item.jobId == null || findSendResultByJobId(item.jobId)) return false;
  opts = opts || {};
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId,
    positionName: item.positionName || '',
    companyName: item.companyName || '',
    success: !!opts.success,
    skipped: opts.skipped !== false,
    hrName: item.hrName || '',
    error: opts.error || '未投递',
    stage: opts.stage || null,
    time: Date.now(),
  });
  updateJobStatus(item.jobId, opts.skipped !== false ? 'skipped' : 'failed');
  return true;
}

/** 汇总所有 v6 队列来源，按 jobId 去重后供终态补记使用。 */
function collectV6QueueSnapshot() {
  var seen = {};
  var out = [];
  var addList = function(list) {
    list = Array.isArray(list) ? list : [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it || it.jobId == null || seen[it.jobId]) continue;
      seen[it.jobId] = true;
      out.push(it);
    }
  };
  addList(state.sendQueueV6);
  addList(state._v6CurrentBatchQueue);
  return out;
}

// ── 状态持久化：确保 SW 重启后 popup 能恢复 B 页 ──
let persistTimer = null;

// 诊断旁路：从当前内存态抽取脱敏快照摘要（与 diag-export.js buildSnapshot 同口径：
// 招呼语只留长度+前 20 字，绝不 dump apiKey/简历/手机号）。SW 卸载后导出 fallback 读它。
function buildSnapshotSummary() {
  try {
    var snap = {
      ts: Date.now(),
      phase: state.phase,
      sendPhase: state.sendPhase || '',
      jobs: (state.jobs || []).length,
      sendQueueV6: (state.sendQueueV6 || []).length,
      sendQueueV6Index: state.sendQueueV6Index || 0,
      sendProgress: state.sendProgress || {},
      greetingProgress: state.greetingProgress || {},
      selectedPositions: state.selectedPositions || [],
      customPositions: state.customPositions || [],
      hrActiveFilter: state.hrActiveFilter || '不限',
      workerTabs: (state._v6WorkerTabIds || []).length,
      missedJobs: (state._v6MissedJobs || []).length,
      sendResultsCount: (state.sendResults || []).length,
      collectionSummary: state.collectionSummary || buildEmptyCollectionSummary(),
      aiOverviewSummary: state.aiOverviewSummary || buildEmptyAiOverviewSummary(),
    };
    var g = state.greetings || {};
    snap.greetings = {};
    for (var k in g) {
      if (Object.prototype.hasOwnProperty.call(g, k)) {
        var gv = String(g[k] == null ? '' : g[k]);
        snap.greetings[k] = (gv.length > 20 ? gv.slice(0, 20) + '…' : gv) + ' (len=' + gv.length + ')';
      }
    }
    return snap;
  } catch (e) { return { ts: Date.now(), _snapshotError: String(e && e.message || e) }; }
}

function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const toSave = {
      [STORAGE_KEYS.SW.PHASE]: state.phase,
      [STORAGE_KEYS.SW.JOBS]: state.jobs,
      [STORAGE_KEYS.SW.GREETINGS]: state.greetings,
      [STORAGE_KEYS.SW.SEND_PROGRESS]: state.sendProgress,
      [STORAGE_KEYS.SW.SENT_JOB_IDS]: Array.from(sentJobIds),
      [STORAGE_KEYS.SW.SEND_RESULTS]: state.sendResults,
      [STORAGE_KEYS.SW.SEND_DURATION]: state.sendDuration,
      [STORAGE_KEYS.SW.SEARCH_URL]: state.searchUrlParams,
      [STORAGE_KEYS.SW.SEND_QUEUE_V6]: state.sendQueueV6,
      [STORAGE_KEYS.SW.SEND_QUEUE_INDEX]: state.sendQueueV6Index,
      [STORAGE_KEYS.SW.SEND_PHASE]: state.sendPhase,
      [STORAGE_KEYS.SW.SELECTED_POSITIONS]: state.selectedPositions || [],
      [STORAGE_KEYS.SW.CUSTOM_POSITIONS]: state.customPositions || [],
      [STORAGE_KEYS.SW.MISSED_JOBS]: state._v6MissedJobs || [],
      // 诊断旁路：脱敏内存快照摘要，SW 卸载后 diag-export 回退读它（保留 jobs/queue/greetings 摘要）
      [STORAGE_KEYS.SW.LAST_SNAPSHOT]: buildSnapshotSummary(),
    };
    chrome.storage.local.set(toSave).catch(() => {});
  }, 500);
}

// ── 全局错误捕获 ──
self.addEventListener('error', (event) => {
  ErrorLogger.logError(event.message, event.filename + ':' + event.lineno, 'SW global error');
  try { DiagLogger.error('sw.global', event.message + ' at ' + event.filename + ':' + event.lineno); } catch (_) {}
  console.error('[猎职] SW global error:', event.message, 'at', event.filename + ':' + event.lineno);
});
self.addEventListener('unhandledrejection', (event) => {
  ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'SW unhandled rejection');
  try { DiagLogger.error('sw.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  console.error('[猎职] SW unhandled rejection:', event.reason?.message || String(event.reason));
});

// SW 启动时迁移 v1 配置到 v2；保留本地 API Key。
migrateSettingsV2().catch(function(e) {
  try { DiagLogger.warn('sw.migration', 'v2 配置迁移失败: ' + (e && e.message || e)); } catch (_) {}
});

// ── 全自动开发重载（零抢屏）──
// content.js RELOAD_EXTENSION 在 reload 前置 __pending_tab_reload flag。扩展重载后 SW top-level 重新求值，
// 在此读 flag：若有则原地 chrome.tabs.reload 所有 BOSS tab。页面 reload 触发 Chrome 按 manifest 注入【新版】CS，
// 既不开新 tab、也不切焦点 → 绕开「runtime.reload 后已有 tab 不重注入 CS、必须开新 tab 才注入」的死局。
chrome.storage.local.get('__pending_tab_reload', (r) => {
  if (!r || !r.__pending_tab_reload) return;
  chrome.storage.local.remove('__pending_tab_reload');
  chrome.tabs.query({ url: '*://*.zhipin.com/*' }, (tabs) => {
    (tabs || []).forEach((t) => {
      try { chrome.tabs.reload(t.id, { bypassCache: true }); } catch (e) {}
    });
  });
});

// 点击工具栏图标打开侧边栏（不自动关闭），而不是弹窗
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// SW 冷启动竞态防护：消息唤醒冷 SW 时，下面这个异步 restore 回调可能晚于
// 消息处理执行，用 storage 旧值覆盖刚建好的内存状态（实测致投递 0/0/0）。
// 所有会改写发送/采集状态的入口必须先 await bootRestored。
let _bootRestoreResolve;
const bootRestored = new Promise((resolve) => { _bootRestoreResolve = resolve; });

chrome.storage.local.get([
  STORAGE_KEYS.SW.PHASE,
  STORAGE_KEYS.SW.JOBS,
  STORAGE_KEYS.SW.GREETINGS,
  STORAGE_KEYS.SW.SEND_PROGRESS,
  STORAGE_KEYS.SW.SENT_JOB_IDS,
  STORAGE_KEYS.SW.SEND_RESULTS,
  STORAGE_KEYS.SW.SEND_DURATION,
  STORAGE_KEYS.SW.SEARCH_URL,
  STORAGE_KEYS.SW.SEND_QUEUE_V6,
  STORAGE_KEYS.SW.SEND_QUEUE_INDEX,
  STORAGE_KEYS.SW.SEND_PHASE,
  STORAGE_KEYS.SW.SELECTED_POSITIONS,
  STORAGE_KEYS.SW.CUSTOM_POSITIONS,
  STORAGE_KEYS.SW.MISSED_JOBS,
], (result) => {
  // searchUrlParams 无论 phase 是什么都要恢复，否则发送时 getJobsPageUrl() 返回裸 URL
  if (result[STORAGE_KEYS.SW.SEARCH_URL]) state.searchUrlParams = result[STORAGE_KEYS.SW.SEARCH_URL];

  if (result[STORAGE_KEYS.SW.PHASE] && result[STORAGE_KEYS.SW.PHASE] !== 'idle') {
    state.phase = result[STORAGE_KEYS.SW.PHASE];
    if (result[STORAGE_KEYS.SW.JOBS]) state.jobs = result[STORAGE_KEYS.SW.JOBS];
    // 恢复 AI 筛选进度（分批筛选断点续筛用）
    chrome.storage.local.get('aiScreeningProgress', function(pRes) {
      if (pRes && pRes.aiScreeningProgress && typeof pRes.aiScreeningProgress.done === 'number') {
        state.aiScreeningProgress = pRes.aiScreeningProgress;
      }
    });
    if (result[STORAGE_KEYS.SW.GREETINGS]) state.greetings = result[STORAGE_KEYS.SW.GREETINGS];
    // 期望岗位词恢复：丢了会让 buildSendQueueV6 类目匹配落空 → greeting 取空串
    if (result[STORAGE_KEYS.SW.SELECTED_POSITIONS]) state.selectedPositions = result[STORAGE_KEYS.SW.SELECTED_POSITIONS];
    if (result[STORAGE_KEYS.SW.CUSTOM_POSITIONS]) state.customPositions = result[STORAGE_KEYS.SW.CUSTOM_POSITIONS];
    if (result[STORAGE_KEYS.SW.SEND_PROGRESS]) state.sendProgress = result[STORAGE_KEYS.SW.SEND_PROGRESS];
    if (result[STORAGE_KEYS.SW.SEND_RESULTS]) state.sendResults = result[STORAGE_KEYS.SW.SEND_RESULTS];
    if (result[STORAGE_KEYS.SW.SEND_DURATION]) state.sendDuration = result[STORAGE_KEYS.SW.SEND_DURATION];
    // 从数组恢复 sentJobIds Set
    if (result[STORAGE_KEYS.SW.SENT_JOB_IDS] && Array.isArray(result[STORAGE_KEYS.SW.SENT_JOB_IDS])) {
      result[STORAGE_KEYS.SW.SENT_JOB_IDS].forEach(id => sentJobIds.add(id));
    }
    if (Array.isArray(result[STORAGE_KEYS.SW.SEND_RESULTS])) {
      result[STORAGE_KEYS.SW.SEND_RESULTS].forEach(function(sendResult) {
        if (sendResult && sendResult.alreadyChatted) sentJobIds.delete(sendResult.jobId);
      });
    }

    // v6 字段恢复
    if (Array.isArray(result[STORAGE_KEYS.SW.MISSED_JOBS])) state._v6MissedJobs = result[STORAGE_KEYS.SW.MISSED_JOBS];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_V6]) state.sendQueueV6 = result[STORAGE_KEYS.SW.SEND_QUEUE_V6];
    if (result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX]) state.sendQueueV6Index = result[STORAGE_KEYS.SW.SEND_QUEUE_INDEX];
    if (result[STORAGE_KEYS.SW.SEND_PHASE]) state.sendPhase = result[STORAGE_KEYS.SW.SEND_PHASE];

    // v6 发送状态恢复：如果 phase 是 sending 且 sendPhase 有值
    if (state.phase === 'sending' && state.sendPhase) {
      resumeSendV6();
    } else if (state.phase === 'sending') {
      // v5 遗留数据：清空旧状态重置为 idle
      state.phase = 'idle';
      state.sendQueue = [];
      state.sendIndex = 0;
    }
    // 恢复后推送给已打开的 popup
    pushState();
  }
  _bootRestoreResolve();
});

// 诊断包：phase 状态机转换单点打点（pushState 是所有 phase 变化的汇聚点）
let _diagLastPhase = 'idle';
function pushState() {
  try {
    if (state.phase !== _diagLastPhase) {
      DiagLogger.info('sw.phase', 'phase: ' + _diagLastPhase + ' → ' + state.phase + (state.sendPhase ? ' (sendPhase=' + state.sendPhase + ')' : ''));
      _diagLastPhase = state.phase;
    }
  } catch (_) {}
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
  persistState();
}

// ── 消息路由 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CS 调试桥：把 content script 关键步骤同步到 SW console
  if (msg && msg.type === 'CS_DBG') {
    var tabId = sender && sender.tab ? sender.tab.id : '?';
    return;
  }
  // 客户端全局错误桥：popup/sidepanel/content 捕获后转 SW 入库 extension:errorLog
  if (msg && msg.type === 'EXT_ERROR') {
    var locInfo = msg.file ? (msg.file + ':' + (msg.line || '?') + ':' + (msg.col || '?')) : '';
    ErrorLogger.logError(String(msg.msg || ''), msg.stack || locInfo, (msg.src || 'client') + ' global error');
    try { DiagLogger.error((msg.src || 'client') + '.global', String(msg.msg || '') + (locInfo ? ' @' + locInfo : '')); } catch (_) {}
    return;
  }
  // 测试桥：全自动开发重载。content script 无 chrome.runtime.reload 特权（CS 的 runtime 仅子集），
  // 故由 CS 发此消息、SW 代为执行。置 __pending_tab_reload flag 后 reload；扩展重启后 SW top-level
  // 读 flag 原地 chrome.tabs.reload 所有 BOSS tab 重注入新 CS（零抢屏）。产品流程永不发此消息。
  if (msg && msg.type === 'RELOAD_EXT_SELF') {
    chrome.storage.local.set({ __pending_tab_reload: true }, () => {
      chrome.runtime.reload();
    });
    return;
  }
  switch (msg.type) {
    case 'GET_STATE':
      sendResponse({ success: true, state });
      break;

    case MSG.GET_JOB_OUTCOMES:
      if (!isTrustedPopupSender(sender)) {
        sendResponse({ success: false, error: '岗位反馈只能从扩展侧边面板读取' });
        return false;
      }
      getJobOutcomeFeedback(msg.jobIds)
        .then((result) => sendResponse({ success: true, records: result.records, summary: result.summary }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.RECORD_JOB_OUTCOME:
      if (!isTrustedPopupSender(sender)) {
        sendResponse({ success: false, error: '岗位反馈只能从扩展侧边面板保存' });
        return false;
      }
      recordJobOutcome(msg)
        .then((result) => sendResponse({ success: true, record: result.record, summary: result.summary }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.CLEAR_OUTCOME_FEEDBACK:
      if (!isTrustedPopupSender(sender)) {
        sendResponse({ success: false, error: '岗位反馈只能从扩展侧边面板清除' });
        return false;
      }
      chrome.storage.local.set({ [STORAGE_KEYS.SW.OUTCOME_FEEDBACK]: [] })
        .then(() => sendResponse({ success: true }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case 'START_COLLECT':
      startCollect(msg.params).then(() => sendResponse({ success: true })).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'START_COLLECT failed');
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case 'STOP_COLLECT':
      stopCollect().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case 'JOBS_COLLECTED':
      if (state._multiCityCollect) { sendResponse({ success: true }); break; }
      // 单城市路径：BOSS 模糊匹配脏数据由 service-worker 再过滤一遍，clusters 重算以反映过滤后集合
      {
        const _rawJobs = Array.isArray(msg.jobs) ? msg.jobs : [];
        const _filteredJobs = filterJobsByExpected(_rawJobs, state.selectedPositions, state.customPositions);
        const _mergedJobs = mergeCollectedJobsById(_filteredJobs);
        state.jobs = _mergedJobs;
        const _allPos394 = allExpectedPositions(state);
        state.clusters = _allPos394.length
          ? clusterJobs(state.jobs, state.selectedPositions, state.customPositions)
          : (msg.clusters || {});
        updateCollectionSummary({
          startedAt: state.collectionSummary && state.collectionSummary.startedAt || Date.now(),
          tasksTotal: 1,
          tasksDone: 1,
          rawJobs: _rawJobs.length,
          matchedJobs: _filteredJobs.length,
          positionFilteredJobs: Math.max(0, _rawJobs.length - _filteredJobs.length),
          duplicateJobs: Math.max(0, _filteredJobs.length - _mergedJobs.length),
          postRuleFilteredJobs: 0,
          emptyTasks: _rawJobs.length ? 0 : 1,
          failedTasks: 0,
          visibleJobs: state.jobs.length,
          checkedJobs: countCheckedJobs(state.jobs),
          excludedJobs: 0,
          historySkippedJobs: 0,
          groups: summarizeGroups(state.clusters),
          taskSummaries: [{ city: '', keyword: '', rawJobs: _rawJobs.length, status: 'ok' }],
        });
      }
      state.jdSamples = msg.jdSamples;
      ensureJobHydrationMeta(state.jobs);
      saveCollectedJobRecords(state.jobs, 'collect');
      applyAiScreeningToJobs(state.jobs).then(async function(screenedJobs) {
        state.jobs = await applyPostCollectRules(screenedJobs, state);
        const _allPosScreened = allExpectedPositions(state);
        state.clusters = _allPosScreened.length
          ? clusterJobs(state.jobs, state.selectedPositions, state.customPositions)
          : (state.clusters || {});
        const _screenedExcludedCount = countExcludedJobs(state.jobs);
        const _screenedHistorySkippedCount = countHistorySkippedJobs(state.jobs);
        updateCollectionSummary({
          postRuleFilteredJobs: _screenedExcludedCount + _screenedHistorySkippedCount,
          visibleJobs: state.jobs.length,
          checkedJobs: countCheckedJobs(state.jobs),
          excludedJobs: _screenedExcludedCount,
          historySkippedJobs: _screenedHistorySkippedCount,
          groups: summarizeGroups(state.clusters),
        });
        saveCollectedJobRecords(state.jobs, 'ai-screen');
        pushState();
        // 采集完成后自动给简历打分（不阻塞主流程，失败静默）
        autoScoreResumeAfterCollect();
        return refreshBatchOverview(true);
      }).catch(function(e) {
        chrome.runtime.sendMessage({ type: 'ERROR', message: 'AI 筛选失败，请人工确认岗位' }).catch(() => {});
        ErrorLogger.logError(e.message || String(e), e?.stack, 'AI screening batch failed');
      });
      scheduleJdHydration({ forceOverviewRefresh: false }).catch(function(e) {
        ErrorLogger.logError(e.message || String(e), e?.stack, 'JD hydrate schedule failed');
      });
      state.phase = 'ready';
      pushState();
      if (!state.jobs || state.jobs.length === 0) {
        chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
        sendResponse({ success: true }); break;
      }
      // 异步并发生成招呼语（两步法：先 VL 提取简历文字，再纯文字并发 5 路生成），与popup渲染完全并行
      if (!greetingPromise) {
        greetingPromise = generateAllGreetingsConcurrent();
      }
      sendResponse({ success: true });
      break;

    case 'COLLECT_PROGRESS':
      if (!state._multiCityCollect) {
        chrome.runtime.sendMessage(msg).catch(() => {});
      }
      sendResponse({ success: true });
      break;

    case 'START_SEND':
      state.phase = 'ready';
      state.sendQueue = [];
      state.sendQueueV6 = [];
      state.sendPhase = '';
      state.sendIndex = 0;
      state.sendProgress = null;
      persistState();
      sendResponse({ success: false, error: '当前插件包已禁用投递，只允许采集岗位。', errorCode: 'SEND_DISABLED' });
      return true;

    // ── 1.4.0 自动投递：批次预览（只读，不投递） ──
    case MSG.AUTO_RUN_PREVIEW: {
      var _cfg = (msg && msg.config) || {};
      try {
        buildHandledHrSet().then(function(_hs) {
          var _pv = buildAutoRunPreview(msg.jobIds || [], _cfg, _hs);
          sendResponse({ success: true, preview: _pv });
        }).catch(function() {
          var _pv = buildAutoRunPreview(msg.jobIds || [], _cfg);
          sendResponse({ success: true, preview: _pv });
        });
      } catch (e) {
        ErrorLogger.logError(e.message, e.stack, 'AUTO_RUN_PREVIEW failed');
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    // ── 1.4.0 自动投递：启动整批（一次确认） ──
    case MSG.START_AUTO_RUN: {
      if (state.phase === 'sending' || state.phase === 'collecting' || singleSendLaunchInProgress) {
        sendResponse({ success: false, error: '当前有任务进行中，请先停止', errorCode: 'BUSY' });
        return true;
      }
      startAutoRun(msg)
        .then(function(res) { sendResponse({ success: true, result: res }); })
        .catch(function(e) {
          ErrorLogger.logError(e.message, e.stack, 'START_AUTO_RUN failed');
          sendResponse({ success: false, error: e.message, errorCode: e.errorCode || null });
        });
      return true;
    }

    // ── 1.4.0 自动投递：状态查询 ──
    case MSG.AUTO_RUN_STATUS:
      sendResponse({ success: true, autoRun: state.autoRun || null });
      return true;

    // ── 1.4.0 自动投递：停止 ──
    case 'STOP_AUTO_RUN':
      stopAutoRun().then(function() { sendResponse({ success: true }); }).catch(function(e) { sendResponse({ success: false, error: e.message }); });
      return true;

    case MSG.RESUME_SEND:
      // CAPTCHA 暂停后恢复投递：续跑之前保留的发送队列，不重新逐岗确认
      if (state.phase !== 'captcha_paused' || !state.sendQueueV6 || !state.sendQueueV6.length) {
        sendResponse({ success: false, error: '没有可恢复的暂停任务', errorCode: 'NO_PAUSED_TASK' });
        return true;
      }
      resumeFromCaptchaPause()
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'RESUME_SEND failed');
          sendResponse({ success: false, error: e.message, errorCode: e.errorCode || null });
        });
      return true;

    case 'STOP_SEND':
      stopSend().then(() => sendResponse({ success: true })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.GET_DAILY_SEND_COUNT:
      // 投递数量闸门：popup 投递前读当天已成功投递岗位数（本地自然日，跨日自动归零）
      getDailySendCount().then((count) => sendResponse({ success: true, count: count, limit: CONFIG.DAILY_SEND_LIMIT }))
        .catch(() => sendResponse({ success: true, count: 0, limit: CONFIG.DAILY_SEND_LIMIT }));
      return true;

    case 'SEND_PROGRESS':
      state.sendProgress = msg.progress;
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_ITEM_RESULT':
      // v5 发送流程中，结果已由 recordV5Success/recordV5Failure 处理，防止重复计数
      if (state.phase === 'sending') {
        if (msg.payload?.jobId && findSendResultByJobId(msg.payload.jobId)) {
          sendResponse({ success: true });
          break;
        }
      }
      // 累积发送结果，用于 Review 页
      state.sendResults.push(msg.payload);
      // 只有平台确认成功的结果才进入 sentJobIds。
      if (msg.payload.success) {
        sentJobIds.add(msg.payload.jobId);
      }
      // 按累积结果更新进度
      state.sendProgress.sent = state.sendResults.length;
      // 增量持久化（500ms 防抖，中断恢复不会丢失进度）
      persistState();
      // 转发给 popup（Review 页实时更新）
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_COMPLETE':
      // SW 驱动的逐条导航发送：忽略 content script 的单条 SEND_COMPLETE
      if (state.phase === 'sending') { sendResponse({ success: true }); break; }
      // CAPTCHA 中断发送，不切换到 review
      if (state.phase === 'captcha_paused') break;
      // 全部发送失败，回退到 ready（不展示 review）
      if (state.sendResults.length > 0 && state.sendResults.every(r => !r.success)) {
        state.phase = 'ready';
        state.sendProgress = { sent: 0, total: 0 };
        pushState();
        break;
      }
      state.phase = 'review';
      state.sendDuration = Date.now() - sendStartTime;
      state.sendProgress = { sent: msg.total, total: msg.total };
      pushState();
      // 转发给 popup：扩展 results[] + duration
      chrome.runtime.sendMessage({
        type: MSG.SEND_COMPLETE,
        results: state.sendResults,
        duration: state.sendDuration,
      }).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'CHAT_DETECTED':
      state.autoReplyCount++;
      pushState();
      sendResponse({ success: true });
      break;

    case 'CAPTCHA_DETECTED':
      try { DiagLogger.warn('sw.captcha', 'CAPTCHA detected, send paused (tab=' + (sender && sender.tab ? sender.tab.id : '?') + ')'); } catch (_) {}
      state.phase = 'captcha_paused';
      state.captchaError = true;
      pushState();
      // 通知所有 content script 停止发送
      chrome.tabs.query({ url: '*://*.zhipin.com/*' }).then((tabs) => {
        tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));
      });
      sendResponse({ success: true });
      break;

    case MSG.CS_READY:
      var role = msg.role;
      if (role === 'search') {
        state._v6SearchReady = true;
        state.searchTabId = sender.tab.id;
      } else if (role === 'worker') {
        state._v6WorkerTabsReady.add(sender.tab.id);
      } else if (state.phase === 'sending') {
        // 兼容旧 v5 逻辑
        if (sender.tab.id === state.chatTabId) {
          state._v5ChatReady = true;
        }
      }
      sendResponse({ success: true });
      break;

    case 'AUTO_REPLY_SENT':
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'REGENERATE_GREETING':
      regenerateGreeting(msg.category, msg.jdSamples)
        .then((greeting) => sendResponse({ success: true, greeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REGENERATE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'REWRITE_GREETING':
      doRewriteGreeting(msg.greeting, msg.instruction, msg.blockedNames)
        .then((newGreeting) => sendResponse({ success: true, greeting: newGreeting }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REWRITE_GREETING failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'UPDATE_GREETING':
      state.greetings[msg.category] = msg.greeting;
      pushState();
      sendResponse({ success: true });
      break;

    case MSG.AI_CHAT: {
      // 首页 AI 对话框：复用已配置的 OpenAI-compatible 接口，附加简历/目标上下文。
      const question = String(msg.question || '').trim();
      if (!question) { sendResponse({ success: false, error: '问题不能为空' }); return false; }
      aiHomeChat(question, msg.history || [])
        .then((reply) => sendResponse({ success: true, reply }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'AI_CHAT failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;
    }

    case MSG.SCORE_RESUME:
      scoreResume()
        .then((result) => sendResponse({ success: true, result }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'SCORE_RESUME failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case MSG.REWRITE_RESUME:
      rewriteResume()
        .then((result) => sendResponse({ success: true, result }))
        .catch((e) => {
          ErrorLogger.logError(e.message, e.stack, 'REWRITE_RESUME failed');
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'GET_API_KEY':
      getAiConfig().then((cfg) => sendResponse({ success: true, apiKey: cfg.apiKey || '' }));
      return true;

    case 'SAVE_API_KEY':
      getAiConfig().then((cfg) => saveAiConfig(Object.assign({}, cfg, { apiKey: msg.apiKey }))).then(() => sendResponse({ success: true }));
      return true;

    case MSG.GET_AI_CONFIG:
      getAiConfig().then((cfg) => sendResponse({ success: true, config: cfg })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.SAVE_AI_CONFIG:
      saveAiConfig(msg.config || {}).then((cfg) => sendResponse({ success: true, config: cfg })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.PREPARE_SINGLE_SEND: {
      if (!isTrustedPopupSender(sender)) {
        sendResponse({ success: false, error: '单岗确认只能从扩展侧边面板发起' });
        return false;
      }
      // 冷启动竞态：SW 刚被消息唤醒时 state.jobs 尚未从 storage 恢复，
      // 直接 findStateJobById 会误报"岗位已失效"。必须先 await bootRestored。
      bootRestored.then(async () => {
        const preparedJob = findStateJobById(msg.jobId);
        if (!preparedJob || state.phase === 'sending' || singleSendLaunchInProgress) {
          sendResponse({
            success: false,
            error: (state.phase === 'sending' || singleSendLaunchInProgress)
              ? '当前已有岗位正在沟通'
              : '岗位已失效，请重新采集',
          });
          return;
        }
        const resumeText = await getTextResume();
        const blockedNames = uniqueStrings(
          [preparedJob.company, preparedJob.companyName]
            .concat(extractGreetingBlockedNames(resumeText))
        );
        const reviewedGreeting = String(msg.greeting || '').trim();
        const preparedGreeting = sanitizeGeneratedGreeting(reviewedGreeting, blockedNames);
        if (!preparedGreeting) {
          sendResponse({ success: false, error: '当前岗位没有可发送的招呼语' });
          return;
        }
        if (msg.seal === true && preparedGreeting !== reviewedGreeting) {
          sendResponse({
            success: false,
            error: '招呼语内容已变化，请重新打开岗位确认弹层',
            errorCode: 'GREETING_REVIEW_REQUIRED',
          });
          return;
        }
        preparedJob.status = 'manualReview';
        var response = {
          success: true,
          greeting: preparedGreeting,
          expiresInMs: SINGLE_SEND_CONFIRMATION_TTL_MS,
        };
        if (msg.seal === true) {
          var sendImages = msg.sendImages === true;
          var imageKeys = normalizeImageConsentKeys(msg.imageKeys);
          if (sendImages && !imageKeys.length) {
            sendResponse({
              success: false,
              error: '图片确认信息已失效，请重新打开岗位确认弹层',
              errorCode: 'IMAGE_CONFIRMATION_REQUIRED',
            });
            return;
          }
          response.token = createSingleSendConfirmation({
            jobId: preparedJob.id || preparedJob.jobId,
            greeting: preparedGreeting,
            sendImages: sendImages,
            imageKeys: imageKeys,
            blockedNames: blockedNames,
          });
        }
        sendResponse(response);
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'PREPARE_SINGLE_SEND bootRestored failed');
        sendResponse({ success: false, error: e.message || '内部错误' });
      });
      return true;
    }

    case MSG.CONFIRM_SINGLE_SEND:
      if (!isTrustedPopupSender(sender)) {
        sendResponse({ success: false, error: '单岗确认只能从扩展侧边面板发起' });
        return false;
      }
      if (state.phase === 'sending' || singleSendLaunchInProgress) {
        // 并发判断提前：避免烧掉已消耗的确认 token
        sendResponse({ success: false, error: '当前已有岗位正在沟通' });
        return false;
      }
      var singleSendConfirmation = consumeSingleSendConfirmation(msg.token, msg.jobId);
      if (!singleSendConfirmation) {
        sendResponse({ success: false, error: '确认已过期，请重新打开岗位确认弹层', errorCode: 'CONFIRMATION_REQUIRED' });
        return false;
      }
      var sendConfirmedImages = singleSendConfirmation.sendImages === true;
      if (sendConfirmedImages && !singleSendConfirmation.imageKeys.length) {
        sendResponse({
          success: false,
          error: '图片确认信息已失效，请重新打开岗位确认弹层',
          errorCode: 'IMAGE_CONFIRMATION_REQUIRED',
        });
        return false;
      }
      singleSendLaunchInProgress = true;
      if (sender && sender.tab && sender.tab.windowId) {
        state.originalMainWindowId = sender.tab.windowId;
      }
      state.hrActiveFilter = msg.hrActiveFilter || '不限';
      // 立即受理：先同步响应，让 popup 进入 sending 态（可停止）；发送进度走 STATE_UPDATE 推送。
      sendResponse({ success: true, accepted: true });
      startSendV6([msg.jobId], {
        confirmedGreeting: singleSendConfirmation.greeting,
        sendImages: sendConfirmedImages,
        imageKeys: sendConfirmedImages ? singleSendConfirmation.imageKeys : [],
        blockedNames: singleSendConfirmation.blockedNames,
        confirmationExpiresAt: singleSendConfirmation.expiresAt,
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'CONFIRM_SINGLE_SEND failed');
        try { chrome.runtime.sendMessage({ type: MSG.ERROR, message: e.message }).catch(() => {}); } catch (_) {}
        state.phase = 'ready';
        state.sendPhase = '';
        pushState();
      }).finally(() => {
        singleSendLaunchInProgress = false;
      });
      return true;

    case MSG.TEST_AI_CONFIG:
      callOpenAICompatible(normalizeAiConfig(msg.config), [
        { role: 'user', content: 'Reply with OK only.' },
      ], 8, 20000, 'test').then((text) => sendResponse({ success: true, message: text })).catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case MSG.CLOSE_IDLE_BOSS_TABS:
      // 手动清理：忽略开关，强制关闭多余 BOSS 搜索 tab
      closeIdleBossSearchTabs(true).then((closed) => {
        sendResponse({ success: true, closed: closed });
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'CLOSE_IDLE_BOSS_TABS failed');
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case MSG.GENERATE_FILTER_SUGGESTION:
      Promise.all([
        chrome.storage.local.get([STORAGE_KEYS.UI.FILTER_STATE, STORAGE_KEYS.SW.JOBS]),
        getTextResume(),
      ]).then(function(results) {
        var storageItems = results[0] || {};
        var resumeText = results[1] || '';
        return generateFilterSuggestion({
          prompt: msg.prompt || '',
          filterState: msg.filterState || storageItems[STORAGE_KEYS.UI.FILTER_STATE] || {},
          resumeText: resumeText,
          jobSamples: buildRecentJobSamples(msg.jobs || storageItems[STORAGE_KEYS.SW.JOBS] || [], 12),
        });
      }).then(function(result) {
        sendResponse({ success: true, result: result });
      }).catch(function(e) {
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case MSG.RETRY_JOB_DETAILS:
      scheduleJdHydration({ forceOverviewRefresh: true }).then(function() {
        sendResponse({ success: true });
      }).catch(function(e) {
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case 'CLEAR_SENT_JOB_IDS':
      sentJobIds.clear();
      persistState();
      sendResponse({ success: true });
      break;

    case '__TEST_OPEN_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.create({
        url: chrome.runtime.getURL('src/popup/popup.html'),
        active: false
      }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_OPEN_TAB__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      // 只允许开 zhipin.com 测试页（不抢屏：active:false）
      const _u = String(msg.url || '');
      if (!/^https?:\/\/([^/]+\.)?zhipin\.com\//.test(_u)) {
        sendResponse({ success: false, error: 'url not allowed' });
        return false;
      }
      chrome.tabs.create({ url: _u, active: false }, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, tabId: tab.id });
        }
      });
      return true;
    }
    case '__TEST_CLOSE_POPUP__': {
      if (chrome.runtime.getManifest().update_url) {
        sendResponse({ success: false, error: 'test API disabled in production' });
        return false;
      }
      chrome.tabs.remove(msg.tabId, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
      return true;
    }

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
  }
});

// ── 辅助：构建 BOSS 直聘搜索 URL ──
function buildJobUrl(params) {
  const base = 'https://www.zhipin.com/web/geek/jobs';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  return `${base}?${qs.toString()}`;
}

// ── 获取带搜索参数的岗位页面 URL（无参数时 fallback 到裸 URL）──
function getJobsPageUrl() {
  if (state.searchUrlParams) {
    return buildJobUrl(state.searchUrlParams);
  }
  return 'https://www.zhipin.com/web/geek/jobs';
}

// ── 辅助：等待标签页加载完成（超时兜底） ──
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── PING/PONG 握手：确认 content script 已注入就绪 ──
async function waitForContentScript(tabId, timeoutMs = 3000, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PING timeout')), timeoutMs);
        chrome.tabs.sendMessage(tabId, { type: 'PING' }).then((resp) => {
          clearTimeout(timer);
          resolve(resp);
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      if (response && response.type === 'PONG') {
        return true;
      }
    } catch (err) {
      console.warn(`[猎职] PING attempt ${attempt + 1}/${maxRetries} failed:`, err.message);
      ErrorLogger.logError(err.message, err.stack, `PING attempt ${attempt + 1}/${maxRetries}`);
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  throw new Error('Content script not ready after ' + maxRetries + ' attempts');
}

// ── 通用辅助 ──
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ═══════════════════════════════════════════════════════════════════
// Worker tab keepalive — chrome.alarms 30s 周期给后台 worker tab 发 PING
// 目的：防 BFCache 失活、防 service worker 30s 空闲休眠、防 tab discard
// 不切前台（不抢用户屏幕）— 仅靠消息往返让 chromium 认为 tab/SW 都活跃
// ═══════════════════════════════════════════════════════════════════
const _workerAlarmPrefix = 'zitou:worker_keepalive:';
const _activeWorkerKeepalives = new Set(); // tabId 集合
const _screenKeepaliveAlarm = 'zitou:screen_keepalive'; // AI 筛选保活 alarm

function _workerAlarmName(tabId) { return _workerAlarmPrefix + tabId; }

function startWorkerKeepalive(tabId) {
  if (_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.add(tabId);
  // periodInMinutes 最低 0.5 = 30s（chrome 强制下限）
  var period = (typeof CONFIG !== 'undefined' && CONFIG.KEEPALIVE_PERIOD_MIN) || 0.5;
  chrome.alarms.create(_workerAlarmName(tabId), {
    delayInMinutes: period,
    periodInMinutes: period,
  });
}

function stopWorkerKeepalive(tabId) {
  if (!_activeWorkerKeepalives.has(tabId)) return;
  _activeWorkerKeepalives.delete(tabId);
  chrome.alarms.clear(_workerAlarmName(tabId)).catch(function(){});
}

// onAlarm 单点 dispatcher — 收到 ping alarm 就给对应 tab 发 PING
// CS 侧已有 PONG handler（content.js:401-403），无需新增
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (!alarm || !alarm.name) return;
  // 筛选保活 alarm（由 _screenKeepaliveTimer 每 8s 创建、1s 后触发）：
  // 触发即算 SW 有待处理事件，重置空闲计时器。旧期间 alarm 清理即可，保活靠 timer 续命。
  if (alarm.name === _screenKeepaliveAlarm) {
    try { chrome.alarms.clear(alarm.name).catch(function(){}); } catch (_) {}
    return;
  }
  if (alarm.name.indexOf(_workerAlarmPrefix) !== 0) return;
  var tabId = parseInt(alarm.name.slice(_workerAlarmPrefix.length), 10);
  if (!tabId || !_activeWorkerKeepalives.has(tabId)) {
    chrome.alarms.clear(alarm.name).catch(function(){});
    return;
  }
  // 异步发 PING，不 await（alarm 回调不需要保活）
  chrome.tabs.sendMessage(tabId, { type: MSG.PING }).catch(function(err) {
    // 失败可能是 tab 已关、CS 未注入、BFCache — 都不致命，下次 alarm 继续试
    console.warn('[猎职] keepalive PING failed tab=' + tabId + ' err=' + err.message);
  });
});

// 清理：cleanupV6 时一并清掉所有残留 keepalive alarm
function stopAllWorkerKeepalives() {
  var tabs = Array.from(_activeWorkerKeepalives);
  for (var i = 0; i < tabs.length; i++) stopWorkerKeepalive(tabs[i]);
}

// ── 采集控制 ──
async function startCollect(params) {
  await bootRestored;         // 冷启动竞态防护，同 startSendV6
  try { DiagLogger.userEvent('sw.collect', '任务启动：开始采集 cities=' + ((params && params.selectedCities && params.selectedCities.length) || 0) + ' positions=' + (allExpectedPositions({ selectedPositions: params && params.selectedPositions, customPositions: params && params.customPositions }).length)); } catch (_) {}
  state.phase = 'collecting';
  state.jobs = [];
  state.greetings = {};
  state.collectionSummary = buildEmptyCollectionSummary();
  state.aiOverviewSummary = buildEmptyAiOverviewSummary('等待采集完成');
  state.aiBatchOverview = buildEmptyBatchOverview();
  // 新批次开始，清空已发送记录
  sentJobIds.clear();
  state.sendResults = [];
  state._v6MissedJobs = []; // 上一批漏发清单随新批作废（重新投递会重建联+重发）
  state.sendDuration = 0;
  state.sendProgress = { sent: 0, total: 0 };
  if(params&&params.selectedPositions) state.selectedPositions = params.selectedPositions;
  state.customPositions = (params && Array.isArray(params.customPositions)) ? params.customPositions : (state.customPositions||[]);
  state.excludeKeywords = uniqueStrings(params && params.excludeKeywords || state.excludeKeywords || DEFAULT_EXCLUDE_KEYWORDS);
  state.skipHistoryEnabled = !params || params.skipHistoryEnabled !== false;
  state.skipHistoryScope = 'hr';
  state.excludeOutsource = !params || params.excludeOutsource !== false;
  state.excludeSuspicious = !params || params.excludeSuspicious !== false;
  if(params && params.urlParams) state.searchUrlParams = params.urlParams;
  else state.searchUrlParams = null;
  pushState();
  // 即时预热招呼语：不等岗位采集，A 点击"开始收集"瞬即并发生成 N 条（N=期望岗位数）
  // 5-6s 采集期间复用为招呼语生成时间窗，B 页打开即有结果
  if (!greetingPromise && allExpectedPositions(state).length) {
    greetingPromise = generateAllGreetingsConcurrent();
  }
  try {
    const cities = params.selectedCities || [];
    const searchKeywords = allExpectedPositions({ selectedPositions: state.selectedPositions, customPositions: state.customPositions });

    // 所有岗位词逐词独立搜索，最后统一去重和筛选。
    state._multiCityCollect = true;
    const MAX_PARALLEL = CONFIG.MAX_COLLECT_TABS || 2;
    let allJobs = [];
    let earlyGreetingStarted = false;

    var tasks = [];
    var cityList = cities.length ? cities : [params.urlParams && params.urlParams.city || ''];
    var keywordList = searchKeywords.length ? searchKeywords : [''];
    for (var tk = 0; tk < keywordList.length; tk++) {
      for (var tc = 0; tc < cityList.length; tc++) {
        tasks.push({ keyword: keywordList[tk], cityCode: cityList[tc] });
      }
    }
    updateCollectionSummary({
      startedAt: Date.now(),
      cities: cityList,
      keywords: keywordList,
      tasksTotal: tasks.length,
      rawJobs: 0,
      matchedJobs: 0,
      visibleJobs: 0,
      positionFilteredJobs: 0,
      duplicateJobs: 0,
      postRuleFilteredJobs: 0,
      emptyTasks: 0,
      failedTasks: 0,
      checkedJobs: 0,
      excludedJobs: 0,
      historySkippedJobs: 0,
      groups: 0,
      taskSummaries: [],
    });

    for (let i = 0; i < tasks.length; i += MAX_PARALLEL) {
      const batch = tasks.slice(i, i + MAX_PARALLEL);
      const batchResults = await Promise.allSettled(
        batch.map(task => collectOnTab(task.cityCode, buildKeywordCollectParams(params, task.keyword)))
      );

      for (let br = 0; br < batchResults.length; br++) {
        const taskInfo = batch[br] || {};
        const result = batchResults[br];
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) allJobs.push(...result.value);
          var taskCount = Array.isArray(result.value) ? result.value.length : 0;
          state.collectionSummary.taskSummaries.push({
            city: taskInfo.cityCode || '',
            keyword: taskInfo.keyword || '',
            rawJobs: taskCount,
            status: 'ok',
          });
          try { DiagLogger.info('sw.collect.diag', 'task ok city=' + (taskInfo.cityCode || '') + ' keyword=' + (taskInfo.keyword || '') + ' raw=' + taskCount); } catch (_) {}
        } else {
          var errMsg = result && result.reason ? (result.reason.message || String(result.reason)) : 'collect failed';
          state.collectionSummary.taskSummaries.push({
            city: taskInfo.cityCode || '',
            keyword: taskInfo.keyword || '',
            rawJobs: 0,
            status: 'failed',
            error: String(errMsg).slice(0, 120),
          });
          try { DiagLogger.warn('sw.collect.diag', 'task failed city=' + (taskInfo.cityCode || '') + ' keyword=' + (taskInfo.keyword || '') + ' error=' + errMsg); } catch (_) {}
        }
      }
      updateCollectionSummary({
        tasksDone: Math.min(i + MAX_PARALLEL, tasks.length),
        rawJobs: allJobs.length,
        emptyTasks: countEmptyCollectTasks(state.collectionSummary.taskSummaries),
        failedTasks: countFailedCollectTasks(state.collectionSummary.taskSummaries),
      });

      // 【并行优化】第一批岗位收集完后立即异步启动招呼语生成，不等待后续批次
      if (i === 0 && allJobs.length > 0 && !earlyGreetingStarted) {
        earlyGreetingStarted = true;
        // 用已有岗位构建 jdSamples，提前触发 AI 招呼语生成
        // 兜底：从 chrome.storage 读权威 selectedPositions（防止 popup 没传或传空）
        if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
          try {
            const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
            if (fs) {
              if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
              if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
            }
          } catch (e) { /* 静默：storage 读失败保持原值 */ }
        }
        const partialClusters = clusterJobs(filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions), state.selectedPositions, state.customPositions);
        state.jdSamples = sampleJDs(partialClusters, 5);
        greetingPromise = generateAllGreetingsConcurrent();
      }

      // City-level progress
      const completed = Math.min(i + MAX_PARALLEL, tasks.length);
      chrome.runtime.sendMessage({
        type: 'COLLECT_CITY_PROGRESS',
        progress: { completed, total: tasks.length, jobsCollected: allJobs.length }
      }).catch(() => {});
    }

    delete state._multiCityCollect;

    // 兜底：从 chrome.storage 读权威 selectedPositions（防止 popup 没传或传空）
    if ((!state.selectedPositions || !state.selectedPositions.length) || (!state.customPositions || !state.customPositions.length)) {
      try {
        const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
        if (fs) {
          if ((!state.selectedPositions || !state.selectedPositions.length) && Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) state.selectedPositions = fs.selectedPositions;
          if ((!state.customPositions || !state.customPositions.length) && Array.isArray(fs.customPositions) && fs.customPositions.length) state.customPositions = fs.customPositions;
        }
      } catch (e) { /* 静默：storage 读失败保持原值 */ }
    }
    var rawJobCount = allJobs.length;
    var matchedJobs = filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions);
    var matchedJobCount = matchedJobs.length;
    var mergedJobs = mergeCollectedJobsById(matchedJobs);
    var mergedJobCount = mergedJobs.length;
    state.jobs = await applyPostCollectRules(mergedJobs, state);
    var excludedCount = countExcludedJobs(state.jobs);
    var historySkippedCount = countHistorySkippedJobs(state.jobs);
    ensureJobHydrationMeta(state.jobs);
    state.clusters = clusterJobs(state.jobs, state.selectedPositions, state.customPositions);
    state.jdSamples = sampleJDs(state.clusters, 5);
    updateCollectionSummary({
      rawJobs: rawJobCount,
      matchedJobs: matchedJobCount,
      positionFilteredJobs: Math.max(0, rawJobCount - matchedJobCount),
      duplicateJobs: Math.max(0, matchedJobCount - mergedJobCount),
      postRuleFilteredJobs: excludedCount + historySkippedCount,
      emptyTasks: countEmptyCollectTasks(state.collectionSummary.taskSummaries),
      failedTasks: countFailedCollectTasks(state.collectionSummary.taskSummaries),
      visibleJobs: state.jobs.length,
      checkedJobs: countCheckedJobs(state.jobs),
      excludedJobs: excludedCount,
      historySkippedJobs: historySkippedCount,
      groups: summarizeGroups(state.clusters),
    });
    state.phase = 'ready';
    saveCollectedJobRecords(state.jobs, 'collect');
    pushState();

    if (mergedJobs.length === 0) {
      chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
      return;
    }

    applyAiScreeningToJobs(mergedJobs).then(async function(screenedJobs) {
      state.jobs = await applyPostCollectRules(screenedJobs, state);
      state.clusters = clusterJobs(state.jobs, state.selectedPositions, state.customPositions);
      state.jdSamples = sampleJDs(state.clusters, 5);
      var screenedExcludedCount = countExcludedJobs(state.jobs);
      var screenedHistorySkippedCount = countHistorySkippedJobs(state.jobs);
      updateCollectionSummary({
        postRuleFilteredJobs: screenedExcludedCount + screenedHistorySkippedCount,
        visibleJobs: state.jobs.length,
        checkedJobs: countCheckedJobs(state.jobs),
        excludedJobs: screenedExcludedCount,
        historySkippedJobs: screenedHistorySkippedCount,
        groups: summarizeGroups(state.clusters),
      });
      saveCollectedJobRecords(state.jobs, 'ai-screen');
      pushState();
      return refreshBatchOverview(true);
    }).catch(function(e) {
      chrome.runtime.sendMessage({ type: 'ERROR', message: 'AI 筛选失败，请人工确认岗位' }).catch(() => {});
      ErrorLogger.logError(e.message || String(e), e?.stack, 'AI screening batch failed');
    });
    scheduleJdHydration({ forceOverviewRefresh: false }).catch(function(e) {
      ErrorLogger.logError(e.message || String(e), e?.stack, 'JD hydrate schedule failed');
    });

    // 如果已提前启动招呼语生成，等待完成后补充新增分类
    if (earlyGreetingStarted) {
      try { await greetingPromise; } catch (_) {}
      // 后续批次可能引入了新分类，补充生成
      const apiKey = await getApiKey();
      if (apiKey && state.jdSamples) {
        let resumeImages = await loadResumeImages();
        for (const [cat, samples] of Object.entries(state.jdSamples)) {
          if (!state.greetings[cat]) {
            try {
              state.greetings[cat] = await generateGreeting(apiKey, resumeImages, samples, cat);
              pushState();
            } catch (e) {
              state.greetings[cat] = '生成失败，请刷新';
              ErrorLogger.logError(e.message || String(e), e?.stack, 'Late greeting gen: ' + cat);
              pushState();
            }
          }
        }
      }
      greetingPromise = null;
      pushState();
    } else {
      greetingPromise = generateAllGreetingsConcurrent();
    }

  } catch (e) {
    delete state._multiCityCollect;
    state.phase = 'idle';
    pushState();
    throw e;
  }
}

// Original single-city tab collection logic
async function singleCityCollect(params) {
  const hasUrlParams = params?.urlParams && Object.keys(params.urlParams).length > 0;

  if (hasUrlParams) {
    const url = buildJobUrl(params.urlParams);

    let tabId;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.url && activeTab.url.includes('zhipin.com') && activeTab.id) {
        tabId = activeTab.id;
        await chrome.tabs.update(tabId, { url });
      } else {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
      }
    } catch (_) {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    }

    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'DO_COLLECT', params });
  } else {
    const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
    if (!tabs.length) throw new Error('请先打开 BOSS 直聘岗位搜索页');
    assertCollectableBossTab(tabs[0]);
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'DO_COLLECT', params });
  }
}

function buildKeywordCollectParams(params, keyword) {
  var next = Object.assign({}, params || {});
  next.urlParams = Object.assign({}, params && params.urlParams || {});
  var kw = String(keyword || '').trim();
  if (kw) next.urlParams.query = kw;
  else delete next.urlParams.query;
  next.searchKeyword = kw;
  return next;
}

function assertCollectableBossTab(tab) {
  var url = (tab && tab.url) || '';
  if (!url || url.indexOf('zhipin.com') < 0 || url.indexOf('/web/geek/jobs') < 0) {
    throw new Error('请先打开 BOSS 直聘岗位搜索页');
  }
  if (url.indexOf('_security_check') >= 0) {
    throw new Error('请先完成 BOSS 安全验证后再收集');
  }
}

// Multi-city: collect jobs from one city in a background tab and return results
async function collectOnTab(cityCode, params) {
  const urlParams = params.urlParams ? { ...params.urlParams, city: cityCode } : { city: cityCode };
  const url = buildJobUrl(urlParams);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabLoad(tabId);
    await waitForContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, { type: 'DO_COLLECT', params: { ...params, urlParams } });
    if (response && response.success && response.jobs) {
      const cityName = cityCodeToName(cityCode);
      return response.jobs.map(function(job) {
        job.searchKeyword = params.searchKeyword || urlParams.query || '';
        job.matchedKeywords = uniqueStrings((job.matchedKeywords || []).concat(job.searchKeyword || []));
        job.cityCode = cityCode;
        job.cityName = cityName;
        job.salaryMidK = parseSalaryMidK(job.salary || '');
        return job;
      });
    }
    return [];
  } catch (e) {
    throw e;
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// 客户端硬过滤：BOSS 模糊匹配返回脏数据，按"全词命中"剔除非期望岗位
// 规则：选中的任一期望岗位的所有关键词都出现在 job.name 里 → 留
// 期望岗位为空 → 不过滤（兜底）；过滤后 0 条 → 打 warn 但仍返回 0 条不阻塞
// picker(严格) + 自定义(字符重叠) 期望岗位合集，用于 cluster/招呼语/发送（filter 仍区分两类）

// 1.4.0: BOSS 城市码 → 城市名（四城 + 兜底）
function cityCodeToName(cityCode) {
  var map = {
    '101190400': '苏州', '101210100': '杭州', '101020100': '上海', '101210400': '宁波',
    '101190100': '南京', '101190200': '无锡', '101280100': '广州',
  };
  return map[cityCode] || (cityCode || '');
}

// 1.4.0: 解析薪资字符串为月薪中位值（K），如 "15-30K·14薪" → 22.5，"8-13K·13" → 10.5
function parseSalaryMidK(salary) {
  if (!salary) return 0;
  var m = String(salary).match(/(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)/);
  if (!m) {
    var single = String(salary).match(/(\d+(?:\.\d+)?)/);
    return single ? Number(single[1]) : 0;
  }
  return (Number(m[1]) + Number(m[2])) / 2;
}

function allExpectedPositions(state) {
  const sp = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  const cp = Array.isArray(state.customPositions) ? state.customPositions : [];
  return sp.concat(cp);
}
function filterJobsByExpected(jobs, selectedPositions, customPositions) {
  const picker = Array.isArray(selectedPositions) ? selectedPositions : [];
  const custom = Array.isArray(customPositions) ? customPositions : [];
  if (!picker.length && !custom.length) return jobs;
  // 采集过滤与分组/发送同源：能归进某期望词组（matchJobToExpected !== '其他'）即保留。
  // 这样「保留 ⟺ 可归组」，被采进来的岗位不会在 B 页落「其他」。
  const filtered = jobs.filter(job => {
    if (!String((job && job.name) || '')) return false;
    return matchJobToExpected(job, picker, custom) !== '其他';
  });
  if (filtered.length === 0) {
    console.warn('[filterJobsByExpected] 过滤后 0 条', { before: jobs.length, selectedPositions, customPositions });
  }
  return filtered;
}

// 单个 job → 期望岗位名 的打分匹配。统一委托共享真相源 matchJobToExpected（constants.js），
// 与 popup prepareGroups 完全同源 → 编辑 key === 发送 key，归组一致。分来源：picker 严格 / custom 宽松。
function matchJobToPosition(job, picker, custom) {
  return matchJobToExpected(job, picker, custom);
}

// Cluster jobs by primary tag (matching content-side logic in JobCollector.clusterByTag)
function clusterJobs(jobs, picker, custom) {
  const clusters = {};
  const positions = (Array.isArray(picker) ? picker : []).concat(Array.isArray(custom) ? custom : []);
  if (positions.length) {
    // 按用户期望岗位聚类（镜像 popup prepareGroups 匹配逻辑），确保每个期望岗位独立生成招呼语
    for (const pos of positions) { clusters[pos] = []; }
    clusters['其他'] = [];
    for (const job of jobs) {
      const bestPos = matchJobToPosition(job, picker, custom);
      if (bestPos !== '其他') clusters[bestPos].push(job);
      else clusters['其他'].push(job);
    }
    if (clusters['其他'].length === 0) delete clusters['其他'];
    return clusters;
  }
  // Fallback: 按 BOSS tag 首项聚类
  for (const job of jobs) {
    const primaryTag = (job.tags && job.tags[0]) || '其他';
    if (!clusters[primaryTag]) clusters[primaryTag] = [];
    clusters[primaryTag].push(job);
  }
  return clusters;
}

function sampleJDs(clusters, perCluster = 5) {
  const samples = {};
  for (const [tag, tagJobs] of Object.entries(clusters)) {
    samples[tag] = tagJobs.slice(0, perCluster).map(j => ({
      title: j.name || j.title,
      tags: j.tags,
      desc: j.detail || j.desc || j.description || j.name || j.title,
    }));
  }
  return samples;
}

async function stopCollect() {
  try { DiagLogger.userEvent('sw.collect', '用户停止采集 (STOP_COLLECT)'); } catch (_) {}
  state.phase = 'idle';
  pushState();
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));
}

// ── 发送完成（切换到 review 或 fallback）──
async function finishSend() {
  try {
    var _dOk = 0, _dFail = 0, _dSkip = 0;
    for (var _di = 0; _di < state.sendResults.length; _di++) {
      var _dr = state.sendResults[_di];
      if (_dr && _dr.success) _dOk++; else if (_dr && _dr.skipped) _dSkip++; else _dFail++;
    }
    DiagLogger.info('sw.send', '阶段完成：finishSend ok=' + _dOk + ' fail=' + _dFail + ' skip=' + _dSkip + ' total=' + state.sendResults.length);
  } catch (_) {}
  state.phase = 'review';
  state.sendDuration = Date.now() - sendStartTime;
  state.sendProgress = { sent: state.sendProgress.sent, total: state.sendProgress.total };
  await saveHandledJobRecords(state.sendResults, 'send');
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_COMPLETE,
    results: state.sendResults,
    duration: state.sendDuration,
    missedCount: (state._v6MissedJobs || []).length,
  }).catch(() => {});
}

// ── 诊断滚动归档（ring buffer，保留最近 5 次投递任务）──
// 每次任务终态写一份「本轮完整诊断摘要」（时间戳/sendResults 摘要+全量/脱敏 snapshot）到 diag:recentRuns。
// 即使用户开新任务清内存，历史 5 份仍在；导出时按时间窗定位是哪次投递。
function archiveRecentRun(reason) {
  return new Promise(function (resolve) {
    try {
      var results = (state.sendResults || []);
      var ok = 0, fail = 0, skip = 0, failures = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        if (r.success) ok++;
        else { if (r.skipped) skip++; else fail++; }
        if (!r.success) {
          failures.push({
            position: String(r.positionName || '').slice(0, 30),
            company: String(r.companyName || '').slice(0, 30),
            error: String(r.error || '').slice(0, 120),
            time: r.time || 0,
          });
        }
      }
      var run = {
        endTs: Date.now(),
        reason: reason,
        snapshot: buildSnapshotSummary(),  // 已脱敏
        sendSummary: { total: results.length, ok: ok, fail: fail, skip: skip },
        failures: failures.slice(0, 50),
        // sendResults 全量（脱敏：只留岗位/公司/状态/错误/时间，不含招呼语/简历）
        sendResults: results.map(function (x) {
          x = x || {};
          return {
            jobId: x.jobId,
            positionName: String(x.positionName || '').slice(0, 40),
            companyName: String(x.companyName || '').slice(0, 40),
            success: !!x.success,
            skipped: !!x.skipped,
            error: String(x.error || '').slice(0, 120),
            time: x.time || 0,
          };
        }),
      };
      chrome.storage.local.get(STORAGE_KEYS.DIAG.RECENT_RUNS, function (got) {
        var arr = (got && Array.isArray(got[STORAGE_KEYS.DIAG.RECENT_RUNS])) ? got[STORAGE_KEYS.DIAG.RECENT_RUNS] : [];
        arr.push(run);
        while (arr.length > 5) arr.shift();  // ring buffer：仅保留最近 5 次
        var put = {}; put[STORAGE_KEYS.DIAG.RECENT_RUNS] = arr;
        chrome.storage.local.set(put, function () { resolve(); });
      });
    } catch (e) { resolve(); }
  });
}

// ── 统一终态出口 ──
// 所有任务结束路径（成功完成 / 失败 / 用户停止 / stage1 超时）都汇到这里：
// 为「在队列里但从未产出结果」的岗位补一条中性灰「未投递」结果，再走 review。
// 永不再走 phase='idle'+ERROR 的死胡同（那会让 popup 死卡「正在投递」）。
async function finalizeTask(reason) {
  try { DiagLogger.info('sw.send', 'finalizeTask reason=' + reason + ' queueLeft=' + ((state.sendQueueV6 || []).length) + ' results=' + state.sendResults.length); } catch (_) {}
  // 把仍残留在发送队列、却没有任何 sendResults 记录的岗位，记为「未投递」（中性灰）
  var recorded = {};
  for (var ri = 0; ri < state.sendResults.length; ri++) {
    if (state.sendResults[ri] && state.sendResults[ri].jobId != null) recorded[state.sendResults[ri].jobId] = true;
  }
  var leftovers = collectV6QueueSnapshot();
  // 已建联（stage1 点过「立即沟通」，hrName 非空）但没有任何投递结果记录的岗位，
  // 留作 review 提示并补一条可见 sendResults；扩展不会自动补发。
  // 排除：已有结果记录（成功/失败/跳过，在 recorded/sentJobIds）的、空/占位招呼语的（#36 保险丝语义，
  // 正常路径这类岗早被 dropMissingGreetingJobs 剔队并记失败，此处兜底不让其入补发清单）。
  var _missed = [], _missedSeen = {};
  for (var mi = 0; mi < leftovers.length; mi++) {
    var mt = leftovers[mi];
    if (!mt || mt.jobId == null || !mt.hrName) continue;
    if (recorded[mt.jobId] || _missedSeen[mt.jobId]) continue;
    if (isGreetingMissing(mt.greeting)) continue;
    _missedSeen[mt.jobId] = true;
    _missed.push(mt);
    recorded[mt.jobId] = true;
    state.sendResults.push({
      jobId: mt.jobId,
      positionName: mt.positionName || '',
      companyName: mt.companyName || '',
      success: false,
      skipped: true,
      missed: true,
      hrName: mt.hrName,
      error: reason === 'stopped'
        ? '已建联但停止前未确认发送，需人工核对后再决定是否重试'
        : '已建联但未确认发送，需人工核对后再决定是否重试',
      time: Date.now(),
    });
    updateJobStatus(mt.jobId, 'failed');
  }
  state._v6MissedJobs = _missed;
  if (_missed.length) {
    try { DiagLogger.info('sw.send', '状态不确定清单：' + _missed.length + ' 个已建联但未确认送达岗位（reason=' + reason + '）'); } catch (_) {}
  }
  for (var li = 0; li < leftovers.length; li++) {
    var it = leftovers[li];
    if (!it || it.jobId == null || recorded[it.jobId]) continue;
    recorded[it.jobId] = true;
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: it.jobId,
      positionName: it.positionName || '',
      companyName: it.companyName || '',
      success: false,
      skipped: true,                       // 计入 failCount，renderReview 以中性灰呈现
      hrName: it.hrName || '',
      error: reason === 'stopped' ? '未投递：已停止' : '未投递',
      time: Date.now(),
    });
    updateJobStatus(it.jobId, 'skipped');
  }
  // sent/total 反映本批所有已记录结果（已投 + skip + 未投递），review 据此展示
  state.sendProgress = { sent: state.sendResults.length, total: state.sendResults.length };
  state.sendPhase = '';
  await persistState();
  // 诊断滚动归档：把本轮完整诊断摘要存进 diag:recentRuns（最近 5 次），开新任务清内存也不丢
  try { await archiveRecentRun(reason); } catch (_) {}
  await finishSend();
}

// ════════════════════════════════════════════════════════════════
// v5 发送协调 — 双页面串行循环
// ════════════════════════════════════════════════════════════════

async function startSendV5(jobIds) {
  sendStartTime = Date.now();

  // 构建发送队列（过滤已发送）
  const filtered = [];
  for (const id of jobIds) {
    if (sentJobIds.has(id)) continue;
    const job = state.jobs.find(j => j.id === id);
    if (!job) continue;
    filtered.push({
      jobId: id,
      positionName: job.name || '',
      companyName: job.company || '',
      jobLink: job.link || '',
      greeting: state.greetings[job?.tags?.[0] || '其他'] || '',
    });
  }
  if (filtered.length === 0) throw new Error('所有岗位均已发送');

  state.phase = 'sending';
  state.sendQueue = filtered;
  state.sendIndex = 0;
  state.sendProgress = { sent: 0, total: filtered.length };
  state.searchTabId = null;
  pushState();

  // 找到搜索页 tab
  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) throw new Error('搜索页面已关闭');
  state.searchTabId = jobTabs[0].id;
  await waitForContentScript(state.searchTabId);

  // 打开/复用聊天页 tab
  let chatTabId = state.chatTabId;
  if (chatTabId) {
    try {
      const existing = await chrome.tabs.get(chatTabId);
      if (!existing || !existing.url?.includes('/web/geek/chat')) chatTabId = null;
    } catch (_) { chatTabId = null; }
  }
  if (!chatTabId) {
    const ct = await chrome.tabs.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      active: true,
    });
    chatTabId = ct.id;
    state.chatTabId = ct.id;
    await waitForTabLoad(ct.id);
  }
  pushState();
  await waitForContentScript(chatTabId);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  // 串行循环
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    // 搜索页：点立即沟通
    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error && startResp.error.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 聊天页：发送招呼语+简历
    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName: hrName,
        hrCompany: hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused';
          pushState();
          break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) {
        state.phase = 'captcha_paused';
        pushState();
        break;
      }
      await recordV5Failure(item, err.message);
      continue;
    }

    // 随机 2-4s 延迟（最后一个不等）
    if (i < filtered.length - 1 && state.phase === 'sending') {
      const delay = 333;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // 清理聊天 tab
  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();

  if (state.phase === 'sending') await finishSend();
}

async function recordV5Success(item) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: true,
    positionName: item.positionName, companyName: item.companyName,
  });
  await persistConfirmedDelivery();
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: true, positionName: item.positionName },
  }).catch(() => {});
}

async function recordV5Failure(item, error) {
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, success: false, error,
    positionName: item.positionName, companyName: item.companyName,
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: false, error, positionName: item.positionName },
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════
// 投递数量闸门 —— 日累积计数器（本地自然日，零点归零）
// 口径：当天「成功发起沟通」的岗位数。成功落账处 +1，幂等（同 jobId 不重复计）。
// 完全独立于发送批次状态：自带 storage key，跨 SW 重启读储存里的 {date,count} 复活；
// date 与今天不符即视为 0（跨日归零，不主动清旧 key）。绝不与核心 send state 耦合。
// ────────────────────────────────────────────────────────────
function localDateKey() {
  // 本地自然日 YYYY-MM-DD（避免 toISOString 的 UTC 偏移导致零点判定错位）
  var d = new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 本批已计数的 jobId（幂等去重）：startSendV6 每批开始清空
let _dailyCountedJobIds = new Set();

async function getDailySendCount() {
  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    if (rec && rec.date === localDateKey() && typeof rec.count === 'number') return rec.count;
  } catch (_) {}
  return 0; // 无记录 / 跨日 / 异常 → 视为今日 0
}

async function incrementDailySendCount(jobId) {
  // 幂等：同一 jobId 本批只 +1。
  if (jobId != null) {
    if (_dailyCountedJobIds.has(jobId)) return;
    _dailyCountedJobIds.add(jobId);
  }
  try {
    var today = localDateKey();
    var r = await chrome.storage.local.get(STORAGE_KEYS.SW.DAILY_SEND_COUNT);
    var rec = r[STORAGE_KEYS.SW.DAILY_SEND_COUNT];
    var count = (rec && rec.date === today && typeof rec.count === 'number') ? rec.count : 0;
    count += 1;
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.DAILY_SEND_COUNT]: { date: today, count: count } });
  } catch (_) {}
}

// 投递错位止血 #3：调用契约——只有「确认发给了正确 HR」才可调本函数。
// 前置不变量（调用方保证）：① WORKER_ACTIVATE 返回 success（含 fallback 命中已通过身份断言）；
// ② WORKER_SEND 返回 success（内容确认送达）。任一不满足走 recordV6Failure，绝不标成功。
async function recordV6Success(item) {
  sentJobIds.add(item.jobId);
  updateJobStatus(item.jobId, 'sent');
  state.sendProgress.sent++;
  incrementDailySendCount(item.jobId); // 投递数量闸门：成功投递 +1（幂等、独立落盘）
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: true, hrName: item.hrName, time: Date.now()
  });
  await persistConfirmedDelivery();
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true }
  }).catch(() => {});
}

async function recordV6Failure(item, error, stage) {
  updateJobStatus(item.jobId, 'failed');
  state.sendProgress.sent++;
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: false, error: error, stage: stage || null, hrName: item.hrName, time: Date.now()
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: false, error: error }
  }).catch(() => {});
}

async function resumeSendV5() {
  state.chatTabId = null;

  const jobTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (jobTabs.length === 0) {
    state.phase = 'idle';
    state.sendProgress = { sent: 0, total: 0 };
    pushState();
    chrome.runtime.sendMessage({ type: 'ERROR', message: '搜索页面已关闭，无法恢复发送' }).catch(() => {});
    return;
  }
  state.searchTabId = jobTabs[0].id;

  const unsentJobs = state.jobs.filter(j => !sentJobIds.has(j.id));
  state.sendQueue = unsentJobs.map(j => ({
    jobId: j.id,
    positionName: j.name || '',
    companyName: j.company || '',
    jobLink: j.link || '',
    greeting: state.greetings[j?.tags?.[0] || '其他'] || '',
  }));
  state.sendIndex = 0;
  state.sendProgress = { sent: sentJobIds.size, total: state.jobs.length };
  state.phase = 'sending';
  pushState();

  const ct = await chrome.tabs.create({
    url: 'https://www.zhipin.com/web/geek/chat',
    active: true,
  });
  state.chatTabId = ct.id;
  pushState();
  await waitForTabLoad(ct.id);
  await waitForContentScript(ct.id);
  // 切回搜索 tab（后台 tab 节流修复）
  await chrome.tabs.update(state.searchTabId, { active: true });

  try {
    await waitForContentScript(state.searchTabId);
  } catch (e) {
    for (const item of state.sendQueue) {
      await recordV5Failure(item, '搜索页未就绪(恢复)');
    }
    await finishSend();
    return;
  }

  // 继续主循环——复用 startSendV5 的循环逻辑
  const filtered = state.sendQueue;
  const chatTabId = state.chatTabId;
  for (let i = 0; i < filtered.length && state.phase === 'sending'; i++) {
    const item = filtered[i];
    state.sendIndex = i;
    let hrName = '', hrCompany = '';

    try {
      const startResp = await chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_START_CHAT,
        jobLink: item.jobLink,
        positionName: item.positionName,
        companyName: item.companyName,
      });
      if (!startResp || !startResp.success) {
        if (startResp?.error?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
        await recordV5Failure(item, startResp?.error || '启动聊天失败');
        continue;
      }
      hrName = startResp.hrName || '';
      hrCompany = startResp.hrCompany || '';
      // 等 BOSS 服务端创建会话 + 推送到聊天 tab
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    try {
      const sendResp = await chrome.tabs.sendMessage(chatTabId, {
        type: MSG.DO_SEND_CHAT,
        hrName, hrCompany,
        greeting: item.greeting,
        jobId: item.jobId,
      });
      if (!sendResp || !sendResp.success) {
        if (sendResp?.captchaDetected || sendResp?.error?.includes('captcha')) {
          state.phase = 'captcha_paused'; pushState(); break;
        }
        await recordV5Failure(item, sendResp?.error || '发送失败');
        continue;
      }
      await recordV5Success(item);
    } catch (err) {
      if (err.message?.includes('captcha')) { state.phase = 'captcha_paused'; pushState(); break; }
      await recordV5Failure(item, err.message);
      continue;
    }

    if (i < filtered.length - 1 && state.phase === 'sending') {
      await new Promise(r => setTimeout(r, 333));
    }
  }

  try { await chrome.tabs.remove(state.chatTabId); } catch (_) {}
  state.chatTabId = null;
  state.searchTabId = null;
  state.sendQueue = [];
  state.sendIndex = 0;
  pushState();
  if (state.phase === 'sending') await finishSend();
}

// ════════════════════════════════════════════════════════════════
// v6 发送协调 — 搜索页批量提取 + 3 worker 并行发送
// ════════════════════════════════════════════════════════════════

async function resumeSendV6() {
  await bootRestored;         // 冷启动竞态防护：等 selectedPositions/greetings 等恢复完，防止 dropMissingGreetingJobs 误剔好岗位
  try { DiagLogger.info('sw.send', 'resumeSendV6：SW 重启后恢复发送任务 sendPhase=' + state.sendPhase + ' queueLen=' + ((state.sendQueueV6 || []).length)); } catch (_) {}
  try { _diagMarkSelfTabOps(); } catch (_) {} // 下面清理残留 worker tab 属扩展自身操作
  // 清理残留 worker：优先关独立后台窗口（连带关 tab），tab remove 作兜底
  for (var wi = 0; wi < (state._v6WorkerWindowIds || []).length; wi++) {
    try { await chrome.windows.remove(state._v6WorkerWindowIds[wi]); } catch (e) {}
  }
  state._v6WorkerWindowIds = [];
  for (var i = 0; i < state._v6WorkerTabIds.length; i++) {
    try { await chrome.tabs.remove(state._v6WorkerTabIds[i]); } catch(e) {}
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerTabsReady.clear();

  var interrupted = collectV6QueueSnapshot();
  for (var i = 0; i < interrupted.length; i++) {
    var item = interrupted[i];
    if (!item || item.jobId == null || findSendResultByJobId(item.jobId)) continue;
    state.sendResults.push({
      jobId: item.jobId,
      positionName: item.positionName || '',
      companyName: item.companyName || '',
      success: false,
      skipped: true,
      hrName: item.hrName || '',
      error: item.hrName
        ? '任务中断：已建立沟通，需人工核对对话后再决定是否重试'
        : '任务中断：未确认建立沟通，需重新逐岗确认',
      time: Date.now(),
    });
    updateJobStatus(item.jobId, item.hrName ? 'failed' : 'unsent');
  }
  state._v6MissedJobs = [];
  await finalizeTask('interrupted');
  await cleanupV6();
}

// ════════════════════════════════════════════════════════════════
// pre-flight：BOSS 自带「自动打招呼」必须确认处于关闭状态。
// 该模板是扩展招呼语之外的独立外发来源，正文无法在逐岗复核中锁定。
// 因此只读检查、绝不自动改账户设置；开启或读取失败都按不安全状态中止。
// 开关关闭后若「立即沟通」触发整页跳转，由既有 #39 stage1 恢复链继续处理。
// ════════════════════════════════════════════════════════════════
const GREETING_PREFLIGHT_TIMEOUT_MS = 20000;

async function ensureBossDefaultGreetingDisabled(searchTabId) {
  try {
    var result = await Promise.race([
      _checkBossDefaultGreetingDisabled(searchTabId),
      new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            ok: false,
            timeout: true,
            errorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
            error: '检查 BOSS 自带自动招呼语状态超时',
          });
        }, GREETING_PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return result || { ok: false };
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight 异常，按失败处理：' + e.message); } catch (_) {}
    return {
      ok: false,
      errorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
      error: e.message || '无法确认 BOSS 自带自动招呼语是否关闭',
    };
  }
}

async function _checkBossDefaultGreetingDisabled(searchTabId) {
  var read = null;
  try {
    await waitForContentScript(searchTabId);
    read = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
  } catch (e) {
    read = { success: false, error: e.message };
  }
  var safety = evaluateBossGreetingSafety(read);
  if (!safety.ok) {
    try {
      DiagLogger.warn(
        'sw.greeting',
        'pre-flight：BOSS 自带招呼语未确认关闭 code=' + safety.errorCode
          + ' err=' + (safety.error || (read && read.error) || '未知')
      );
    } catch (_) {}
  } else {
    try { DiagLogger.info('sw.greeting', 'pre-flight：BOSS 自带招呼语已关闭'); } catch (_) {}
  }
  return safety;
}

async function startSendV6(jobIds, sendOptions) {
  await bootRestored;         // 冷启动竞态防护：等 boot-restore 完成再建队列，防止被旧值覆盖
  if (!Array.isArray(jobIds) || jobIds.length !== 1) {
    throw new Error('安全门禁：每次只能沟通一个岗位');
  }
  if (sentJobIds.has(jobIds[0])) {
    throw new Error('该岗位已有本机送达记录，已阻止重复沟通');
  }
  // 每日投递上限（风控保护）：超过 DAILY_SEND_LIMIT 硬拦；自动投递用自身的 dailyLimit
  try {
    var todayCount = await getDailySendCount();
    var _autoDaily = (sendOptions && sendOptions.autoRun && state.autoRun && state.autoRun.config && state.autoRun.config.dailyLimit)
      ? Number(state.autoRun.config.dailyLimit) : CONFIG.DAILY_SEND_LIMIT;
    var _limit = Math.min(_autoDaily, CONFIG.DAILY_SEND_LIMIT);
    if (todayCount >= _limit) {
      var err = new Error('今日投递已达上限（' + _limit + '），请明日再试');
      err.errorCode = 'SEND_DAILY_LIMIT';
      throw err;
    }
  } catch (e) {
    if (e && e.errorCode === 'SEND_DAILY_LIMIT') throw e;
    // 计数读取失败不阻塞投递，仅记录
    try { DiagLogger.warn('sw.dailyLimit', '每日计数读取失败: ' + (e && e.message || e)); } catch (_) {}
  }

  try { DiagLogger.userEvent('sw.send', '任务启动：开始投递 jobs=' + ((jobIds && jobIds.length) || 0) + ' hrActiveFilter=' + (state.hrActiveFilter || '不限')); } catch (_) {}
  sendAborted = false;        // 新批次开始，清掉上一轮的停止标记
  sendStartTime = Date.now(); // v6 也记录开始时间，finishSend/finalizeTask 计算耗时用
  await loadSendGreetingPreference();
  var hasConfirmedGreeting = !!(
    sendOptions
    && typeof sendOptions.confirmedGreeting === 'string'
    && sendOptions.confirmedGreeting.trim()
  );
  if (hasConfirmedGreeting) {
    // 逐岗 token 已锁定文字；此处不读取含图片 Data URL 的 ui:jobCustom。
    state.jobCustom = {};
  } else {
    await loadJobCustomIntoState();
  }
  state.sendQueueV6 = buildSendQueueV6(state, jobIds, sendOptions);
  state._v6CurrentBatchQueue = state.sendQueueV6.slice();
  state.sendQueueV6Index = 0;
  state.sendProgress = { sent: 0, total: jobIds.length };
  state.sendResults = [];
  _dailyCountedJobIds.clear(); // 投递数量闸门：新批次清幂等去重集（计数本身落盘累积，不归零）
  state._v6MissedJobs = []; // 新批次开始，清上一批状态不确定清单
  dropMissingGreetingJobs(); // 空招呼语保险丝：空/占位 greeting 不入队，记失败（须在 sendResults/sentJobIds 重置之后）
  state._v6CurrentBatchQueue = state._v6CurrentBatchQueue.filter(function(item) { return !sentJobIds.has(item.jobId); });
  state.phase = 'sending';
  state.sendPhase = 'stage1';
  await persistState();

  // 查找所有搜索 tab（SW 重启后 state.searchTabId 丢失）
  // 多城市采集时可能有多个 tab，每个 tab 对应一个城市的搜索页
  var searchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (!searchTabs.length) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: '未找到BOSS直聘搜索页，请重新发送' }).catch(() => {});
    return;
  }

  // pre-flight：BOSS 自带自动招呼语必须关闭，防止它绕过逐岗复核另发未知文本。
  // 状态读取失败同样硬拦；扩展绝不自动修改用户的 BOSS 账户设置。
  var greetPre = await ensureBossDefaultGreetingDisabled(searchTabs[0].id);
  if (!greetPre.ok) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    try { DiagLogger.warn('sw.greeting', '任务中止：BOSS 自带自动招呼语未确认关闭'); } catch (_) {}
    var greetError = greetPre.errorCode === 'BOSS_DEFAULT_GREETING_ENABLED'
      ? '请先在 BOSS「消息通知→设置打招呼语」关闭自动打招呼。扩展不会替你改设置，也不会在它开启时发送。'
      : '无法确认 BOSS 自带自动招呼语已关闭，本次未发送。请检查登录和网络后重试。';
    var preflightError = new Error(greetError);
    preflightError.errorCode = greetPre.errorCode || 'BOSS_GREETING_STATUS_UNKNOWN';
    throw preflightError;
  }
  // pre-flight 最长 20s，期间用户可能点了停止 → 立即 bail（stopSend 已负责清场/终态）

  // ── 投递前定位岗位卡片：把首个搜索 tab 导航到目标岗位可命中的搜索页 ──
  // 真机验证结论：
  //  · 实名公司岗位：按「岗位名」query 常搜不到（算法推荐页分页），按「公司名」query 命中率高（复知智云/北觅/大我等）。
  //  · 匿名公司岗位（"某大型XX公司"，BOSS 隐藏真实名）：公司名不可搜索，必须按「岗位名」query 才能定位（真机：大模型Agent应用专家投成）。
  // 因此两阶段：公司名优先（实名命中）→ 岗位名兜底（匿名命中）。每阶段导航后注入脚本验证
  // 目标 jobId 的岗位卡片是否在搜索页（DOM 含 job_detail 链接），命中即停。
  // 首屏已有卡片时导航后 findCardByLink 同样能匹配，不影响成功路径。
  var _qFirst = state.sendQueueV6 && state.sendQueueV6[0];
  var _qJobId = _qFirst && _qFirst.jobId ? String(_qFirst.jobId) : '';
  var _qPosition = _qFirst && _qFirst.positionName ? String(_qFirst.positionName).trim() : '';
  var _qCompany = _qFirst && _qFirst.companyName ? String(_qFirst.companyName).trim() : '';
  // 两阶段搜索词：公司名（实名可搜）→ 岗位名（匿名兜底），过滤匿名占位/空串
  var _qTerms = [];
  if (_qCompany && _qCompany.indexOf('某') !== 0) _qTerms.push(_qCompany);
  if (_qPosition && _qPosition.indexOf('某') !== 0) _qTerms.push(_qPosition);
  for (var _qi = 0; _qi < _qTerms.length; _qi++) {
    var _qTerm = _qTerms[_qi];
    try {
      var _qUrl = 'https://www.zhipin.com/web/geek/jobs?query=' + encodeURIComponent(_qTerm);
      await chrome.tabs.update(searchTabs[0].id, { url: _qUrl });
      await sleep(3500);
      await waitForContentScript(searchTabs[0].id, 5000, 5);
      // 注入脚本验证目标 jobId 是否在搜索页（滚 8 次加载更多，最多 ~12s）
      var _qHit = false;
      if (_qJobId) {
        try {
          var _qRes = await chrome.scripting.executeScript({
            target: { tabId: searchTabs[0].id },
            func: function(targetJobId) {
              return new Promise(function(resolve) {
                var hit = false;
                var check = function() {
                  var links = Array.from(document.querySelectorAll('a[href*="/job_detail/"]'));
                  hit = links.some(function(h) { return h.href.indexOf(targetJobId) >= 0 || h.getAttribute('href').indexOf(targetJobId) >= 0; });
                  if (hit) { resolve(true); return; }
                  window.scrollTo(0, document.body.scrollHeight);
                };
                var tries = 0;
                var iv = setInterval(function() {
                  if (hit) { clearInterval(iv); resolve(true); return; }
                  check();
                  tries++;
                  if (tries >= 10) { clearInterval(iv); resolve(false); }
                }, 1500);
              });
            },
            args: [_qJobId],
          });
          _qHit = _qRes && _qRes[0] && _qRes[0].result === true;
        } catch (eScr) {
          try { DiagLogger.warn('sw.send', '搜索页 jobId 验证失败: ' + (eScr.message || eScr)); } catch (_) {}
        }
      }
      if (_qHit) {
        try { DiagLogger.userEvent('sw.send', '投递前导航搜索页命中（' + (_qi === 0 ? '公司名' : '岗位名') + '）: ' + _qTerm); } catch (_) {}
        break; // 命中，用当前搜索页进入 stage1
      }
      try { DiagLogger.userEvent('sw.send', '投递前导航未命中（' + (_qi === 0 ? '公司名' : '岗位名') + '）: ' + _qTerm + '，尝试下一词'); } catch (_) {}
    } catch (e) {
      try { DiagLogger.warn('sw.send', '搜索页导航失败（沿用原 tab）: ' + (e.message || e)); } catch (_) {}
      break;
    }
  }

  // 遍历所有搜索 tab，逐个激活并提取 HR 信息
  // 每个 tab 上的 DOM 只包含对应城市的岗位卡片
  for (var ti = 0; ti < searchTabs.length; ti++) {
    var tab = searchTabs[ti];
    // 检查是否还有待处理的岗位
    var remainingCount = state.sendQueueV6.filter(function(item) { return !item.hrName; }).length;
    if (remainingCount === 0) {
      break;
    }

    try {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(2000);
      state.searchTabId = tab.id;
      await runStage1();
    } catch(e) {
      console.error('[猎职] v6 stage1: tab', (ti + 1), '处理失败:', e.message);
      // 单个 tab 失败不影响其它 tab，继续下一个
    }
  }


  // 硬中止：stage1 期间被停 → stopSend 已置终态并清场，这里直接退出，不再进 stage2

  await sleep(CONFIG.POST_EXTRACT_DELAY_MS);

  // 过滤掉 hrName 为空的岗位——滤掉前逐个记入 sendResults（带提取失败原因），不再静默丢弃
  var _extractFailed = state.sendQueueV6.filter(function(item) { return !item.hrName; });
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return item.hrName; });
  for (var _fi = 0; _fi < _extractFailed.length; _fi++) {
    var _ft = _extractFailed[_fi];
    recordV6TerminalResult(_ft, {
      skipped: true,
      error: '未投递：' + (_ft.extractError || '未能在搜索页找到该岗位卡片'),
    });
  }
  if (_extractFailed.length) {
    pushState();
  }

  // 剥离 alreadyChatted=true 的岗位：BOSS 标记已沟通过，chatBtn 进 disabled 态，stage2 必然 findConv 失败
  // → 直接计入 sendResults 成功 + alreadyChatted 标，不入 worker queue
  var _skippedAlready = state.sendQueueV6.filter(function(item) { return item.alreadyChatted; });
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return !item.alreadyChatted; });
  for (var _si = 0; _si < _skippedAlready.length; _si++) {
    var _it = _skippedAlready[_si];
    if (sentJobIds.has(_it.jobId)) continue;
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: _it.jobId,
      positionName: _it.positionName,
      companyName: _it.companyName,
      success: false,
      alreadyChatted: true,
      hrName: _it.hrName,
      time: Date.now(),
    });
    updateJobStatus(_it.jobId, 'alreadyChatted');
  }
  if (_skippedAlready.length) {
    pushState();
  }

  if (!state.sendQueueV6.length) {
    // 队列空（无论是全 skip、还是 stage1 全提取失败/超时）→ 统一进终态出口，绝不再走
    // phase='idle'+ERROR 死胡同（旧死胡同会让 popup 死卡「正在投递」）。
    // finalizeTask 为「队列里但无结果」的岗位补「未投递」中性灰记录，再进 review。
    await finalizeTask('done');
    return;
  }

  var preStage2SearchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  var preStage2GreetingSafety = preStage2SearchTabs.length
    ? await ensureBossDefaultGreetingDisabled(preStage2SearchTabs[0].id)
    : {
        ok: false,
        errorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
        error: '未找到可检查 BOSS 自动招呼语状态的搜索页',
      };
  if (!preStage2GreetingSafety.ok) {
    var preStage2Error = new Error(
      preStage2GreetingSafety.errorCode === 'BOSS_DEFAULT_GREETING_ENABLED'
        ? 'BOSS 自带自动招呼语已开启，本次发送已中止'
        : '无法确认 BOSS 自带自动招呼语已关闭，本次发送未继续'
    );
    preStage2Error.errorCode = preStage2GreetingSafety.errorCode || 'BOSS_GREETING_STATUS_UNKNOWN';
    throw preStage2Error;
  }
  try { DiagLogger.info('sw.send', '阶段转换：stage1 → stage2 queueLen=' + state.sendQueueV6.length); } catch (_) {}
  state.sendPhase = 'stage2';
  state.sendProgress.total = state.sendQueueV6.length;
  await persistState();
  await runStage2();
  await teardownWorkerWindows();
  // CAPTCHA 暂停时不 finalize：保留任务状态，等 RESUME_SEND 恢复
  if (state.phase === 'captcha_paused') {
    // 保留 state.sendQueueV6 供恢复，标记暂停位置
    state.sendPhase = 'captcha_paused';
    pushState();
    return;
  }
  await finalizeTask('done');
  await cleanupV6();
}

async function runStage1() {
  // 等待搜索 tab 就绪
  await waitForContentScript(state.searchTabId);

  // #39 跳转恢复：重置本轮恢复状态 + 记录搜索页 URL（goBack 失败时兜底直跳）
  state._stage1InFlight = null;
  _stage1DoneJobIds.clear();
  _stage1SentQueue = null;
  _stage1RecoveryCount = 0;
  _stage1RecoveryActive = false;
  try {
    var _sTab = await chrome.tabs.get(state.searchTabId);
    if (_sTab && _sTab.url) state._stage1SearchUrl = _sTab.url;
  } catch (eUrl) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 记录搜索页 URL 失败（goBack 兜底将不可用）: ' + eUrl.message); } catch (_) {}
  }

  return new Promise(function(resolve, reject) {
    var timedOut = false;
    var settled = false;
    // 超时保护：2 分钟（20 岗位 × ~2s + 余量）。#39：恢复环每次重发剩余队列后 re-arm，
    // 否则多段完成的长任务会被首段超时误杀。
    var timeout = null;
    var armTimeout = function() {
      clearTimeout(timeout);
      timeout = setTimeout(function() {
        timedOut = true;
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        chrome.runtime.onMessage.removeListener(handler);
        reject(new Error('runStage1 超时：' + (CONFIG.CONVERSATION_TIMEOUT_MS * 20) + 'ms 内未收到 EXTRACT_COMPLETE'));
      }, CONFIG.CONVERSATION_TIMEOUT_MS * 20);
    };
    armTimeout();

    // #39 恢复环钩子①：重发剩余队列切片（恢复序列 e 步调用），同时重置总超时
    _stage1ResendQueue = function(slice) {
      if (settled || timedOut) return false;
      armTimeout();
      // 注意：不重置 _stage1SentQueue——基准恒为首次发出的原始队列，重发切片由 done 集合过滤得出
      chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_BATCH_EXTRACT,
        queue: slice,
        hrActiveFilter: state.hrActiveFilter || '不限'
      }).catch(function(err) {
        try { DiagLogger.warn('sw.flow', '[#39恢复] 重发 DO_BATCH_EXTRACT 失败: ' + err.message); } catch (_) {}
        if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('重发失败:' + err.message);
      });
      return true;
    };

    // #39 恢复环钩子②：恢复不能续时强制了结 stage1——resolve 让 startSendV6 继续走，
    // itemDone 已落账的岗保留 hrName 进 stage2，其余岗汇入现有 !hrName 失败记账/finalizeTask 终态。
    _stage1ForceSettle = function(reason) {
      if (settled) return;
      settled = true;
      timedOut = true; // 复用闸门，阻止 in-flight handler 再处理
      clearTimeout(timeout);
      abortStage1 = null;
      _stage1ResendQueue = null;
      _stage1ForceSettle = null;
      chrome.runtime.onMessage.removeListener(handler);
      try { DiagLogger.warn('sw.flow', '[#39恢复] 强制了结 stage1（汇入现有终态路径）reason=' + reason); } catch (_) {}
      resolve();
    };

    // 硬中止挂钩：stopSend 调用此函数即让 stage1 立刻 resolve 走终态（不等 120s 超时）
    abortStage1 = function() {
      if (settled) return;
      settled = true;
      timedOut = true; // 复用 timedOut 闸门，阻止 in-flight 的 handler 再处理
      clearTimeout(timeout);
      abortStage1 = null;
      _stage1ResendQueue = null;
      _stage1ForceSettle = null;
      chrome.runtime.onMessage.removeListener(handler);
      resolve();
    };

    var handler = function(msg, sender) {
      if (msg.type === MSG.EXTRACT_COMPLETE && sender.tab && sender.tab.id === state.searchTabId) {
        if (timedOut) return;
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handler);
        if (msg.success) {
          for (var i = 0; i < msg.results.length; i++) {
            var r = msg.results[i];
            _stage1DoneJobIds.add(r.jobId); // #39：兜底 itemDone 丢失（SW 冷启动竞态等）
            var item = state.sendQueueV6.find(function(q) { return q.jobId === r.jobId; });
            if (item) {
              item.hrName = r.hrName;
              item.hrCompany = r.hrCompany;
              item.alreadyChatted = !!r.alreadyChatted;
            }
          }
          // HR 活跃不符的跳过项：从发送队列剔除（不进 stage2）+ 记一条「未投递」结果
          var _skipped = msg.skipped || [];
          for (var sk = 0; sk < _skipped.length; sk++) {
            var _s = _skipped[sk];
            var _idx = state.sendQueueV6.findIndex(function(q) { return q.jobId === _s.jobId; });
            var _qit = _idx >= 0 ? state.sendQueueV6[_idx] : null;
            state.sendProgress.sent++;
            state.sendResults.push({
              jobId: _s.jobId,
              positionName: _qit ? _qit.positionName : '',
              companyName: _qit ? _qit.companyName : '',
              success: false, skipped: true,
              error: '未投递：HR活跃不符' + (_s.activeDesc ? '（' + _s.activeDesc + '）' : ''),
              time: Date.now()
            });
            if (_idx >= 0) state.sendQueueV6.splice(_idx, 1);
          }
          // 提取失败项：把失败原因挂到队列项上，统一由 startSendV6 过滤空 hrName 时记入 sendResults。
          // 此处不立即剔除——多城市多 tab 场景下，本 tab 找不到的岗位可能在下一个 tab 提取成功。
          var _failed = msg.failed || [];
          for (var fl = 0; fl < _failed.length; fl++) {
            var _f = _failed[fl];
            var _fItem = state.sendQueueV6.find(function(q) { return q.jobId === _f.jobId; });
            if (_fItem && !_fItem.hrName) _fItem.extractError = _f.error;
          }
          pushState();
        }
        resolve();
      } else if (msg.type === MSG.EXTRACT_PROGRESS && sender.tab && sender.tab.id === state.searchTabId) {
        // #39：带 stage 字段 = 跳转恢复专用进度（beforeClick/itemDone）；无 stage = 老用法进度展示。
        // 两种用法严格分流，互不影响。
        if (msg.stage === 'beforeClick') {
          // 点「立即沟通」前快照：BOSS 整页跳转摧毁 CS 时，恢复环据此把该岗记建联成功
          state._stage1InFlight = {
            index: msg.index, jobId: msg.jobId, jobName: msg.jobName,
            hrName: msg.hrName, hrCompany: msg.hrCompany, ts: Date.now()
          };
        } else if (msg.stage === 'itemDone') {
          // 逐岗实时落账（与 EXTRACT_COMPLETE 成功路径同字段 merge，幂等）——
          // 多段完成时，已完成段即使收不到 EXTRACT_COMPLETE 也不丢建联结果。
          // 处理过即 done（无论 success 与否），恢复环重发切片据此过滤，不依赖下标。
          _stage1DoneJobIds.add(msg.jobId);
          if (state._stage1InFlight && state._stage1InFlight.jobId === msg.jobId) state._stage1InFlight = null;
          if (msg.success) {
            var _pItem = state.sendQueueV6.find(function(q) { return q.jobId === msg.jobId; });
            if (_pItem) {
              _pItem.hrName = msg.hrName;
              _pItem.hrCompany = msg.hrCompany;
              _pItem.alreadyChatted = !!msg.alreadyChatted;
            }
          }
        } else {
          // 老用法 {done,total,extracted}：进度展示，原样保留
          chrome.runtime.sendMessage({
            type: MSG.SEND_PROGRESS,
            sent: msg.extracted,
            total: msg.total,
            status: '正在提取HR信息'
          }).catch(function() {});
        }
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    var doSend = function(retryCount) {
      retryCount = retryCount || 0;
      if (!_stage1SentQueue) _stage1SentQueue = state.sendQueueV6; // #39：仅首发赋值，恢复重发不重置（done 集合过滤的恒定基准）
      chrome.tabs.sendMessage(state.searchTabId, {
        type: MSG.DO_BATCH_EXTRACT,
        queue: state.sendQueueV6,
        hrActiveFilter: state.hrActiveFilter || '不限'
      }).catch(function(err) {
        if (timedOut || settled) return;
        var isBFCache = err.message.includes('back/forward cache') || err.message.includes('message channel') || err.message.includes('port') || err.message.includes('Receiving end does not exist');
        if (retryCount < 5 && isBFCache) {
          console.warn('[猎职] runStage1: BFCache/port closed, 重试 ' + (retryCount + 1) + '/5, 重新激活 tab');
          chrome.tabs.update(state.searchTabId, { active: true }).then(function() {
            setTimeout(function() { doSend(retryCount + 1); }, 1500);
          }).catch(function() {
            setTimeout(function() { doSend(retryCount + 1); }, 1500);
          });
          return;
        }
        settled = true;
        abortStage1 = null;
        _stage1ResendQueue = null;
        _stage1ForceSettle = null;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handler);
        console.error('[猎职] runStage1: sendMessage 最终失败', err.message);
        reject(new Error('无法向搜索页发送提取指令: ' + err.message));
      });
    };

    // 先尝试激活 tab（防止 BFCache），再发送
    chrome.tabs.update(state.searchTabId, { active: true }).then(function() {
      setTimeout(function() { doSend(0); }, 1500);
    }).catch(function() {
      setTimeout(function() { doSend(0); }, 500);
    });
  });
}

// ════════════════════════════════════════════════════════════════
// #39 阶段1跳转恢复环——跳转检测 + 恢复序列
// 状态机：搜索页被 BOSS 整页跳到 /web/geek/chat（仅阶段1活跃 + 主框架导航才触发）
//   → a.等消息页 CS 就绪 → b.点「沟通新职位」确认弹窗 → c.该岗按建联成功落账
//   → d.goBack 回搜索页等 CS 就绪 → e.重发剩余队列（runStage1 的 pending promise
//   全程不动，最终段 EXTRACT_COMPLETE 正常 resolve；恢复环可重复触发，上限 30 次）。
//   任何一步失败：该岗记失败（extractError，汇入现有 !hrName 失败记账），能续则续，
//   不能续 _stage1ForceSettle 强制了结 → startSendV6 继续走现有 finalizeTask 终态。绝不挂死。
// ════════════════════════════════════════════════════════════════
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  try {
    if (!changeInfo || !changeInfo.url) return;                              // 只认主框架导航
    if (state.phase !== 'sending' || state.sendPhase !== 'stage1') return;   // 阶段1活跃前置守卫
    if (tabId !== state.searchTabId) return;
    if (changeInfo.url.indexOf('/web/geek/chat') < 0) return;
    if (_stage1RecoveryActive) {
      try { DiagLogger.info('sw.flow', '[#39恢复] 恢复进行中，忽略重复跳转事件 tab=' + tabId); } catch (_) {}
      return;
    }
    _stage1RecoveryActive = true;
    _runStage1Recovery(tabId).catch(function (e) {
      try { DiagLogger.warn('sw.flow', '[#39恢复] 恢复序列未捕获异常: ' + e.message); } catch (_) {}
      if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('未捕获异常:' + e.message);
    }).finally(function () { _stage1RecoveryActive = false; });
  } catch (_) {}
});

async function _runStage1Recovery(tabId) {
  var inFlight = state._stage1InFlight;
  var step = 'a';
  _stage1RecoveryCount++;
  try {
    DiagLogger.info('sw.flow', '[#39恢复] 检测到搜索页被跳转到消息页，触发恢复 #' + _stage1RecoveryCount
      + ' tab=' + tabId + ' inFlight=' + (inFlight ? (inFlight.jobId + '/' + (inFlight.jobName || '')) : '无'));
  } catch (_) {}

  // 该岗记失败：挂 extractError，由 startSendV6 现有 !hrName 过滤统一记入 sendResults（防双记账）
  function markInFlightFailed(reason) {
    if (!inFlight) {
      // beforeClick 丢失（如 SW 冷启动竞态）：无法定位触发岗，留痕后按 done 集合重发全部未完成项
      try { DiagLogger.warn('sw.flow', '[#39恢复] beforeClick缺失，无法定位触发岗，按done集合重发全部未完成项'); } catch (_) {}
      return;
    }
    var it = state.sendQueueV6.find(function (q) { return q.jobId === inFlight.jobId; });
    if (it && !it.hrName) it.extractError = reason;
    state._stage1InFlight = null;
  }

  if (_stage1RecoveryCount > STAGE1_RECOVERY_MAX) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 超过恢复次数上限 ' + STAGE1_RECOVERY_MAX + '，强制了结 stage1'); } catch (_) {}
    markInFlightFailed('[#39恢复] 超过恢复次数上限');
    if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('恢复次数超限(' + STAGE1_RECOVERY_MAX + ')');
    return;
  }

  // 停止语义：每步之间查 sendAborted——用户点停止时 stopSend 已调 abortStage1 走现有停止路径，恢复立即中断
  if (sendAborted) {
    try { DiagLogger.info('sw.flow', '[#39恢复] 检测到停止标记，中断恢复走现有停止路径'); } catch (_) {}
    return;
  }

  var confirmed = false;
  try {
    // ── a. 等消息页 CS 就绪（PING 握手 3s × 5 次 ≈ 15s 上限，复用 runStage1 同款探测） ──
    step = 'a';
    await waitForContentScript(tabId, 3000, 5);
    try { DiagLogger.info('sw.flow', '[#39恢复] a.消息页 CS 就绪'); } catch (_) {}
    if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] a 后检测到停止，中断恢复'); } catch (_) {} return; }

    // ── b. 点「沟通新职位」确认弹窗（CS 内部轮询最多 8s，SW 侧 12s 兜底） ──
    step = 'b';
    var resp = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: MSG.CONFIRM_CHANGE_JOB_DIALOG }),
      new Promise(function (resolve) { setTimeout(function () { resolve({ clicked: false, reason: 'SW侧12s超时' }); }, 12000); })
    ]);
    if (resp && resp.clicked) {
      try { DiagLogger.info('sw.flow', '[#39恢复] b.确认弹窗已点击'); } catch (_) {}
    } else {
      // 弹窗可能已被用户手点/自己消失，warn 留痕后照常走 c
      try { DiagLogger.warn('sw.flow', '[#39恢复] b.确认弹窗未点到（继续走落账）reason=' + ((resp && resp.reason) || '无响应')); } catch (_) {}
    }
    confirmed = true;
  } catch (eAB) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 第' + step + '步失败: ' + eAB.message + '（该岗记失败，继续回搜索页续投）'); } catch (_) {}
    markInFlightFailed('[#39恢复] 第' + step + '步失败:' + eAB.message);
  }

  // ── c. 该岗按建联成功落账（与 EXTRACT_COMPLETE 成功路径同字段：hrName/hrCompany/alreadyChatted） ──
  if (confirmed && inFlight) {
    step = 'c';
    var item = state.sendQueueV6.find(function (q) { return q.jobId === inFlight.jobId; });
    if (item) {
      item.hrName = inFlight.hrName || item.hrName || '';
      item.hrCompany = inFlight.hrCompany || item.hrCompany || '';
      item.alreadyChatted = false;
      pushState();
      try { DiagLogger.info('sw.flow', '[#39恢复] c.岗位落账建联成功 jobId=' + inFlight.jobId + ' hr=' + (item.hrName || '?') + '（stage2 正常发消息）'); } catch (_) {}
    } else {
      try { DiagLogger.warn('sw.flow', '[#39恢复] c.队列中未找到 jobId=' + inFlight.jobId + '，跳过落账'); } catch (_) {}
    }
    state._stage1InFlight = null;
  } else if (!inFlight) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 无 inFlight 快照（跳转非点击引发？），跳过落账直接回搜索页'); } catch (_) {}
  }

  if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] c 后检测到停止，中断恢复'); } catch (_) {} return; }

  try {
    // ── d. 回搜索页：goBack 优先，失败兜底直跳记录的搜索页 URL，再等 CS 就绪（≤15s） ──
    step = 'd';
    try {
      await chrome.tabs.goBack(tabId);
      try { DiagLogger.info('sw.flow', '[#39恢复] d.goBack 回搜索页'); } catch (_) {}
    } catch (eBack) {
      if (!state._stage1SearchUrl) throw new Error('goBack 失败且无记录的搜索页 URL: ' + eBack.message);
      try { DiagLogger.warn('sw.flow', '[#39恢复] d.goBack 失败(' + eBack.message + ')，改 tabs.update 直跳搜索页'); } catch (_) {}
      await chrome.tabs.update(tabId, { url: state._stage1SearchUrl });
    }
    try { await waitForTabLoad(tabId, 10000); } catch (eLoad) { /* BFCache 秒回可能不触发 complete，靠下方 PING 兜底 */ }
    await waitForContentScript(tabId, 3000, 5);
    try { DiagLogger.info('sw.flow', '[#39恢复] d.搜索页 CS 就绪'); } catch (_) {}

    if (sendAborted) { try { DiagLogger.info('sw.flow', '[#39恢复] d 后检测到停止，中断恢复'); } catch (_) {} return; }

    // ── e. 重发剩余队列：原始全段按 done 集合过滤（jobId 基准，免疫 splice/多段下标错位），恢复环对新段继续生效 ──
    // inFlight 那岗已在 c 步落账（成功或 extractError），排除；inFlight=null（beforeClick 丢失）时不排除——
    // 撞跳转那岗会被重发，回搜索页后按钮已变「继续沟通」，CS 侧 alreadyChatted 预判接住，安全。
    step = 'e';
    var _inFlightJobId = inFlight ? inFlight.jobId : null;
    var sentQ = _stage1SentQueue || state.sendQueueV6;
    var slice = sentQ.filter(function (it) {
      return it && !_stage1DoneJobIds.has(it.jobId) && it.jobId !== _inFlightJobId;
    });
    if (!slice.length) {
      // 队列已尽：本段没有 EXTRACT_COMPLETE 了，直接了结（itemDone/c 已逐岗落账，合并语义与单段一致）
      try { DiagLogger.info('sw.flow', '[#39恢复] e.剩余队列为空，stage1 多段聚合完成'); } catch (_) {}
      if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('恢复后剩余队列为空，正常完成');
      return;
    }
    if (typeof _stage1ResendQueue === 'function' && _stage1ResendQueue(slice)) {
      try { DiagLogger.info('sw.flow', '[#39恢复] e.重发剩余 ' + slice.length + ' 岗 DO_BATCH_EXTRACT（总超时已重置，恢复环继续生效）'); } catch (_) {}
    } else {
      try { DiagLogger.warn('sw.flow', '[#39恢复] e.stage1 已 settle（停止/超时），不再重发'); } catch (_) {}
    }
  } catch (eDE) {
    try { DiagLogger.warn('sw.flow', '[#39恢复] 第' + step + '步失败: ' + eDE.message + '，强制了结 stage1 走现有终态'); } catch (_) {}
    markInFlightFailed('[#39恢复] 第' + step + '步失败:' + eDE.message);
    if (typeof _stage1ForceSettle === 'function') _stage1ForceSettle('第' + step + '步失败:' + eDE.message);
  }
}

async function runStage2() {
  if (!chrome.alarms) {
    console.error('[猎职] runStage2: chrome.alarms 不可用！请在 manifest.json permissions 添加 "alarms"');
  }
  var workerCount = Math.min(CONFIG.MAX_SEND_WORKERS, state.sendQueueV6.length);
  // ② 0-WS 起步防泄漏：上一批若有未关干净的 worker 窗口（cleanup 失败或异常），
  //    先强关，避免本批叠加旧 WS 连接。正常路径下 cleanupV6 已关，这里只是兜底。
  if (state._v6WorkerWindowIds && state._v6WorkerWindowIds.length) {
    for (var lw = 0; lw < state._v6WorkerWindowIds.length; lw++) {
      try { await chrome.windows.remove(state._v6WorkerWindowIds[lw]); } catch (e) {}
    }
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerWindowIds = [];
  state._v6WorkerTabsReady.clear();

  // 创建 worker tab —— 每个放进独立的后台窗口
  // 根因：worker tab 处 hidden 状态时 BOSS WS 行为异常，多 hidden tab 同跑 → WS 重连风暴丢帧卡 loading。
  // 独立窗口的活跃 tab 即使窗口非焦点也保持 visibilityState='visible'、不被节流、WS 正常。
  // focused:false 不抢用户焦点；绝不能 minimized（minimized → hidden → WS 又坏），state 用 'normal'。
  for (var i = 0; i < workerCount; i++) {
    // 大尺寸（1280×800）减少被主窗遮挡致 visibilityState='hidden'→WS 风暴的概率
    // （wsProbe.dump 实证 worker 窗 2/3 为 hidden，是漏发主因）。focused:false 不抢焦点。
    var win = await chrome.windows.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      focused: false,
      state: 'normal',
      width: 1280,
      height: 800,
    });
    if (win && win.id != null) state._v6WorkerWindowIds.push(win.id);
    var workerTab = win && win.tabs && win.tabs[0];
    if (workerTab && workerTab.id != null) state._v6WorkerTabIds.push(workerTab.id);
  }
  try { DiagLogger.info('sw.send', 'stage2 worker 窗口已创建 tabs=' + JSON.stringify(state._v6WorkerTabIds)); } catch (_) {}

  // 等所有 worker CS 就绪（超时 10s）
  await new Promise(function(resolve) {
    var check = function() {
      if (state._v6WorkerTabsReady.size >= workerCount) { resolve(); return; }
      if (state.phase !== 'sending') { resolve(); return; }
      setTimeout(check, 500);
    };
    setTimeout(function() { resolve(); }, 10000); // 超时保护
    setTimeout(check, 500);
  });

  if (state.phase !== 'sending') return;

  // 启动所有 worker loop
  var workers = state._v6WorkerTabIds.map(function(tabId) { return runWorkerLoop(tabId); });
  await Promise.allSettled(workers);
}

async function runWorkerLoop(tabId) {
  // 启动该 worker 的 keepalive 心跳（chrome.alarms 已在外层注册）
  startWorkerKeepalive(tabId);
  try {
    while (state.phase === 'sending' && state.sendPhase === 'stage2') {
      if (sendAborted) break; // 硬中止：停止后不再认领/处理任何岗位
      var job = claimNextJob(state);
      if (!job) {
        try { await chrome.tabs.sendMessage(tabId, { type: MSG.QUEUE_EMPTY }); } catch(e) {}
        break;
      }

      // ⏱️ 删：await chrome.tabs.update(tabId, { active: true }) — 抢前台破坏并行
      // ⏱️ 删：await sleep(800) — 配套 activate 的等待也删
      // 后台 tab 由 chrome.alarms keepalive + filling 时 textContent 直填保证可发

      try {
        if (sendAborted) break; // 认领后、发起前再查一次，停了立即 bail 不发任何消息
        // 步骤1: 找对话并点击（CS 内部 .click() 触发 Vue 2 导航）
        var findResp = await chrome.tabs.sendMessage(tabId, { type: MSG.WORKER_ACTIVATE, job: job });
        // 投递错位止血 #3：activate 失败（含兜底命中身份断言失败/无法核验）一律不发、不标成功。
        // findResp.success 已被 CS 端身份断言收口（fallback 未过即 success:false + identityAssertFailed），
        // 故 WORKER_SEND 不会发起、recordV6Success 不可能被触达 → 杜绝同名错投 + 误报成功。
        if (!findResp || !findResp.success) {
          await recordV6Failure(job, (findResp && findResp.error) || '未找到对话', findResp && findResp.identityAssertFailed ? 'identityAssert' : 'findConv');
          continue;
        }

        // ⏱️ 保留：1500ms 给路由后 chat-input 渲染完成（后台 tab 节流余量）
        await sleep(1500);

        if (sendAborted) break; // 发文/发图前最后一道闸：停了不发任何消息
        // 步骤2: 发送招呼语+简历
        var sendResp = await chrome.tabs.sendMessage(tabId, { type: MSG.WORKER_SEND, job: job });
        if (sendResp && sendResp.success) {
          await recordV6Success(job);
        } else {
          // sendImage 失败被 CS 吞掉不报错，故 sendResp 失败几乎都来自 sendText/发送确认。
          // 用 skipped/error 区分 stage：skipped:'image' → sendImage 阶段，否则 sendText。
          var sendStage = (sendResp && sendResp.skipped === 'image') ? 'sendImage' : 'sendText';
          await recordV6Failure(job, (sendResp && sendResp.error) || '发送失败', sendStage);
        }
      } catch(e) {
        await recordV6Failure(job, 'Worker通信失败: ' + e.message, 'worker_comm');
      }

      if (state.phase === 'captcha_paused') break;
      await sleep(200); // ⏱️ 保留：循环节流避免极端高频
    }
  } finally {
    stopWorkerKeepalive(tabId);
  }

  // 不再自动关闭 worker tab，确保消息有充足时间发送完毕
}

// 关掉 stage2 的 3 个 worker 窗口（含关窗前 ws-probe 取证 + 在飞帧落地缓冲）。
// 幂等：worker 已关时直接返回，可被 cleanupV6 重复调用而无副作用。
async function teardownWorkerWindows() {
  var hasTabs = state._v6WorkerTabIds && state._v6WorkerTabIds.length;
  var hasWins = state._v6WorkerWindowIds && state._v6WorkerWindowIds.length;
  if (!hasTabs && !hasWins) return;
  try { _diagMarkSelfTabOps(); } catch (_) {} // 扩展自己关 worker tab，onRemoved 别记成用户误操作
  stopAllWorkerKeepalives();
  // ⚠️ 关窗缓冲：worker 跑完但最后一帧可能仍在 WS 上传途中，立刻关会掐断 → 漏最后一条。给 1.5s 落地。
  await sleep(1500);
  // 🔍 WS 真因取证：关 tab 前 dump 每个 worker tab 的 ws-probe（写在 documentElement 的 data-ws-probe）。
  //    tab 一关数据就没了，必须在 remove 前抓。下一轮 GET_ERROR_LOG 读 wsProbe.dump 看 close/send/recv 序列。
  for (var pi = 0; pi < state._v6WorkerTabIds.length; pi++) {
    var ptid = state._v6WorkerTabIds[pi];
    try {
      var pres = await chrome.scripting.executeScript({
        target: { tabId: ptid },
        func: function () { return document.documentElement.getAttribute('data-ws-probe') || ''; },
      });
      var probe = (pres && pres[0] && pres[0].result) || '';
      await ErrorLogger.logError('[wsProbe:dump] tab=' + ptid + ' ' + (probe || 'EMPTY'), '', 'wsProbe.dump');
    } catch (e) {
      try { await ErrorLogger.logError('[wsProbe:dump] tab=' + ptid + ' READ_FAIL ' + (e && e.message), '', 'wsProbe.dump'); } catch (e2) {}
    }
  }
  // 优先关掉独立后台窗口（关窗口连带关 tab），再用 tab remove 作兜底
  if (state._v6WorkerWindowIds) {
    for (var wi = 0; wi < state._v6WorkerWindowIds.length; wi++) {
      try { await chrome.windows.remove(state._v6WorkerWindowIds[wi]); } catch (e) {}
    }
  }
  state._v6WorkerWindowIds = [];
  for (var ti = 0; ti < state._v6WorkerTabIds.length; ti++) {
    try { await chrome.tabs.remove(state._v6WorkerTabIds[ti]); } catch (e) {}
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerTabsReady.clear();
}

async function activateOriginalMainWindow() {
  if (!state.originalMainWindowId) return;
  try {
    await chrome.windows.update(state.originalMainWindowId, { focused: true, drawAttention: true });
  } catch (e) {
    // 主窗口可能已被用户关闭，忽略
  }
}

async function cleanupV6() {
  await teardownWorkerWindows();
  state._v6SearchReady = false;
  state.sendPhase = '';
  state.sendQueueV6 = [];
  state.sendQueueV6Index = 0;
  state._v6CurrentBatchQueue = [];
  await persistState();
  await activateOriginalMainWindow();
  // 投递收尾：自动清理多余 BOSS 搜索 tab（保留当前 searchTabId，其余搜索页全关）
  await closeIdleBossSearchTabs();
}

// ── 关闭多余的 BOSS 搜索 tab：保留 searchTabId（下轮投递复用），其余 /web/geek/jobs 搜索页全关 ──
// 只动搜索页（zhipin.com/web/geek/jobs*），不碰 job_detail / chat 页 / 用户浏览页。
// force=true 手动触发（忽略开关）；否则读 autoCloseBossTabs 开关（默认开）。
async function closeIdleBossSearchTabs(force) {
  try {
    if (!force) {
      var feat = await chrome.storage.local.get(FEATURE_KEYS.AUTO_CLOSE_BOSS_TABS);
      if (feat[FEATURE_KEYS.AUTO_CLOSE_BOSS_TABS] === false) return 0; // 开关关闭，不清理
    }
    var tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
    if (!tabs || tabs.length <= 1) return 0;
    var keepId = state.searchTabId;
    var closed = 0;
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      if (tab.id && tab.id !== keepId) {
        try {
          await chrome.tabs.remove(tab.id);
          closed++;
        } catch (e) {}
      }
    }
    if (closed > 0) {
      try { _diagMarkSelfTabOps(); } catch (_) {} // 扩展自己关 tab，别记成用户误操作
      try { DiagLogger.userEvent('sw.tab', '投递后清理多余 BOSS 搜索 tab: 关 ' + closed + ' 个（保留 searchTabId=' + keepId + '）'); } catch (_) {}
    }
    return closed;
  } catch (e) {
    try { DiagLogger.warn('sw.tab', '清理多余搜索 tab 失败: ' + (e.message || e)); } catch (_) {}
    return 0;
  }
}

async function stopSend() {
  try { DiagLogger.userEvent('sw.send', '用户点击「停止发送」(STOP_SEND) phase=' + state.phase + ' sendPhase=' + state.sendPhase + ' sent=' + (state.sendProgress && state.sendProgress.sent) + '/' + (state.sendProgress && state.sendProgress.total)); } catch (_) {}
  try { _diagMarkSelfTabOps(); } catch (_) {} // 下面要主动关 worker tab，别记成用户误操作
  // 硬中止：立即断一切，再统一进终态（review + 重新投递）。
  sendAborted = true; // ① 置全局停止标记：startSendV6/runWorkerLoop 各边界即刻 bail

  // ② 立即给搜索 tab + 所有 worker tab 发 DO_STOP，置 content 侧 stopped（停 click/发送/弹窗）
  const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  tabs.forEach((t) => chrome.tabs.sendMessage(t.id, { type: 'DO_STOP' }).catch(() => {}));

  // ③ 立即了结 runStage1 的 pending promise（不等 120s 超时）
  if (typeof abortStage1 === 'function') { try { abortStage1(); } catch (e) {} }

  stopAllWorkerKeepalives(); // 强停时清心跳

  // ④ 立即关所有 worker tab/窗（优先关独立后台窗口，连带关 tab；tab remove 兜底）
  if (state._v6WorkerWindowIds) {
    state._v6WorkerWindowIds.forEach(function(wid) {
      try { chrome.windows.remove(wid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerWindowIds = [];
  if (state._v6WorkerTabIds) {
    state._v6WorkerTabIds.forEach(function(tid) {
      try { chrome.tabs.remove(tid).catch(function(){}); } catch (e) {}
    });
  }
  state._v6WorkerTabIds = [];
  if (state._v6WorkerTabsReady) state._v6WorkerTabsReady.clear();
  state._v6SearchReady = false;

  // 清 v5 残留字段（v5 链路用）
  state.sendQueue = [];
  state.sendIndex = 0;
  state.searchTabId = null;
  state.chatTabId = null;

  // ⑤ 置统一终态：把未投出去的岗位记「未投递」中性灰，停在 review，底部按钮变「重新投递」。
  //    finalizeTask 内部会读 sendQueueV6 补记后再清空，
  //    故在 finalizeTask 之后再清队列。
  await finalizeTask('stopped');
  state.sendQueueV6 = [];
  state._v6CurrentBatchQueue = [];
  state.sendQueueV6Index = 0;
  await persistState();
  await activateOriginalMainWindow();
}

// ── 读取 API Key（从 storage 读取，首次启动由 ensureApiKey 预置） ──
async function getApiKey() {
  // 兼容两种存储：裸 apiKey（旧） + sw:aiConfig.apiKey（当前 AI 配置主通道）
  const result = await chrome.storage.local.get(['apiKey', STORAGE_KEYS.SW.AI_CONFIG]);
  if (result.apiKey) return String(result.apiKey);
  if (result[STORAGE_KEYS.SW.AI_CONFIG] && result[STORAGE_KEYS.SW.AI_CONFIG].apiKey) {
    return String(result[STORAGE_KEYS.SW.AI_CONFIG].apiKey);
  }
  return '';
}

// ── 招呼语并发生成 ──
let greetingPromise = null;

async function generateAllGreetingsConcurrent() {
  // 即时预热：以用户期望岗位为锚生成 N 条招呼语，不依赖 jdSamples / 岗位采集结果
  // 兜底：从 chrome.storage 读权威 selectedPositions
  let pickerPositions = Array.isArray(state.selectedPositions) ? state.selectedPositions.slice() : [];
  let customPos = Array.isArray(state.customPositions) ? state.customPositions.slice() : [];
  if (!pickerPositions.length && !customPos.length) {
    try {
      const { [STORAGE_KEYS.UI.FILTER_STATE]: fs } = await chrome.storage.local.get(STORAGE_KEYS.UI.FILTER_STATE);
      if (fs) {
        if (Array.isArray(fs.selectedPositions) && fs.selectedPositions.length) {
          pickerPositions = fs.selectedPositions.slice();
          state.selectedPositions = pickerPositions;
        }
        if (Array.isArray(fs.customPositions) && fs.customPositions.length) {
          customPos = fs.customPositions.slice();
          state.customPositions = customPos;
        }
      }
    } catch (e) { /* 静默 */ }
  }
  const selectedPositions = pickerPositions.concat(customPos);
  if (!selectedPositions.length) return;
  // 刷新简历图片缓存（每次批量重新压缩）+ 重置拆传去重(每批重新暂存,防后端 TTL 过期取不到图)
  _cachedResumeImages = null;
  _prepUploadedKey = null;
  const apiKey = await getApiKey();
  if (!apiKey) {
    chrome.runtime.sendMessage({ type: 'ERROR', message: '请先在设置页配置 AI API Key' }).catch(() => {});
    return;
  }

  // 加载简历图片（压缩缓存）
  let resumeImages = await loadResumeImages();

  // 已生成成功的 category 跳过，避免重复 API 调用（多触发入口同时打进来时）
  const categories = selectedPositions
    .filter(p => !(state.greetings[p] && !String(state.greetings[p]).includes('生成失败')))
    .map(p => [p, null]);
  const CONCURRENCY = CONFIG.GREETING_CONCURRENCY || 3;
  const TIMEOUT_MS = CONFIG.GREETING_TIMEOUT_MS || 120000;
  let doneCount = 0;
  const total = categories.length;

  state.greetingProgress = { done: 0, total };
  pushState();

  for (let i = 0; i < categories.length; i += CONCURRENCY) {
    const batch = categories.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(([category, samples]) =>
        (async () => {
          for (let attempt = 1; attempt <= 2; attempt++) {
            const tRaceStart = Date.now();
            try {
              const greeting = await Promise.race([
                generateGreeting(apiKey, resumeImages, samples, category),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS))
              ]);
              const tRaceEnd = Date.now();
              state.greetings[category] = greeting;
              return;
            } catch (err) {
              const tRaceEnd = Date.now();
              const raceElapsed = tRaceEnd - tRaceStart;
              const reason = err.message === 'timeout' ? `RACE_TIMEOUT@${raceElapsed}ms` : `ERR ${err.message}`;
              console.warn(`[猎职][RACE] ${category} attempt=${attempt} LOSE ${raceElapsed}ms reason=${reason}`);
              ErrorLogger.logError(`RACE_LOSE ${category} attempt=${attempt} elapsed=${raceElapsed}ms ${reason}`, err.stack, 'greeting race');
              if (attempt < 2) {
                console.warn(`Greeting generation timeout, retrying (${attempt}/2):`, category, err.message);
                continue;
              }
              console.error('Greeting generation failed (after 2 attempts):', category, err);
              ErrorLogger.logError(err.message || String(err), err?.stack, `Greeting generation failed: ${category}`);
              state.greetings[category] = '生成失败，请刷新';
            }
          }
        })()
      )
    );

    doneCount += batch.length;
    state.greetingProgress.done = Math.min(doneCount, total);
    pushState();
  }

  state.greetingProgress = { done: total, total };
  // 检查是否全部生成失败
  let allFailed = true;
  for (const cat in state.greetings) {
    if (state.greetings[cat] && !state.greetings[cat].includes('生成失败')) {
      allFailed = false; break;
    }
  }
  if (allFailed && total > 0) {
    chrome.runtime.sendMessage({ type: 'ERROR', message: '招呼语生成失败，请检查 API Key 配置' }).catch(() => {});
  }
  greetingPromise = null;
  pushState();
}

async function regenerateGreeting(category, jdSamples) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  const resumeImages = await loadResumeImages();
  const samples = jdSamples?.length ? jdSamples : (state.jdSamples?.[category] || []);
  const greeting = await generateGreeting(apiKey, resumeImages, samples, category);
  state.greetings[category] = greeting;
  pushState();
  return greeting;
}

async function doRewriteGreeting(originalGreeting, instruction, blockedNames) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  return rewriteGreeting(apiKey, originalGreeting, instruction, blockedNames);
}

// ── 首页 AI 对话框：通用求职/岗位/简历咨询，复用已配置的 OpenAI-compatible 接口 ──
async function aiHomeChat(question, history) {
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  const filterState = state.filterState || {};
  const positions = (filterState.selectedPositions || []).concat(filterState.customPositions || []).slice(0, 8);
  const systemPrompt = '你是「猎职」扩展的求职助手，帮助用户在 BOSS 直聘上优化求职策略。'
    + '你可以结合用户提供的文字简历、目标城市和期望职位给出具体建议。'
    + '回答要简洁实用，中文，避免空话套话，必要时分点。';
  const contextBlock =
    '[文字简历]\n' + (resumeText || '未提供文字简历。') + '\n\n'
    + '[当前求职配置]\n'
    + '期望职位：' + (positions.join('、') || '未设置') + '\n'
    + '目标城市：' + (filterState.selectedCities || []).join('、') || '未设置' + '\n'
    + '工作年限：' + (filterState.experience || []).join('、') || '不限' + '\n'
    + '学历要求：' + (filterState.education || []).join('、') || '不限' + '\n';
  const messages = [
    { role: 'system', content: systemPrompt },
  ];
  if (resumeText || positions.length) messages.push({ role: 'user', content: contextBlock });
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  recent.forEach((m) => {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: String(m.content || '') });
  });
  messages.push({ role: 'user', content: question });
  return callOpenAICompatible(cfg, messages, 800, 60000, 'home-ai-chat');
}

// ── 简历打分：评估简历与当前筛选配置的匹配度 ──
// 读 storage 的 ui:filterState（SW state.filterState 恒空，不能依赖）。
async function buildResumeContext() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.UI.FILTER_STATE]);
  const raw = result[STORAGE_KEYS.UI.FILTER_STATE] || {};
  const fs = typeof normalizeFilterStateDefaults === 'function' ? normalizeFilterStateDefaults(raw) : raw;
  const positions = (fs.selectedPositions || []).concat(fs.customPositions || []).slice(0, 8);
  const cities = fs.selectedCities || [];
  return {
    positions: positions.join('、') || '未设置',
    cities: (Array.isArray(cities) ? cities : []).join('、') || '未设置',
    experience: (fs.experience || []).join('、') || '不限',
    education: (fs.education || []).join('、') || '不限',
  };
}

function buildScoreResumeMessages(resumeText, ctx) {
  const systemPrompt = '你是资深求职顾问，根据求职者的文字简历和其目标岗位配置，评估简历的综合匹配度。'
    + '严格输出一个 JSON 对象，字段：score(0-100 整数)、summary(不超过 60 字的整体评价)、dimensions(数组，每项 {name, score, comment})。'
    + 'dimensions 建议含：技能匹配、经验匹配、学历匹配、期望匹配。';
  const user = '[文字简历]\n' + (resumeText || '未提供文字简历。') + '\n\n'
    + '[目标岗位配置]\n'
    + '期望职位：' + ctx.positions + '\n'
    + '目标城市：' + ctx.cities + '\n'
    + '工作年限：' + ctx.experience + '\n'
    + '学历要求：' + ctx.education + '\n\n'
    + '请按上述格式返回 JSON，评价该简历是否足以进入这些目标岗位。';
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user },
  ];
}

async function scoreResume() {
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  const ctx = await buildResumeContext();
  const messages = buildScoreResumeMessages(resumeText, ctx);
  let text;
  try {
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'score-resume', { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'score-resume');
  }
  const parsed = extractJsonObject(text);
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score || 0))),
    summary: String(parsed.summary || '').slice(0, 200),
    dimensions: Array.isArray(parsed.dimensions)
      ? parsed.dimensions.map(function (d) {
          return {
            name: String(d.name || ''),
            score: Math.max(0, Math.min(100, Number(d.score || 0))),
            comment: String(d.comment || '').slice(0, 120),
          };
        }).slice(0, 8)
      : [],
  };
}

// ── 采集后自动打分（防重复：一次采集周期内只跑一次，失败不阻塞） ──
function autoScoreResumeAfterCollect() {
  if (state.resumeScorePending) return;
  state.resumeScorePending = true;
  scoreResume()
    .then(function(result) {
      state.resumeScore = result;
      state.resumeScorePending = false;
      pushState();
    })
    .catch(function(e) {
      state.resumeScorePending = false;
      ErrorLogger.logError(e.message || String(e), e?.stack, 'auto score resume failed');
    });
}

function isCurrentSingleSendQueue(queue) {
  return queue.length === 1
    && queue[0]
    && Number(queue[0].confirmationVersion) === SINGLE_SEND_CONFIRMATION_VERSION
    && Number.isFinite(Number(queue[0].confirmationExpiresAt))
    && Number(queue[0].confirmationExpiresAt) > Date.now()
    && typeof queue[0].greeting === 'string'
    && queue[0].greeting.trim()
    && Array.isArray(queue[0].imageKeys)
    && (queue[0].sendImages !== true || queue[0].imageKeys.length > 0);
}

// ── CAPTCHA 暂停后恢复投递：续跑保留的发送队列（state.sendQueueV6） ──
async function resumeFromCaptchaPause() {
  if (state.phase !== 'captcha_paused') throw new Error('当前不在暂停状态');
  var queue = Array.isArray(state.sendQueueV6) ? state.sendQueueV6 : [];
  if (!queue.length) throw new Error('暂停任务无待发岗位');
  if (!isCurrentSingleSendQueue(queue)) {
    state.phase = 'ready';
    state.sendPhase = '';
    state.sendQueueV6 = [];
    state.sendQueueV6Index = 0;
    await persistState();
    var reviewError = new Error('旧暂停任务缺少当前逐岗确认凭据，已失效；请重新逐岗复核');
    reviewError.errorCode = 'PAUSED_TASK_REVIEW_REQUIRED';
    throw reviewError;
  }
  var searchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  var greetingSafety = searchTabs.length
    ? await ensureBossDefaultGreetingDisabled(searchTabs[0].id)
    : {
        ok: false,
        errorCode: 'BOSS_GREETING_STATUS_UNKNOWN',
        error: '未找到可检查 BOSS 自动招呼语状态的搜索页',
      };
  if (!greetingSafety.ok) {
    var greetingError = new Error(
      greetingSafety.errorCode === 'BOSS_DEFAULT_GREETING_ENABLED'
        ? 'BOSS 自带自动招呼语已开启，本次恢复已中止；请关闭后重试'
        : '无法确认 BOSS 自带自动招呼语已关闭，本次恢复未发送'
    );
    greetingError.errorCode = greetingSafety.errorCode || 'BOSS_GREETING_STATUS_UNKNOWN';
    throw greetingError;
  }
  sendAborted = false;
  state.captchaError = false;
  state.phase = 'sending';
  state.sendPhase = 'stage2';
  pushState();
  // 重新跑 stage2 发送剩余队列（runWorkerLoop 会跳过已 sentJobIds 的岗位）
  await runStage2();
  await teardownWorkerWindows();
  if (state.phase !== 'captcha_paused') {
    await finalizeTask('done');
    await cleanupV6();
  }
}

// ── 简历改写建议：基于简历 + 目标岗位给出优化建议 ──
async function rewriteResume() {
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  const ctx = await buildResumeContext();
  const systemPrompt = '你是资深简历优化顾问。根据求职者的文字简历和目标岗位配置，给出具体可操作的改写建议。'
    + '严格输出一个 JSON 对象，字段：suggestions(数组，每项 {title, detail})，每项 title 不超过 15 字，detail 不超过 100 字。';
  const user = '[文字简历]\n' + (resumeText || '未提供文字简历。') + '\n\n'
    + '[目标岗位配置]\n'
    + '期望职位：' + ctx.positions + '\n'
    + '目标城市：' + ctx.cities + '\n'
    + '工作年限：' + ctx.experience + '\n'
    + '学历要求：' + ctx.education + '\n\n'
    + '请给出 4-6 条最能提升匹配度的简历改写建议，返回 JSON。';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: user },
  ];
  let text;
  try {
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'rewrite-resume', { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 1200, 60000, 'rewrite-resume');
  }
  const parsed = extractJsonObject(text);
  return {
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map(function (s) {
          return {
            title: String(s.title || '').slice(0, 40),
            detail: String(s.detail || '').slice(0, 300),
          };
        }).slice(0, 8)
      : [],
  };
}

// ════════════════════════════════════════════════════════════════
// 诊断包：用户行为事件监听（USER_EVENT，误操作判别关键）— 纯新增模块
// 见 handoff-diagnostic-bundle-01。只读 state，不改任何业务逻辑/状态。
// ════════════════════════════════════════════════════════════════

// 「扩展自己关 tab」窗口期标记：teardown/stopSend/resume 清理期间的 onRemoved
// 不算用户误操作。8s 后自动失效（关窗动作是异步的，给足余量）。
var _diagSelfTabOpsUntil = 0;
function _diagMarkSelfTabOps() { _diagSelfTabOpsUntil = Date.now() + 8000; }

// 判断 tabId 是否任务相关（worker / 搜索 / v5 聊天 tab）
function _diagTabRole(tabId) {
  if (state._v6WorkerTabIds && state._v6WorkerTabIds.indexOf(tabId) >= 0) return 'worker';
  if (tabId === state.searchTabId) return 'search';
  if (tabId === state.chatTabId) return 'chat';
  return '';
}

// ① worker/搜索 tab 被关闭
chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
  try {
    var role = _diagTabRole(tabId);
    if (!role) return;
    var busy = state.phase === 'sending' || state.phase === 'collecting';
    if (Date.now() < _diagSelfTabOpsUntil) {
      DiagLogger.info('sw.tabs', role + ' tab 关闭（扩展自身清理）tab=' + tabId);
    } else {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被关闭（用户/外部）tab=' + tabId + ' phase=' + state.phase + (busy ? ' ⚠️ 任务进行中被关闭' : ''));
    }
  } catch (_) {}
});

// ② worker/搜索 tab 被导航走（URL 变化）。zhipin 站内 SPA/页内跳转记 INFO，离开 zhipin 记 USER_EVENT。
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  try {
    if (!changeInfo || !changeInfo.url) return;
    var role = _diagTabRole(tabId);
    if (!role) return;
    if (state.phase !== 'sending' && state.phase !== 'collecting') return;
    // 只保留 origin+path，去掉 query/hash（防泄漏搜索词等）
    var urlBrief = changeInfo.url;
    try { var u = new URL(changeInfo.url); urlBrief = u.origin + u.pathname; } catch (e2) {}
    if (changeInfo.url.indexOf('zhipin.com') < 0) {
      DiagLogger.userEvent('sw.tabs', role + ' tab 被导航离开 BOSS（疑似用户操作）tab=' + tabId + ' → ' + urlBrief + ' phase=' + state.phase);
    } else {
      DiagLogger.info('sw.tabs', role + ' tab URL 变化 tab=' + tabId + ' → ' + urlBrief);
    }
  } catch (_) {}
});

// ③ 扩展安装/更新/重载
try {
  chrome.runtime.onInstalled.addListener(function (details) {
    try {
      var v = '';
      try { v = chrome.runtime.getManifest().version; } catch (e2) {}
      DiagLogger.userEvent('sw.lifecycle', '扩展 ' + ((details && details.reason) || 'installed') + ' (v' + v + ')');
    } catch (_) {}
  });
} catch (_) {}


// ════════════════════════════════════════════════════════════════════
// 1.4.0 自动投递 MVP（startAutoRun 批处理器）
// 自动模式：一次确认整批 → 串行投递；复核模式保留单岗 PREPARE/CONFIRM。
// 不做反检测、不绕过验证码；只有平台聊天证据成立才标记 delivered。
// ════════════════════════════════════════════════════════════════════

function genRunId() {
  return 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

// 从 state.jobs 读取岗位的 aiScreen 分
function jobScreen(job) {
  return (job && job.aiScreen) || {};
}

// 分类：auto / review / skip
function classifyJob(job, cfg) {
  var scr = jobScreen(job);
  var apply = Number(scr.applyScore !== undefined ? scr.applyScore : scr.score) || 0;
  if (apply >= cfg.thresholdAuto) return { bucket: 'auto', score: apply };
  if (apply >= cfg.thresholdReview) return { bucket: 'review', score: apply };
  return { bucket: 'skip', score: apply };
}

// 硬过滤补充（自动投递专用）：城市/学历/已投/已沟通
function autoHardReject(job, state, handledSet) {
  var reasons = [];
  if (!job) return ['岗位数据缺失'];
  if (sentJobIds.has(job.jobId || job.id)) reasons.push('本机已送达');
  if (job.excludeReason) reasons.push(job.excludeReason);
  if (job.companyRisk) reasons.push('公司风险: ' + job.companyRisk);
  if (job.historySkipReason) reasons.push(job.historySkipReason);
  // 城市硬排除：BOSS 搜索已按城市过滤，此处只拦已知非目标
  if (job.cityName && state.autoRun && state.autoRun.config && state.autoRun.config.allowedCities && state.autoRun.config.allowedCities.length) {
    var cityOk = state.autoRun.config.allowedCities.some(function(c) { return (job.cityName || '').indexOf(c) >= 0; });
    if (!cityOk) reasons.push('城市不符: ' + job.cityName);
  }
  // 1.4.0 M7: 历史 jobRecords 同公司/同 HR 去重
  if (handledSet) {
    var company = String(job.company || job.companyName || '').trim().toLowerCase();
    var hr = String(job.hrName || '').trim().toLowerCase();
    if (company && hr) {
      var key = company + '|' + hr;
      if (handledSet[key]) reasons.push('历史已沟通: ' + handledSet[key]);
      else {
        // 公司名模糊：按公司名匹配任何历史 HR
        var companyMatch = Object.keys(handledSet).some(function(k) { return k.split('|')[0] === company; });
        if (companyMatch) reasons.push('历史已投同公司');
      }
    }
  }
  return reasons;
}

// 批次预览：分类 + 汇总
function buildAutoRunPreview(jobIds, cfg, handledSet) {
  var preview = {
    runId: genRunId(),
    generatedAt: Date.now(),
    config: {
      thresholdAuto: cfg.thresholdAuto,
      thresholdReview: cfg.thresholdReview,
      batchLimit: cfg.batchLimit,
      dailyLimit: cfg.dailyLimit,
      allowedCities: cfg.allowedCities || [],
      sendImages: !!cfg.sendImages,
    },
    counts: { total: 0, auto: 0, review: 0, skip: 0, rejected: 0 },
    auto: [],
    review: [],
    skip: [],
  };
  (jobIds || []).forEach(function(id) {
    var job = state.jobs.find(function(j) { return (j.jobId || j.id) === id; });
    if (!job) return;
    preview.counts.total++;
    var reject = autoHardReject(job, state, handledSet);
    if (reject.length) {
      preview.counts.rejected++;
      preview.skip.push({ jobId: id, company: job.company, position: job.name, reason: reject.join('; ') });
      return;
    }
    var cls = classifyJob(job, cfg);
    if (cls.bucket === 'auto') {
      preview.counts.auto++;
      preview.auto.push({ jobId: id, company: job.company, position: job.name, score: cls.score });
    } else if (cls.bucket === 'review') {
      preview.counts.review++;
      preview.review.push({ jobId: id, company: job.company, position: job.name, score: cls.score });
    } else {
      preview.counts.skip++;
      preview.skip.push({ jobId: id, company: job.company, position: job.name, score: cls.score, reason: 'applyScore<阈值' });
    }
  });
  // 修正：skip 计数只含"分数不足"，rejected 单独计数；此处从 skip 数组剔除 rejected 条目
  preview.skip = preview.skip.filter(function(s) { return !s.reason || s.reason.indexOf('applyScore<阈值') >= 0; });
  preview.counts.skip = preview.skip.length;
  return preview;
}

// 1.4.0: 自动投递排序（MVP 实现 applyScore 主导 + 薪资适配 + 城市白名单，其余项占位）
// 权重：applyScore 0.7 | 薪资适配 0.2 | 城市白名单 0.1；competitionScore/新鲜度/HR活跃 留空占位
function rankAutoJobs(jobs, cfg) {
  var allowedCities = (cfg && cfg.allowedCities) || [];
  return jobs.map(function(job) {
    var scr = jobScreen(job);
    var apply = Number(scr.applyScore !== undefined ? scr.applyScore : scr.score) || 0;
    // 薪资适配分：目标薪资附近最优，偏高/偏低递减
    var salaryScore = 0.5;
    var midK = Number(job.salaryMidK) || 0;
    var targetK = (cfg && cfg.targetSalaryK) || 10;
    if (midK > 0) {
      if (midK >= targetK && midK <= targetK * 1.6) salaryScore = 1;
      else if (midK < targetK) salaryScore = Math.max(0.2, midK / targetK);
      else salaryScore = Math.max(0.3, 1 - (midK - targetK * 1.6) / (targetK * 3));
    }
    // 城市白名单分
    var cityScore = 0.5;
    var city = job.cityName || '';
    if (allowedCities.length) {
      cityScore = allowedCities.some(function(c) { return city.indexOf(c) >= 0; }) ? 1 : 0.1;
    } else if (city) {
      cityScore = 1;
    }
    var rank = apply * 0.7 + salaryScore * 20 * 0.2 + cityScore * 10 * 0.1;
    // 城市硬优先：不在白名单的城市显著降权（需求：城市硬排除优先于排序）
    if (allowedCities.length && cityScore < 1) rank = rank * 0.4;
    return { jobId: job.jobId || job.id, rank: Math.round(rank * 100) / 100, applyScore: apply, salaryScore: salaryScore, cityScore: cityScore };
  }).sort(function(a, b) { return b.rank - a.rank; });
}

// 从单岗投递结果中提取最终状态
function extractJobOutcome(sendResults) {
  var list = Array.isArray(sendResults) ? sendResults : [];
  if (!list.length) return { outcome: 'uncertain', reason: '无投递结果记录' };
  // 取最后一条（本岗结果）
  var last = list[list.length - 1];
  if (last.success) return { outcome: 'delivered', reason: last.reason || '' };
  if (last.alreadyChatted) return { outcome: 'alreadyChatted', reason: '已沟通过' };
  if (last.captchaDetected || (last.error && (String(last.error).indexOf('captcha') >= 0 || String(last.error).indexOf('验证码') >= 0))) return { outcome: 'captcha', reason: last.error || '验证码' };
  if (last.error && String(last.error).indexOf('安全') >= 0) return { outcome: 'captcha', reason: last.error };
  if (last.skipped || last.missed) return { outcome: 'uncertain', reason: last.error || (last.reason || '未确认送达') };
  return { outcome: 'failed', reason: last.error || last.reason || '' };
}

// 额度检查：连续失败/不确定、同公司、同 HR、每日
function autoQuotaCheck(attemptLog, job, cfg) {
  var reasons = [];
  var successCount = attemptLog.filter(function(a) { return a.outcome === 'delivered'; }).length;
  if (successCount >= cfg.batchLimit) reasons.push('达到本批上限 ' + cfg.batchLimit);
  var consecFail = 0, consecUncert = 0;
  for (var i = attemptLog.length - 1; i >= 0; i--) {
    if (attemptLog[i].outcome === 'failed') { consecFail++; consecUncert = 0; }
    else if (attemptLog[i].outcome === 'uncertain') { consecUncert++; consecFail = 0; }
    else break;
  }
  if (consecFail >= cfg.maxConsecutiveFail) reasons.push('连续失败 ' + consecFail + ' 次');
  if (consecUncert >= cfg.maxConsecutiveUncertain) reasons.push('连续不确定 ' + consecUncert + ' 次');
  var company = job && (job.company || job.companyName || '');
  if (company) {
    var companyCount = attemptLog.filter(function(a) { return a.company === company && a.outcome === 'delivered'; }).length;
    if (companyCount >= cfg.maxPerCompany) reasons.push('同公司已达上限 ' + cfg.maxPerCompany);
  }
  var hr = job && job.hrName;
  if (hr) {
    var hrCount = attemptLog.filter(function(a) { return a.hr === hr && a.outcome === 'delivered'; }).length;
    if (hrCount >= cfg.maxPerHr) reasons.push('同 HR 已达上限 ' + cfg.maxPerHr);
  }
  // 每日上限
  return reasons;
}

// 单岗自动投递：复用 startSendV6（保持单岗），等待完成并提取结果
async function attemptJobDelivery(job, attemptId) {
  var jobId = job.jobId || job.id;
  // 停止检查：autoRunAbort 或已有 stopSend 触发的 sendAborted（startSendV6 会重置，但此处先拦）
  if (autoRunAbort || sendAborted) {
    return { attemptId: attemptId, jobId: jobId, company: job.company || job.companyName || '', hr: job.hrName || '', outcome: 'stopped', reason: '用户停止', attemptAt: Date.now() };
  }
  var beforeResults = (state.sendResults || []).length;
  await startSendV6([jobId], { autoRun: true, attemptId: attemptId });
  // 等待单岗任务进入非 sending 终态
  var deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (autoRunAbort) return { attemptId: attemptId, jobId: jobId, company: job.company || job.companyName || '', hr: job.hrName || '', outcome: 'stopped', reason: '用户停止', attemptAt: Date.now() };
    if (state.phase !== 'sending') break;
    await new Promise(function(r) { setTimeout(r, 2000); });
  }
  // 提取本岗新增结果
  var newResults = (state.sendResults || []).slice(beforeResults);
  var outcome = extractJobOutcome(newResults);
  var lastItem = newResults[newResults.length - 1] || {};
  return {
    attemptId: attemptId,
    jobId: jobId,
    company: job.company || job.companyName || '',
    hr: lastItem.hrName || job.hrName || '',
    outcome: outcome.outcome,
    reason: outcome.reason || lastItem.reason || lastItem.error || '',
    deliveredAt: outcome.outcome === 'delivered' ? Date.now() : null,
    attemptAt: Date.now(),
  };
}

// 自动投递批处理器（串行）
async function startAutoRun(frozen) {
  await bootRestored;
  var jobIds = Array.isArray(frozen.jobIds) ? frozen.jobIds : [];
  var cfg = Object.assign({
    thresholdAuto: CONFIG.AUTO_RUN_THRESHOLD_AUTO,
    thresholdReview: CONFIG.AUTO_RUN_THRESHOLD_REVIEW,
    batchLimit: CONFIG.AUTO_RUN_BATCH_LIMIT,
    dailyLimit: CONFIG.AUTO_RUN_DAILY_LIMIT,
    maxConsecutiveFail: CONFIG.AUTO_RUN_MAX_CONSECUTIVE_FAIL,
    maxConsecutiveUncertain: CONFIG.AUTO_RUN_MAX_CONSECUTIVE_UNCERTAIN,
    maxPerCompany: CONFIG.AUTO_RUN_MAX_PER_COMPANY,
    maxPerHr: CONFIG.AUTO_RUN_MAX_PER_HR,
    allowedCities: [],
    sendImages: false,
  }, frozen.config || {});

  var todayCount = await getDailySendCount();
  if (todayCount >= Math.min(cfg.dailyLimit, CONFIG.DAILY_SEND_LIMIT)) {
    throw new Error('自动投递已达每日上限（' + Math.min(cfg.dailyLimit, CONFIG.DAILY_SEND_LIMIT) + '）');
  }

  var runId = frozen.runId || genRunId();
  // 1.4.0 M7: 读取历史 jobRecords 已沟通集合，用于同公司/同 HR 去重
  var handledSet = {};
  try { handledSet = await buildHandledHrSet(); } catch (e) {
    try { DiagLogger.warn('sw.autoRun', '读取历史已沟通集合失败: ' + (e && e.message || e)); } catch (_) {}
  }
  var preview = buildAutoRunPreview(jobIds, cfg, handledSet);
  var attemptLog = [];
  var stopped = false;
  var stopReason = '';
  autoRunAbort = false; // 本批开始，清停止标记

  state.autoRun = { runId: runId, config: cfg, status: 'running', frozenJobIds: jobIds.slice(), attemptLog: attemptLog, preview: preview };
  await persistState();

  // 只处理 auto 队列（review 留给人工复核模式；skip 不投）
  // 排序：applyScore 主导 + 薪资适配 + 城市白名单
  try {
    var _autoJobs = preview.auto.map(function(p) { return state.jobs.find(function(j) { return (j.jobId || j.id) === p.jobId; }); }).filter(Boolean);
    var _ranked = rankAutoJobs(_autoJobs, cfg);
    var _rankMap = {};
    _ranked.forEach(function(r) { _rankMap[r.jobId] = r.rank; });
    preview.auto.sort(function(a, b) { return (_rankMap[b.jobId] || 0) - (_rankMap[a.jobId] || 0); });
  } catch (_) {}
  // 1.4.0 M4: 预生成岗位级招呼语；失败岗位移出 auto 队列进复核（不发空消息）
  try {
    var _greetIds = preview.auto.map(function(p) { return p.jobId; });
    var _greetRes = await buildJobGreetingMap(_greetIds);
    if (_greetRes.reviewIds.length) {
      var _reviewSet = {};
      _greetRes.reviewIds.forEach(function(id) { _reviewSet[id] = true; });
      var _keep = [], _move = [];
      preview.auto.forEach(function(p) {
        if (_reviewSet[p.jobId]) _move.push(p); else _keep.push(p);
      });
      if (_move.length) {
        preview.auto = _keep;
        preview.review = preview.review.concat(_move);
        preview.counts.auto = _keep.length;
        preview.counts.review = preview.review.length;
      }
    }
    await persistState();
  } catch (e) {
    try { DiagLogger.warn('sw.autoGreeting', '招呼语预生成失败，全部转复核: ' + (e.message || e)); } catch (_) {}
    preview.review = preview.review.concat(preview.auto);
    preview.auto = [];
    preview.counts.auto = 0;
    preview.counts.review = preview.review.length;
    await persistState();
  }
  for (var i = 0; i < preview.auto.length; i++) {
    if (sendAborted || autoRunAbort || state.phase === 'captcha_paused') { stopped = true; stopReason = state.phase === 'captcha_paused' ? '验证码暂停' : '用户停止'; break; }
    var p = preview.auto[i];
    var job = state.jobs.find(function(j) { return (j.jobId || j.id) === p.jobId; });
    if (!job) continue;
    // 额度检查
    var q = autoQuotaCheck(attemptLog, job, cfg);
    if (q.length) { stopReason = q.join('; '); stopped = true; break; }
    // 每日上限实时检查
    var dc = await getDailySendCount();
    if (dc >= Math.min(cfg.dailyLimit, CONFIG.DAILY_SEND_LIMIT)) { stopReason = '每日上限'; stopped = true; break; }

    var attemptId = runId + '-' + p.jobId;
    try {
      var rec = await attemptJobDelivery(job, attemptId);
      attemptLog.push(rec);
      if (rec.outcome === 'captcha') { state.phase = 'captcha_paused'; stopReason = '验证码暂停'; stopped = true; break; }
      if (rec.outcome === 'delivered') {
        // 成功继续，但检查本批上限
        var okCount = attemptLog.filter(function(a) { return a.outcome === 'delivered'; }).length;
        if (okCount >= cfg.batchLimit) { stopReason = '达到本批上限'; stopped = true; break; }
      }
    } catch (e) {
      attemptLog.push({ attemptId: attemptId, jobId: p.jobId, company: job.company || '', hr: job.hrName || '', outcome: 'failed', reason: String(e.message || e).slice(0, 200), attemptAt: Date.now() });
      // 单岗内部错误（如搜索页缺失）不应终止整批，记失败继续
    }
    state.autoRun.status = 'running';
    state.autoRun.attemptLog = attemptLog;
    await persistState();
    // 批间等待
    await new Promise(function(r) { setTimeout(r, 2000); });
  }

  state.autoRun.status = stopped ? 'stopped' : 'done';
  state.autoRun.stopReason = stopReason || '';
  state.autoRun.attemptLog = attemptLog;
  // 1.4.0 M5: 写入长期 jobRecords（runId/attemptId/五分类状态）
  try { await persistAutoRunRecords(attemptLog, runId); } catch (e) {
    try { DiagLogger.warn('sw.autoRecords', 'M5 记录失败: ' + (e && e.message || e)); } catch (_) {}
  }
  await persistState();
  return { runId: runId, status: state.autoRun.status, stopReason: state.autoRun.stopReason, attempts: attemptLog };
}

// 停止自动投递
async function stopAutoRun() {
  autoRunAbort = true;
  sendAborted = true;
  if (state.autoRun) state.autoRun.status = 'stopping';
  await stopSend();
  if (state.autoRun) { state.autoRun.status = 'stopped'; state.autoRun.stopReason = '用户停止'; }
  await persistState();
}

// ── 1.4.0 M4: 岗位级招呼语 ──
// 每岗独立生成 + variant/hash 存储；失败进人工复核（不发空消息/占位语）

function sha256Text(text) {
  var s = String(text || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  // 与内容绑定的一次性哈希：h 作为 32 位种子再叠一轮
  var h2 = 0x811c9dc5;
  for (var j = 0; j < s.length; j++) {
    h2 ^= s.charCodeAt(j);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return 'h-' + (h >>> 0).toString(16) + '-' + h2.toString(16);
}

async function generateJobGreeting(job) {
  var cfg = await getAiConfig();
  var resumeText = await getTextResume();
  var jd = job && (job.desc || job.detail || job.jobDesc || '');
  var jdText = String(jd || '').slice(0, 800);
  var company = job && (job.company || job.companyName || '');
  var position = job && (job.name || job.positionName || '');
  var systemPrompt = '你是求职者本人，正在 BOSS 直聘上给 HR 发送招呼语。只输出招呼语正文，不要输出解释、标题、Markdown 或字数统计。';
  // M4 结构：我是2026届 + 岗位重点 + 项目证据 + 问句
  var userPrompt = '请为这个岗位生成一段 70-110 字招呼语。\n\n[我是]\n2026届软件工程本科应届生，方向为 AI Agent / RAG 应用工程。\n\n[简历]\n' + (resumeText || '未提供') + '\n\n[岗位]\n岗位：' + position + '\n公司：' + (company || '未知') + '\nJD：' + (jdText || '暂无') + '\n\n[要求]\n1) 以“您好”开头。\n2) 点出该岗位 1-2 个核心要求（从 JD 提取），并给出对应的真实项目/技能证据（AgentKB 六阶段 Agent 流水线、RAG 检索、FastAPI/SSE、Docker 部署等，必须真实）。\n3) 口语、自然、简短，结尾用“方便沟通吗”或同类问句。\n4) 禁止写求职者姓名、招聘者姓名、客户名、公司名、学校名或署名；禁止编造经历/项目结果；禁止声称已发送/已附简历。\n5) 不要写“贵司是我唯一选择”等模板腔。';
  var generated = await callOpenAICompatible(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 500, 120000, 'jobGreeting:' + (job && job.id));
  var blocked = extractGreetingBlockedNames(resumeText || '');
  if (company) blocked.push(company);
  var cleaned = sanitizeGeneratedGreeting(generated, blocked);
  if (!cleaned) {
    var e = new Error('岗位招呼语清洗后为空，进人工复核');
    e.errorCode = 'GREETING_EMPTY';
    throw e;
  }
  return {
    text: cleaned,
    variant: 'v1',
    sha256: sha256Text(cleaned),
    generatedAt: Date.now(),
    jobId: job && (job.jobId || job.id),
    position: position,
  };
}

// 批量预生成岗位招呼语；失败岗位标记进复核
async function buildJobGreetingMap(jobIds) {
  var map = {};
  var reviewIds = [];
  for (var i = 0; i < jobIds.length; i++) {
    var job = state.jobs.find(function(j) { return (j.jobId || j.id) === jobIds[i]; });
    if (!job) { reviewIds.push(jobIds[i]); continue; }
    try {
      var g = await generateJobGreeting(job);
      map[jobIds[i]] = g;
      // 写入 state.greetings[jobId]，buildSendQueueV6 优先读取
      state.greetings = state.greetings || {};
      state.greetings[jobIds[i]] = g;
    } catch (e) {
      reviewIds.push(jobIds[i]);
      try { DiagLogger.warn('sw.autoGreeting', '岗位招呼语生成失败 jobId=' + jobIds[i] + ': ' + (e.message || e)); } catch (_) {}
    }
  }
  return { map: map, reviewIds: reviewIds };
}

// ── 1.4.0 M5: 自动投递结果写入长期 jobRecords ──
async function persistAutoRunRecords(attemptLog, runId) {
  if (typeof saveJobRecords !== 'function') return;
  var records = (Array.isArray(attemptLog) ? attemptLog : []).map(function(a) {
    var job = state.jobs.find(function(j) { return (j.jobId || j.id) === a.jobId; });
    var status;
    switch (a.outcome) {
      case 'delivered': status = 'delivered'; break;
      case 'alreadyChatted': status = 'alreadyChatted'; break;
      case 'captcha': status = 'failed'; break;
      case 'uncertain': status = 'uncertain'; break;
      case 'stopped': status = 'stopped'; break;
      default: status = 'failed';
    }
    var greetingInfo = state.greetings && state.greetings[a.jobId];
    var rec = {
      jobId: a.jobId,
      positionName: job && (job.name || job.positionName || ''),
      companyName: job && (job.company || job.companyName || ''),
      hrName: a.hr || (job && job.hrName) || '',
      city: (job && job.cityName) || '',
      salary: (job && job.salary) || '',
      status: status,
      error: a.reason || '',
      source: 'auto-send',
      runId: runId,
      attemptId: a.attemptId,
      deliveredAt: a.deliveredAt ? new Date(a.deliveredAt).toISOString() : '',
      greetingHash: greetingInfo && greetingInfo.sha256 || '',
      greetingVariant: greetingInfo && greetingInfo.variant || '',
      frozenPrediction: job && job.aiScreen ? { applyScore: job.aiScreen.applyScore, score: job.aiScreen.score } : null,
      lastHandledAt: new Date().toISOString(),
    };
    return rec;
  }).filter(function(r) { return r.jobId; });
  if (!records.length) return;
  try {
    await saveJobRecords(records);
  } catch (e) {
    try { DiagLogger.warn('sw.autoRecords', '自动投递记录保存失败: ' + (e && e.message || e)); } catch (_) {}
  }
}
