// Service Worker — 消息中枢 + OpenAI-compatible AI 代理
importScripts('/src/shared/constants.js');
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
  scoreThreshold: 60,
};

async function ensureApiKey() {
  const result = await chrome.storage.local.get(['apiKey', STORAGE_KEYS.SW.AI_CONFIG]);
  if (!result[STORAGE_KEYS.SW.AI_CONFIG]) {
    const merged = Object.assign({}, DEFAULT_AI_CONFIG, result.apiKey ? { apiKey: result.apiKey } : {});
    await chrome.storage.local.set({ [STORAGE_KEYS.SW.AI_CONFIG]: merged });
  }
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
  cfg.scoreThreshold = Math.max(0, Math.min(100, Number(cfg.scoreThreshold || DEFAULT_AI_CONFIG.scoreThreshold)));
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
      console.error(`[即投]${tag} HTTP ${resp.status} after fetch=${tFetchEnd - tFetchStart}ms`);
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
    console.error(`[即投]${msg}`);
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

function buildJobScreenPrompt(job, resumeText, expected) {
  var excludeKeywords = uniqueStrings(state.excludeKeywords || []);
  return `请判断这个岗位是否适合投递，并生成招呼语。只返回 JSON，不要 Markdown。\n\n[简历]\n${resumeText || '未提供文字简历'}\n\n[用户期望方向]\n${expected || ''}\n\n[排除规则]\n排除关键词：${excludeKeywords.join(' / ') || '无'}\n重点识别并降低评分：外包、驻场、培训推广、销售/主播/客服、讲师岗、剪辑/视频制作、游戏前端、把销售/运营包装成 AI 应用开发的岗位、非真实开发岗。\n\n[岗位]\n标题：${job.name || ''}\n公司：${job.company || ''}\n薪资：${job.salary || ''}\n标签：${(job.tags || []).join(' / ')}\nJD：${String(job.desc || job.description || job.detail || '').slice(0, 1500)}\n\n返回格式：{\"score\":0,\"reason\":\"\",\"greeting\":\"\",\"risks\":[]}\nscore 为 0-100 的匹配分；reason 不超过 40 字；greeting 为 80-120 字招呼语；risks 是字符串数组，命中排除规则时写明具体风险。`;
}

async function screenSingleJob(cfg, job, resumeText, expected) {
  const messages = [
    { role: 'system', content: '你是招聘岗位匹配助手。严格输出一个 JSON 对象，字段为 score、reason、greeting、risks。' },
    { role: 'user', content: buildJobScreenPrompt(job, resumeText, expected) },
  ];
  let text;
  try {
    text = await callOpenAICompatible(cfg, messages, 700, 60000, `screen:${job.id || job.name}`, { type: 'json_object' });
  } catch (err) {
    if (!/response_format|json_object|400/i.test(String(err.message || ''))) throw err;
    text = await callOpenAICompatible(cfg, messages, 700, 60000, `screen:${job.id || job.name}`);
  }
  const parsed = extractJsonObject(text);
  return {
    score: Math.max(0, Math.min(100, Number(parsed.score || 0))),
    reason: String(parsed.reason || '').slice(0, 160),
    greeting: String(parsed.greeting || '').trim(),
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
  var handledHrSet = skipHistoryEnabled ? await buildHandledHrSet() : {};
  return (Array.isArray(jobs) ? jobs : []).map(function(job) {
    var excludeHit = findExcludeKeywordHit(job, excludeKeywords);
    if (excludeHit) {
      job.checked = false;
      job.excludeReason = '命中排除词：' + excludeHit;
    } else {
      job.excludeReason = '';
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
  const cfg = await getAiConfig();
  const resumeText = await getTextResume();
  if (!cfg.apiKey || !cfg.model || !jobs || !jobs.length) return jobs || [];
  const threshold = cfg.scoreThreshold;
  const expected = allExpectedPositions(state).join(' / ');
  const CONCURRENCY = 2;
  let idx = 0;
  let done = 0;
  state.aiScreeningProgress = { done: 0, total: jobs.length };
  pushState();

  async function worker() {
    while (idx < jobs.length) {
      const current = jobs[idx++];
      try {
        const screening = await screenSingleJob(cfg, current, resumeText, expected);
        current.aiScreen = screening;
        current.checked = screening.score >= threshold;
        if (screening.greeting) current.aiGreeting = screening.greeting;
      } catch (err) {
        current.aiScreen = {
          score: 0,
          reason: 'AI筛选失败，请人工确认',
          greeting: '',
          risks: [err.message || 'AI error'],
          failed: true,
        };
        current.checked = false;
        ErrorLogger.logError(err.message || String(err), err?.stack, 'AI screening failed');
      }
      done++;
      state.aiScreeningProgress = { done: done, total: jobs.length };
      state.jobs = jobs;
      pushState();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));
  state.aiScreeningProgress = { done: jobs.length, total: jobs.length };
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
    pushState();
    return;
  }
  try {
    var overview = await generateBatchOverview(jobs, state.jdHydrationProgress && state.jdHydrationProgress.completedBatches || 0);
    state.aiBatchOverview = overview;
    pushState();
  } catch (e) {
    ErrorLogger.logError(e.message || String(e), e?.stack, 'generate batch overview failed');
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
      pushState();
      if (newSuccess > 0 || completedBatches === 1 || opts.forceOverviewRefresh) {
        await refreshBatchOverview(false);
      }
      if (stalledBatches >= (CONFIG.JD_HYDRATION_STALL_LIMIT || 2)) break;
    }
  } finally {
    jdHydrationRunning = false;
    state.jdHydrationProgress = buildJdHydrationProgress(jobs, false, completedBatches, stalledBatches);
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
  const userPrompt = `请根据简历和岗位方向生成一段 80-120 字招呼语。\n\n[简历]\n${resumeText || '未提供文字简历，请根据岗位方向写通用但真诚的招呼语。'}\n\n[应聘方向]\n${category}\n\n[岗位样本]\n${jdText || '暂无岗位样本'}\n\n要求：以“您好”开头，语气真诚专业，结尾自然引出简历。`;
  return callOpenAICompatible(cfg, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], 500, 120000, `greeting:${category}`);
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
        console.warn('[即投] Image compress fallback:', e.message);
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
          console.warn('[即投] Image compress fallback failed, skip image:', e2.message);
          ErrorLogger.logError(e2.message, e2.stack, 'Image compress fallback skip');
        }
      }
    }

    _cachedResumeImages = results;
    return results;
  } catch (e) {
    console.warn('[即投] Failed to load resume images:', e);
    ErrorLogger.logError(e.message || String(e), e?.stack, 'loadResumeImages');
    _cachedResumeImages = [];
    return [];
  }
}

// 商业化：重写迁移到后端 /rewrite（藏 Key，复用 /greeting 计费闸口，堵白嫖漏）。
// apiKey 参数保留仅为兼容调用方签名（doRewriteGreeting 仍传入），后端不再用客户端 Key。
async function rewriteGreeting(apiKey, originalGreeting, instruction) {
  const cfg = await getAiConfig();
  return callOpenAICompatible(cfg, [
    { role: 'system', content: '你是求职助手，帮助用户优化 BOSS 直聘招呼语。只输出重写后的招呼语正文。' },
    { role: 'user', content: `原招呼语：\n${originalGreeting}\n\n重写要求：${instruction}\n\n输出要求：80-150字，真诚专业。` },
  ], 500, 60000, 'rewrite');
}

// ── 状态管理 ──
let state = {
  phase: 'idle',
  jobs: [],
  greetings: {},
  aiScreeningProgress: { done: 0, total: 0 },
  aiBatchOverview: buildEmptyBatchOverview(),
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
  _v6RepairQueue: [],       // 发送阶段「对话已找到但内容漏发」的岗位，补发阶段单连接逐个补
  _v6MissedJobs: [],        // A1 漏发清单：已建联(hrName非空)但无任何投递结果的岗位（终态时由 finalizeTask 计算，供 review「一键补发」）
  originalMainWindowId: null,
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

function buildSendQueueV6(state, jobIds) {
  // 用「期望岗位名」作为 greeting key，与 B 页 / clusterJobs 完全一致
  // （旧实现用 job.tags[0]=BOSS卡片标签当 key，与生成时的岗位名 key 错配 → greeting 取空）
  var picker = Array.isArray(state.selectedPositions) ? state.selectedPositions : [];
  var custom = Array.isArray(state.customPositions) ? state.customPositions : [];
  return jobIds
    .filter(function(id) { return !sentJobIds.has(id); })
    .map(function(id) {
      var job = state.jobs.find(function(j) { return (j.jobId || j.id) === id; });
      if (!job) { console.warn('[即投] buildSendQueueV6: 未找到 job id=' + id); }
      var category = job ? matchJobToPosition(job, picker, custom) : '其他';
      var greeting = state.sendGreeting === false ? '' : ((job && job.aiGreeting) || state.greetings[category] || '');
      // per-job 自定义招呼语优先：该岗设了非空 customGreeting → 覆盖组级招呼语；为空/未设则保持组级 fallback（行为不变）
      var jcEntry = state.jobCustom && state.jobCustom[id];
      var jcGreeting = jcEntry && typeof jcEntry.customGreeting === 'string' ? jcEntry.customGreeting.trim() : '';
      if (state.sendGreeting !== false && jcGreeting) {
        greeting = jcGreeting;
        try { DiagLogger.info('sw.send', 'buildSendQueueV6：jobId=' + id + ' 用 per-job 自定义招呼语 len=' + jcGreeting.length); } catch (_) {}
      }
      return {
        jobId: id,
        hrName: '',
        hrCompany: '',
        greeting: greeting,
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
// greeting 为空或等于生成失败占位串的岗位发出去就是空消息（且 repair 阶段无从核对），
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
  console.warn('[即投] 空招呼语保险丝：剔除', dropped.length, '个岗位不入队');
  pushState();
}

/** 为未产出 worker 结果的队列项补记一次终态 sendResults。 */
function recordV6TerminalResult(item, opts) {
  if (!item || item.jobId == null || sentJobIds.has(item.jobId)) return false;
  opts = opts || {};
  sentJobIds.add(item.jobId);
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
  addList(state._v6RepairQueue);
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
  console.error('[即投] SW global error:', event.message, 'at', event.filename + ':' + event.lineno);
});
self.addEventListener('unhandledrejection', (event) => {
  ErrorLogger.logError(event.reason?.message || String(event.reason), event.reason?.stack, 'SW unhandled rejection');
  try { DiagLogger.error('sw.global', 'unhandledrejection: ' + (event.reason?.message || String(event.reason))); } catch (_) {}
  console.error('[即投] SW unhandled rejection:', event.reason?.message || String(event.reason));
});

// SW 启动时还原持久化状态，并确保 API Key 已预置
ensureApiKey();

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
        const _filteredJobs = filterJobsByExpected(msg.jobs || [], state.selectedPositions, state.customPositions);
        state.jobs = _filteredJobs;
        const _allPos394 = allExpectedPositions(state);
        state.clusters = _allPos394.length
          ? clusterJobs(_filteredJobs, state.selectedPositions, state.customPositions)
          : (msg.clusters || {});
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
      // sender.tab 在 side panel 场景下为 undefined，fallback 到 lastFocused 窗口
      if (sender && sender.tab && sender.tab.windowId) {
        state.originalMainWindowId = sender.tab.windowId;
      } else {
        chrome.windows.getLastFocused().then(win => {
          if (win && win.id) state.originalMainWindowId = win.id;
        }).catch(() => {});
      }
      state.hrActiveFilter = msg.hrActiveFilter || '不限';
      startSendV6(msg.jobIds).then(() => {
        sendResponse({ success: true });
      }).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'START_SEND failed');
        chrome.runtime.sendMessage({ type: 'ERROR', message: e.message }).catch(() => {});
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

    case MSG.REPAIR_MISSED:
      // A1：review 页「一键补发」漏发岗位（已建联但未发 AI 招呼语+图）
      startRepairMissed().then(() => sendResponse({ success: true })).catch((e) => {
        ErrorLogger.logError(e.message, e.stack, 'REPAIR_MISSED failed');
        sendResponse({ success: false, error: e.message });
      });
      return true;

    case 'SEND_PROGRESS':
      state.sendProgress = msg.progress;
      chrome.runtime.sendMessage(msg).catch(() => {});
      sendResponse({ success: true });
      break;

    case 'SEND_ITEM_RESULT':
      // v5 发送流程中，结果已由 recordV5Success/recordV5Failure 处理，防止重复计数
      if (state.phase === 'sending') {
        if (msg.payload?.jobId && sentJobIds.has(msg.payload.jobId)) {
          sendResponse({ success: true });
          break;
        }
      }
      // 累积发送结果，用于 Review 页
      state.sendResults.push(msg.payload);
      // 更新 sentJobIds（中断恢复用）
      if (msg.payload.success || msg.payload.error === 'partial') {
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
      doRewriteGreeting(msg.greeting, msg.instruction)
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

    case MSG.TEST_AI_CONFIG:
      callOpenAICompatible(normalizeAiConfig(msg.config), [
        { role: 'user', content: 'Reply with OK only.' },
      ], 8, 20000, 'test').then((text) => sendResponse({ success: true, message: text })).catch((e) => sendResponse({ success: false, error: e.message }));
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
      console.warn(`[即投] PING attempt ${attempt + 1}/${maxRetries} failed:`, err.message);
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
  if (alarm.name.indexOf(_workerAlarmPrefix) !== 0) return;
  var tabId = parseInt(alarm.name.slice(_workerAlarmPrefix.length), 10);
  if (!tabId || !_activeWorkerKeepalives.has(tabId)) {
    chrome.alarms.clear(alarm.name).catch(function(){});
    return;
  }
  // 异步发 PING，不 await（alarm 回调不需要保活）
  chrome.tabs.sendMessage(tabId, { type: MSG.PING }).catch(function(err) {
    // 失败可能是 tab 已关、CS 未注入、BFCache — 都不致命，下次 alarm 继续试
    console.warn('[即投] keepalive PING failed tab=' + tabId + ' err=' + err.message);
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

    for (let i = 0; i < tasks.length; i += MAX_PARALLEL) {
      const batch = tasks.slice(i, i + MAX_PARALLEL);
      const batchResults = await Promise.allSettled(
        batch.map(task => collectOnTab(task.cityCode, buildKeywordCollectParams(params, task.keyword)))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) allJobs.push(...result.value);
        }
      }

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
    allJobs = mergeCollectedJobsById(filterJobsByExpected(allJobs, state.selectedPositions, state.customPositions));
    state.jobs = await applyPostCollectRules(allJobs, state);
    ensureJobHydrationMeta(state.jobs);
    state.clusters = clusterJobs(state.jobs, state.selectedPositions, state.customPositions);
    state.jdSamples = sampleJDs(state.clusters, 5);
    state.phase = 'ready';
    saveCollectedJobRecords(state.jobs, 'collect');
    pushState();

    if (allJobs.length === 0) {
      chrome.runtime.sendMessage({ type: 'ERROR', message: '未找到匹配岗位，请调整筛选条件' }).catch(() => {});
      return;
    }

    applyAiScreeningToJobs(allJobs).then(async function(screenedJobs) {
      state.jobs = await applyPostCollectRules(screenedJobs, state);
      state.clusters = clusterJobs(state.jobs, state.selectedPositions, state.customPositions);
      state.jdSamples = sampleJDs(state.clusters, 5);
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
      return response.jobs.map(function(job) {
        job.searchKeyword = params.searchKeyword || urlParams.query || '';
        job.matchedKeywords = uniqueStrings((job.matchedKeywords || []).concat(job.searchKeyword || []));
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
    missedCount: (state._v6MissedJobs || []).length, // A1：review 页据此显示「一键补发」提示行
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
  try { DiagLogger.info('sw.send', 'finalizeTask reason=' + reason + ' queueLeft=' + ((state.sendQueueV6 || []).length) + ' repairLeft=' + ((state._v6RepairQueue || []).length) + ' results=' + state.sendResults.length); } catch (_) {}
  // 把仍残留在发送队列/补发队列、却没有任何 sendResults 记录的岗位，记为「未投递」（中性灰）
  var recorded = {};
  for (var ri = 0; ri < state.sendResults.length; ri++) {
    if (state.sendResults[ri] && state.sendResults[ri].jobId != null) recorded[state.sendResults[ri].jobId] = true;
  }
  var leftovers = collectV6QueueSnapshot();
  // A1 漏发清单：已建联（stage1 点过「立即沟通」，hrName 非空）但没有任何投递结果记录的岗位。
  // 此处留存清单（保留 greeting/hrName 等队列项字段，补发要用），并补一条可见 sendResults——
  // 「停止 = 立即硬中止」语义零改动；补发仅由 review 页「一键补发」或恢复路径触发。
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
    recorded[mt.jobId] = true;  // 标记已处理：归入待补发清单，下方循环不再把它当普通「未投递」重复记
    state.sendResults.push({
      jobId: mt.jobId,
      positionName: mt.positionName || '',
      companyName: mt.companyName || '',
      success: false,
      skipped: true,
      missed: true,
      hrName: mt.hrName,
      error: reason === 'stopped' ? '已建联但停止前未确认发送，可补发' : '已建联但未确认发送，可补发',
      time: Date.now(),
    });
  }
  state._v6MissedJobs = _missed;
  if (_missed.length) {
    try { DiagLogger.info('sw.send', 'A1 漏发清单：' + _missed.length + ' 个已建联未发岗位（reason=' + reason + '）'); } catch (_) {}
  }
  for (var li = 0; li < leftovers.length; li++) {
    var it = leftovers[li];
    if (!it || it.jobId == null || recorded[it.jobId]) continue;
    recorded[it.jobId] = true;
    sentJobIds.add(it.jobId);
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
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, success: true, positionName: item.positionName },
  }).catch(() => {});
}

async function recordV5Failure(item, error) {
  sentJobIds.add(item.jobId);
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
  // 幂等：同一 jobId 本批只 +1（worker 成功 + repair 翻成功可能对同岗调两次）
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
// ② WORKER_SEND 返回 success（内容确认送达）。任一不满足走 recordV6Failure + 补发，绝不标成功。
async function recordV6Success(item) {
  sentJobIds.add(item.jobId);
  state.sendProgress.sent++;
  incrementDailySendCount(item.jobId); // 投递数量闸门：成功投递 +1（幂等、独立落盘）
  state.sendResults.push({
    jobId: item.jobId, positionName: item.positionName, companyName: item.companyName,
    success: true, hrName: item.hrName, time: Date.now()
  });
  pushState();
  chrome.runtime.sendMessage({
    type: MSG.SEND_ITEM_RESULT,
    payload: { jobId: item.jobId, positionName: item.positionName, companyName: item.companyName, success: true }
  }).catch(() => {});
}

async function recordV6Failure(item, error, stage) {
  sentJobIds.add(item.jobId);
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

  // 找到搜索 tab
  var searchTabs = await chrome.tabs.query({ url: '*://*.zhipin.com/web/geek/jobs*' });
  if (!searchTabs.length) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    chrome.runtime.sendMessage({ type: 'ERROR', phase: 'sending', error: '未找到搜索页面，请打开BOSS直聘搜索页后重试' }).catch(() => {});
    return;
  }
  state.searchTabId = searchTabs[0].id;

  // 构建 sendQueueV6（从持久化的队列，如果有，否则从 state.jobs 重建）
  if (!state.sendQueueV6.length) {
    await loadJobCustomIntoState(); // 恢复路径重建队列也需 per-job 自定义招呼语（持久化队列已含 greeting，无需重灌）
    state.sendQueueV6 = buildSendQueueV6(state, state.jobs.map(function(j) { return j.jobId || j.id; }));
  }
  dropMissingGreetingJobs(); // 空招呼语保险丝：空/占位 greeting 不入队，记失败
  // A1 漏发补救（意外中断恢复）：已建联（hrName 非空）且无任何投递结果的岗位，不再重跑
  // stage1/stage2（重点「立即沟通」无意义、worker sendText 不核对历史有双发风险），
  // 先摘出来，stage2 之后并入 _v6RepairQueue 走 runRepairV6——repairSingle 先核对服务器
  // 历史再缺啥补啥，天然防双发。无需用户任何操作。
  var _resumeMissed = (state.sendQueueV6 || []).filter(function (it) {
    return it && it.jobId != null && it.hrName && !sentJobIds.has(it.jobId) && !isGreetingMissing(it.greeting);
  });
  if (_resumeMissed.length) {
    var _rmIds = {};
    _resumeMissed.forEach(function (it) { _rmIds[it.jobId] = true; });
    state.sendQueueV6 = state.sendQueueV6.filter(function (it) { return !it || !_rmIds[it.jobId]; });
    try { DiagLogger.info('sw.send', 'resume：' + _resumeMissed.length + ' 个已建联未发岗位转入补发队列（不重跑两阶段）'); } catch (_) {}
  }
  state.sendQueueV6Index = 0;
  state.sendPhase = 'stage1';
  await persistState();

  // 从阶段1重跑
  await runStage1();
  await sleep(CONFIG.POST_EXTRACT_DELAY_MS);
  state.sendQueueV6 = state.sendQueueV6.filter(function(item) { return item.hrName; });
  try { DiagLogger.info('sw.send', '阶段转换(resume)：stage1 → stage2 queueLen=' + state.sendQueueV6.length); } catch (_) {}
  state.sendPhase = 'stage2';
  await persistState();
  await runStage2();
  // A1：恢复前已建联未发的岗位并入补发队列（runStage2 入口会清空 _v6RepairQueue，故必须在其后并入；按 jobId 去重）
  if (_resumeMissed.length) {
    var _inQ = {};
    (state._v6RepairQueue || []).forEach(function (it) { if (it) _inQ[it.jobId] = true; });
    _resumeMissed.forEach(function (it) { if (!_inQ[it.jobId]) state._v6RepairQueue.push(it); });
  }
  await teardownWorkerWindows(); // 先关 worker 窗口 → 补发在 0-worker 单连接安静环境跑
  await sleep(3000);             // 给服务器登记连接关闭、退出多连接 kick 状态的余量
  await runRepairV6();
  await finalizeTask('done');
  await cleanupV6();
}

// ════════════════════════════════════════════════════════════════
// pre-flight：BOSS「自动打招呼」开关检测 + 自动开启（陷阱 #31）
// 开关关闭 → 点「立即沟通」整页跳 /web/geek/chat → stage1 卡死。投递前必查。
// 链路：①搜索页 CS 读 getGreetingList → enabled=true 放行
//      ②enabled 确认 false → CS API 写开（status=1）+复读自检
//      ③自检失败 → 降级：后台 tab 开 notify-set 设置页，executeScript 点 DOM 开关，
//        DOM class + getGreetingList 双确认
//      ④仍失败 → {ok:false}，调用方中止任务给用户手动指引
// 原则：读不到开关状态（网络等）= enabled 未知 → 放行投递（宁可少拦截不可误拦截，
//       老用户开关本来就开着）。全程 20s 总超时兜底，任何异常按 ok:false 走提示路径。
// ════════════════════════════════════════════════════════════════
const GREETING_PREFLIGHT_TIMEOUT_MS = 20000;

async function ensureGreetingEnabled(searchTabId) {
  try {
    var result = await Promise.race([
      _ensureGreetingEnabledImpl(searchTabId),
      new Promise(function (resolve) {
        setTimeout(function () { resolve({ ok: false, timeout: true }); }, GREETING_PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return result || { ok: false };
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight 异常，按失败处理：' + e.message); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

async function _ensureGreetingEnabledImpl(searchTabId) {
  // ① 读开关（搜索页 CS 同源 fetch 带 cookie）
  var read = null;
  try {
    await waitForContentScript(searchTabId);
    read = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
  } catch (e) {
    read = null;
  }
  if (!read || read.success !== true || typeof read.enabled !== 'boolean') {
    // 读失败 → enabled 未知 → 放行（误拦截比少拦截伤害大）
    try { DiagLogger.warn('sw.greeting', 'pre-flight：开关状态读取失败，放行投递 err=' + ((read && read.error) || '无响应')); } catch (_) {}
    return { ok: true, unknown: true };
  }
  if (read.enabled) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：打招呼开关已开启，直接放行'); } catch (_) {}
    return { ok: true };
  }

  // ② 主路径：API 写开 + 复读自检（仅在 enabled 确认为 false 时执行；CS 侧只写 status=1）
  try { DiagLogger.warn('sw.greeting', 'pre-flight：开关为关，尝试 API 自动开启 templateId=' + read.templateId); } catch (_) {}
  try {
    var wr = await chrome.tabs.sendMessage(searchTabId, {
      type: MSG.ENABLE_GREETING_SETTING,
      templateId: read.templateId,
    });
    if (wr && wr.ok && wr.enabled) {
      try { DiagLogger.info('sw.greeting', 'pre-flight：API 自动开启成功（复读自检通过）'); } catch (_) {}
      return { ok: true, autoEnabled: true };
    }
    try { DiagLogger.warn('sw.greeting', 'pre-flight：API 开启自检未通过，走降级 err=' + ((wr && wr.error) || 'enabled 仍为 false')); } catch (_) {}
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', 'pre-flight：API 开启消息失败，走降级 err=' + e.message); } catch (_) {}
  }

  // ③ 降级：后台 tab 开设置页点 DOM 开关
  var fb = await _enableGreetingViaSettingsPage(searchTabId);
  if (fb) {
    try { DiagLogger.info('sw.greeting', 'pre-flight：降级（设置页 DOM）自动开启成功'); } catch (_) {}
    return { ok: true, autoEnabled: true };
  }
  try { DiagLogger.warn('sw.greeting', 'pre-flight：降级路径也失败，任务将中止'); } catch (_) {}
  return { ok: false };
}

// 降级路径：后台 tab 开 notify-set，executeScript 注入点击「设置打招呼语」面板 + ui-switch。
// notify-set 不在 content_scripts matches 内，只能 scripting.executeScript（权限已有）。
// 每步 poll 元素就绪（不固定 sleep）；成功判据 = DOM ui-switch-checked + getGreetingList 双确认。
async function _enableGreetingViaSettingsPage(searchTabId) {
  var tab = null;
  try {
    try { _diagMarkSelfTabOps(); } catch (_) {} // 扩展自己开/关设置页 tab，别记成用户误操作
    tab = await chrome.tabs.create({ url: 'https://www.zhipin.com/web/geek/notify-set', active: false });
    // 等页面加载完（poll status，最多 8s）
    var loaded = false;
    for (var i = 0; i < 32; i++) {
      var t = await chrome.tabs.get(tab.id);
      if (t && t.status === 'complete') { loaded = true; break; }
      await sleep(250);
    }
    if (!loaded) return false;
    var res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async function () {
        function _slp(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        async function poll(fn, timeoutMs) {
          var start = Date.now();
          while (Date.now() - start < timeoutMs) {
            var v = fn();
            if (v) return v;
            await _slp(300);
          }
          return null;
        }
        // ① 切到「设置打招呼语」面板
        var nav = await poll(function () {
          var lis = document.querySelectorAll('li.nav-list');
          for (var i = 0; i < lis.length; i++) {
            if ((lis[i].textContent || '').indexOf('设置打招呼语') >= 0) return lis[i];
          }
          return null;
        }, 6000);
        if (!nav) return { ok: false, step: 'nav-not-found' };
        nav.click();
        // ② 等开关元素出现
        var sw = await poll(function () {
          return document.querySelector('.greeting-header .ui-switch');
        }, 6000);
        if (!sw) return { ok: false, step: 'switch-not-found' };
        // 只在「未开」时点击（绝不把开着的关掉）
        if (!sw.classList.contains('ui-switch-checked')) sw.click();
        // ③ poll 到 checked class 出现（DOM 侧确认）
        var checked = await poll(function () {
          var el = document.querySelector('.greeting-header .ui-switch');
          return el && el.classList.contains('ui-switch-checked') ? el : null;
        }, 5000);
        return { ok: !!checked, step: checked ? 'done' : 'class-not-checked' };
      },
    });
    var r0 = res && res[0] && res[0].result;
    if (!r0 || !r0.ok) {
      try { DiagLogger.warn('sw.greeting', '降级 DOM 点击失败 step=' + ((r0 && r0.step) || '注入无结果')); } catch (_) {}
      return false;
    }
    // ④ getGreetingList 复读双确认（经搜索页 CS）
    try {
      var re = await chrome.tabs.sendMessage(searchTabId, { type: MSG.CHECK_GREETING_SETTING });
      return !!(re && re.success === true && re.enabled === true);
    } catch (e) {
      return false;
    }
  } catch (e) {
    try { DiagLogger.warn('sw.greeting', '降级路径异常：' + e.message); } catch (_) {}
    return false;
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch (e) {} }
  }
}

async function startSendV6(jobIds) {
  await bootRestored;         // 冷启动竞态防护：等 boot-restore 完成再建队列，防止被旧值覆盖

  try { DiagLogger.userEvent('sw.send', '任务启动：开始投递 jobs=' + ((jobIds && jobIds.length) || 0) + ' hrActiveFilter=' + (state.hrActiveFilter || '不限')); } catch (_) {}
  sendAborted = false;        // 新批次开始，清掉上一轮的停止标记
  sendStartTime = Date.now(); // v6 也记录开始时间，finishSend/finalizeTask 计算耗时用
  await loadSendGreetingPreference();
  await loadJobCustomIntoState(); // per-job 自定义招呼语：建队前灌入 state.jobCustom，buildSendQueueV6 据此覆盖组级招呼语
  state.sendQueueV6 = buildSendQueueV6(state, jobIds);
  state._v6CurrentBatchQueue = state.sendQueueV6.slice();
  state.sendQueueV6Index = 0;
  state.sendProgress = { sent: 0, total: jobIds.length };
  state.sendResults = [];
  sentJobIds.clear();
  _dailyCountedJobIds.clear(); // 投递数量闸门：新批次清幂等去重集（计数本身落盘累积，不归零）
  state._v6MissedJobs = []; // 新批次开始，清上一批漏发清单（防 review 残留旧「一键补发」）
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

  // pre-flight：BOSS「自动打招呼」开关必须开启（陷阱 #31：关着时点立即沟通整页跳转，stage1 卡死）
  // 读失败放行（unknown）；确认 false 则自动开启（API 主路径 + 设置页 DOM 降级）；都失败才中止。
  var greetPre = state.sendGreeting === false ? { ok: true, skipped: true } : await ensureGreetingEnabled(searchTabs[0].id);
  if (!greetPre.ok) {
    state.phase = 'idle'; state.sendPhase = '';
    await persistState();
    try { DiagLogger.warn('sw.greeting', '任务中止：打招呼开关未开启且自动开启失败'); } catch (_) {}
    // throw → START_SEND handler 统一 sendResponse({success:false, error}) + ERROR 广播，
    // popup 两条路径展示同一文案，避免「广播先到、成功回调后到」互相覆盖的竞态。
    throw new Error('⚠️ 你的 BOSS『自动打招呼』功能未开启且自动开启失败，请到 BOSS『消息通知→设置打招呼语』手动开启后重试');
  }
  if (greetPre.autoEnabled) {
    // 非阻断提示：投递照常，告知用户已替他开了开关
    chrome.runtime.sendMessage({ type: MSG.GREETING_AUTO_ENABLED }).catch(() => {});
    try { DiagLogger.userEvent('sw.greeting', '已自动开启 BOSS「自动打招呼」开关（投递 pre-flight）'); } catch (_) {}
  }
  // pre-flight 最长 20s，期间用户可能点了停止 → 立即 bail（stopSend 已负责清场/终态）


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
      console.error('[即投] v6 stage1: tab', (ti + 1), '处理失败:', e.message);
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
    sentJobIds.add(_it.jobId);
    state.sendProgress.sent++;
    state.sendResults.push({
      jobId: _it.jobId,
      positionName: _it.positionName,
      companyName: _it.companyName,
      success: true,
      alreadyChatted: true,
      hrName: _it.hrName,
      time: Date.now(),
    });
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


  try { DiagLogger.info('sw.send', '阶段转换：stage1 → stage2 queueLen=' + state.sendQueueV6.length); } catch (_) {}
  state.sendPhase = 'stage2';
  state.sendProgress.total = state.sendQueueV6.length;
  await persistState();
  await runStage2();
  await teardownWorkerWindows(); // 先关 worker 窗口 → 补发在 0-worker 单连接安静环境跑
  await sleep(3000);             // 给服务器登记连接关闭、退出多连接 kick 状态的余量
  await runRepairV6();   // 补发阶段：全新单 tab、单 WS 连接，逐个核对并补漏
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
            sentJobIds.add(_s.jobId);
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
          console.warn('[即投] runStage1: BFCache/port closed, 重试 ' + (retryCount + 1) + '/5, 重新激活 tab');
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
        console.error('[即投] runStage1: sendMessage 最终失败', err.message);
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
    console.error('[即投] runStage2: chrome.alarms 不可用！请在 manifest.json permissions 添加 "alarms"');
  }
  var workerCount = Math.min(CONFIG.MAX_SEND_WORKERS, state.sendQueueV6.length);
  // ② 0-WS 起步防泄漏：上一批若有未关干净的 worker/补发窗口（cleanup 失败或异常），
  //    先强关，避免本批叠加旧 WS 连接。正常路径下 cleanupV6 已关，这里只是兜底。
  if (state._v6WorkerWindowIds && state._v6WorkerWindowIds.length) {
    for (var lw = 0; lw < state._v6WorkerWindowIds.length; lw++) {
      try { await chrome.windows.remove(state._v6WorkerWindowIds[lw]); } catch (e) {}
    }
  }
  state._v6WorkerTabIds = [];
  state._v6WorkerWindowIds = [];
  state._v6WorkerTabsReady.clear();
  state._v6RepairQueue = [];

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
        // 投递错位止血 #3：activate 失败（含兜底命中身份断言失败/无法核验）一律不发、不标成功，转补发。
        // findResp.success 已被 CS 端身份断言收口（fallback 未过即 success:false + identityAssertFailed），
        // 故 WORKER_SEND 不会发起、recordV6Success 不可能被触达 → 杜绝同名错投 + 误报成功。
        if (!findResp || !findResp.success) {
          await recordV6Failure(job, (findResp && findResp.error) || '未找到对话', findResp && findResp.identityAssertFailed ? 'identityAssert' : 'findConv');
          // 第一性校验：worker tab 未确认完整即入补发队列。storm 下 worker tab 的对话列表
          // 常加载失败（「对话列表容器未加载」），但进安静的补发 tab（单连接）往往能加载成功。
          // 补发 tab 仍找不到才真放弃（repairSingle 回 foundConv:false）。
          state._v6RepairQueue.push(job);
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
          // 第一性校验：内容未确认送达 → 入补发队列，补发阶段单连接重试。
          state._v6RepairQueue.push(job);
        }
      } catch(e) {
        await recordV6Failure(job, 'Worker通信失败: ' + e.message, 'worker_comm');
        // 第一性校验：通信失败＝未确认完整 → 入补发队列。
        state._v6RepairQueue.push(job);
      }

      if (state.phase === 'captcha_paused') break;
      await sleep(200); // ⏱️ 保留：循环节流避免极端高频
    }
  } finally {
    stopWorkerKeepalive(tabId);
  }

  // 不再自动关闭 worker tab，确保消息有充足时间发送完毕
}

// ── 补发阶段：用一个全新的沟通页（单 tab = 单 WS 连接，避开旧 worker tab 的滞后显示
//    与多连接风暴）逐个核对漏发的岗位，缺招呼语/图片就补。最多 2 轮收敛。──
async function runRepairV6() {
  if (state.phase !== 'sending') return;
  var queue = (state._v6RepairQueue || []).slice();
  if (!queue.length) {
    return;
  }

  // 开一个全新的后台沟通页
  var repairTabId = null, repairWinId = null;
  try {
    // 大尺寸（1280×800）跟 worker 窗形态一致，让用户感知到「补发还在跑、不是结束了」。
    // 仍 focused:false 不抢焦点；state:'normal' 不全屏（避免 minimized→hidden 致 WS 坏的反向问题）。
    var win = await chrome.windows.create({
      url: 'https://www.zhipin.com/web/geek/chat',
      focused: false, state: 'normal', width: 1280, height: 800,
    });
    if (win && win.id != null) {
      repairWinId = win.id;
      // 纳入追踪：runRepairV6 自己会在结尾关掉它；万一中途抛错没关，cleanupV6/stopSend 兜底关，
      // 不让补发窗口的 WS 泄漏到下一批。
      if (state._v6WorkerWindowIds) state._v6WorkerWindowIds.push(win.id);
    }
    if (win && win.tabs && win.tabs[0] && win.tabs[0].id != null) repairTabId = win.tabs[0].id;
  } catch (e) {
    try { await ErrorLogger.logError('[repair] 开补发tab失败: ' + (e && e.message), '', 'repair.diag'); } catch (e2) {}
  }
  if (repairTabId == null) return;

  // 等补发 tab CS 就绪（它也发 CS_READY role=worker，加入 _v6WorkerTabsReady）
  await new Promise(function (resolve) {
    var deadline = Date.now() + 15000;
    var check = function () {
      if (state._v6WorkerTabsReady.has(repairTabId)) return resolve();
      if (state.phase !== 'sending' || Date.now() > deadline) return resolve();
      setTimeout(check, 300);
    };
    setTimeout(check, 500);
  });

  // 串行补发，最多 2 轮收敛
  for (var pass = 0; pass < 2 && queue.length; pass++) {
    var still = [];
    for (var i = 0; i < queue.length; i++) {
      if (state.phase !== 'sending') break;
      var job = queue[i];
      var resp = null;
      try {
        resp = await chrome.tabs.sendMessage(repairTabId, { type: MSG.WORKER_REPAIR, job: job });
        // resp===undefined ≠ 通信失败（那会 throw）。是补发 tab 的 CS 收到了消息但没回 response，
        // 几乎一定是补发 tab 跑旧版本 CS（MSG.WORKER_REPAIR 未定义→case 不命中→未 return true）。
        // 显式标注，避免下次又看到裸 {complete:false} 不知所以。
        if (resp === undefined) {
          resp = { complete: false, foundConv: false, error: '补发tab无响应(疑似CS旧版本/未注入WORKER_REPAIR)' };
        }
      } catch (e) {
        resp = { complete: false, error: 'repair通信失败: ' + (e && e.message) };
      }
      await applyRepairResult(job, resp, pass + 1);
      // foundConv=false（对话没建起来）→ 补不了，不再重试；其余未补全的进下一轮
      if (!(resp && resp.complete) && !(resp && resp.foundConv === false)) {
        still.push(job);
      }
      await sleep(800); // 串行节流
    }
    queue = still;
  }

  state._v6RepairQueue = queue;
  // 关补发窗口，并从追踪数组移除（否则 cleanupV6 的 teardown 会对已关窗口空跑一次 1.5s）
  try { if (repairWinId != null) await chrome.windows.remove(repairWinId); } catch (e) {}
  try { if (repairTabId != null) await chrome.tabs.remove(repairTabId); } catch (e) {}
  if (repairWinId != null && state._v6WorkerWindowIds) {
    state._v6WorkerWindowIds = state._v6WorkerWindowIds.filter(function (id) { return id !== repairWinId; });
  }
  if (repairTabId != null) state._v6WorkerTabsReady.delete(repairTabId);
}

// 把补发结果回写到 sendResults：真补全了就把该岗位翻成成功（内容确实送达了，非显示规则改动）。
async function applyRepairResult(job, resp, pass) {
  var ok = !!(resp && resp.complete);
  var _found = false;
  for (var i = state.sendResults.length - 1; i >= 0; i--) {
    if (state.sendResults[i].jobId === job.jobId) {
      _found = true;
      sentJobIds.add(job.jobId); // 幂等：worker 失败路径本就已加；漏发补发路径靠这行防 SW 死后 resume 重建队列双发
      if (ok) incrementDailySendCount(job.jobId); // 投递数量闸门：补发翻成功才计（幂等 set 防与 recordV6Success 双记）
      state.sendResults[i].success = ok;
      state.sendResults[i].repaired = true;
      if (ok) {
        state.sendResults[i].error = null;
        state.sendResults[i].stage = null;
      } else {
        state.sendResults[i].error = (resp && resp.error) || state.sendResults[i].error || 'repair未补全';
      }
      break;
    }
  }
  // A1：恢复路径直入补发队列的漏发岗没有先行 sendResults 记录 → 补一条，确保 review 可见、不再算漏发
  if (!_found) {
    sentJobIds.add(job.jobId);
    state.sendProgress.sent++;
    if (ok) incrementDailySendCount(job.jobId); // 投递数量闸门：恢复路径补发翻成功也计（幂等）
    state.sendResults.push({
      jobId: job.jobId, positionName: job.positionName, companyName: job.companyName,
      success: ok, repaired: true, hrName: job.hrName,
      error: ok ? null : ((resp && resp.error) || 'repair未补全'),
      time: Date.now(),
    });
  }
  try {
    await ErrorLogger.logError('[repair:diag] ' + JSON.stringify({
      jobId: job.jobId, pass: pass, complete: ok,
      foundConv: resp && resp.foundConv, hadText: resp && resp.hadText, hadImage: resp && resp.hadImage,
      repairedText: resp && resp.repairedText, repairedImage: resp && resp.repairedImage,
      error: resp && resp.error,
    }), '', 'repair.diag');
  } catch (e) {}
  pushState();
}

// 关掉 stage2 的 3 个 worker 窗口（含关窗前 ws-probe 取证 + 在飞帧落地缓冲）。
// 抽出来在 runRepairV6 之前调用：补发阶段必须先关掉 worker 窗口，才是真正的
// 「单 tab = 单 WS 连接」安静环境；否则补发 tab 是第 4 个 WS、仍困在 storm 里（旧序补不动）。
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
  await teardownWorkerWindows(); // 幂等：runRepairV6 前已调过则此处 no-op，只兜底
  state._v6SearchReady = false;
  state.sendPhase = '';
  state.sendQueueV6 = [];
  state.sendQueueV6Index = 0;
  state._v6RepairQueue = [];
  state._v6CurrentBatchQueue = [];
  await persistState();
  await activateOriginalMainWindow();
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
  //    finalizeTask 内部会清 sendPhase、读 sendQueueV6/_v6RepairQueue 补记后再清空也无妨——
  //    故在 finalizeTask 之后再清队列。
  await finalizeTask('stopped');
  state.sendQueueV6 = [];
  state._v6CurrentBatchQueue = [];
  state.sendQueueV6Index = 0;
  state._v6RepairQueue = [];
  await persistState();
  await activateOriginalMainWindow();
}

// ── A1 一键补发（仅用户在 review 页主动触发，停止语义零改动）──
// 把 finalizeTask 算出的漏发清单（已建联 hrName 非空、却没发出 AI 招呼语+图的岗位）入
// _v6RepairQueue，走 runRepairV6 单 tab 单 WS 安静补发。repairSingle 先核对服务器消息历史
// 再缺啥补啥，天然防双发。进度/终态复用现有 phase=sending → review 机制。
async function startRepairMissed() {
  await bootRestored;        // 冷启动竞态防护：等 _v6MissedJobs/sendResults 等恢复完
  if (state.phase === 'sending') throw new Error('正在投递中，请稍后再试');
  var _seen = {};
  var missed = (state._v6MissedJobs || []).filter(function (it) {
    if (!it || it.jobId == null || !it.hrName || isGreetingMissing(it.greeting)) return false; // #36 保险丝：空/占位招呼语不补发
    if (_seen[it.jobId]) return false; // 幂等：按 jobId 去重
    _seen[it.jobId] = true;
    return true;
  });
  if (!missed.length) throw new Error('没有需要补发的岗位');
  try { DiagLogger.userEvent('sw.send', '用户点击「一键补发」missed=' + missed.length); } catch (_) {}
  sendAborted = false;          // 补发是新一段任务，清上一轮停止标记
  sendStartTime = Date.now();
  state._v6RepairQueue = missed;
  state._v6MissedJobs = [];     // 消费即清：连点按钮/重开 popup 不会重复入队
  state.phase = 'sending';
  state.sendPhase = 'stage2';   // 复用现有值域（runRepairV6 只看 phase；非 '' 以便 SW 冷启可走恢复兜底）
  state.sendProgress = { sent: 0, total: missed.length };
  pushState();
  await persistState();
  await runRepairV6();          // 内部 phase!=='sending' 即中断，停止按钮仍即时生效
  if (sendAborted) return;      // 补发中被停止：stopSend 已 finalizeTask 进终态，不重复收尾
  state.sendProgress = { sent: state.sendResults.length, total: state.sendResults.length };
  await finalizeTask('repair');
  await cleanupV6();
}

// ── 读取 API Key（从 storage 读取，首次启动由 ensureApiKey 预置） ──
async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || '';
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
              console.warn(`[即投][RACE] ${category} attempt=${attempt} LOSE ${raceElapsed}ms reason=${reason}`);
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

async function doRewriteGreeting(originalGreeting, instruction) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('请先在设置中配置 API Key');
  return rewriteGreeting(apiKey, originalGreeting, instruction);
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

