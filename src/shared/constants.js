// ════════════════════════════════════════════════════════════
// 猎职 — 统一常量（单一真相源）
// ════════════════════════════════════════════════════════════

// ── 消息类型常量（popup ↔ background ↔ content） ──
const MSG = {
  // Popup → SW
  GET_STATE: 'GET_STATE',
  SAVE_MUTABLE_STATE: 'SAVE_MUTABLE_STATE',
  START_COLLECT: 'START_COLLECT',
  STOP_COLLECT: 'STOP_COLLECT',
  START_SEND: 'START_SEND',
  STOP_SEND: 'STOP_SEND',
  REGENERATE_GREETING: 'REGENERATE_GREETING',
  UPDATE_GREETING: 'UPDATE_GREETING',
  REWRITE_GREETING: 'REWRITE_GREETING',
  GET_API_KEY: 'GET_API_KEY',
  SAVE_API_KEY: 'SAVE_API_KEY',
  GET_AI_CONFIG: 'GET_AI_CONFIG',
  SAVE_AI_CONFIG: 'SAVE_AI_CONFIG',
  TEST_AI_CONFIG: 'TEST_AI_CONFIG',
  GENERATE_FILTER_SUGGESTION: 'GENERATE_FILTER_SUGGESTION',
  RETRY_JOB_DETAILS: 'RETRY_JOB_DETAILS',
  REPAIR_MISSED: 'REPAIR_MISSED',   // A1：review 页「一键补发」漏发岗位（popup→SW 专用，CS 不用，无需镜像 selectors.js）

  // SW → Popup
  STATE_UPDATE: 'STATE_UPDATE',
  ERROR: 'ERROR',

  // Content → SW
  JOBS_COLLECTED: 'JOBS_COLLECTED',
  COLLECT_PROGRESS: 'COLLECT_PROGRESS',
  COLLECT_CITY_PROGRESS: 'COLLECT_CITY_PROGRESS',
  SEND_PROGRESS: 'SEND_PROGRESS',
  SEND_ITEM_RESULT: 'SEND_ITEM_RESULT',
  SEND_COMPLETE: 'SEND_COMPLETE',
  CHAT_DETECTED: 'CHAT_DETECTED',
  AUTO_REPLY_SENT: 'AUTO_REPLY_SENT',
  JD_FETCHED: 'JD_FETCHED',
  FETCH_JOB_DETAIL: 'FETCH_JOB_DETAIL',
  PONG: 'PONG',

  // SW → Content
  DO_COLLECT: 'DO_COLLECT',
  DO_SEND: 'DO_SEND',
  DO_STOP: 'DO_STOP',
  PING: 'PING',

  // v5 发送架构
  DO_START_CHAT: 'DO_START_CHAT',       // v5: SW -> CS(搜索页): 启动聊天流程
  DO_SEND_CHAT: 'DO_SEND_CHAT',         // v5: SW -> CS(聊天页): 发送消息
  CS_READY: 'CS_READY',                 // CS -> SW: CS 注入完成，就绪信号

  // v6 发送架构
  WORKER_ACTIVATE: 'WORKER_ACTIVATE',
  QUEUE_EMPTY: 'QUEUE_EMPTY',
  DO_BATCH_EXTRACT: 'DO_BATCH_EXTRACT',
  EXTRACT_PROGRESS: 'EXTRACT_PROGRESS',
  EXTRACT_COMPLETE: 'EXTRACT_COMPLETE',
  WORKER_SEND: 'WORKER_SEND',
  WORKER_RESULT: 'WORKER_RESULT',
  WORKER_REPAIR: 'WORKER_REPAIR',       // SW -> 补发 tab: 重进对话核对历史、缺啥补啥

  // #39 阶段1跳转恢复：同 HR 新岗位点立即沟通后 BOSS 整页跳 /web/geek/chat，确认弹窗弹在消息页
  CONFIRM_CHANGE_JOB_DIALOG: 'CONFIRM_CHANGE_JOB_DIALOG', // SW -> 消息页 CS: 点「沟通新职位」确认钮，响应 {clicked, reason}（🔴 必须镜像 selectors.js）

  // CAPTCHA
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',

  // 招呼语开关 pre-flight（陷阱 #31：BOSS「自动打招呼」开关关闭 → 点立即沟通整页跳转 → stage1 卡死）
  CHECK_GREETING_SETTING: 'CHECK_GREETING_SETTING',   // SW -> CS(搜索页): 读 getGreetingList，返回 {success, enabled, templateId}（🔴 必须镜像 selectors.js）
  ENABLE_GREETING_SETTING: 'ENABLE_GREETING_SETTING', // SW -> CS(搜索页): updateGreetingV2 写开+复读自检，返回 {ok, enabled}（🔴 必须镜像 selectors.js）
  GREETING_AUTO_ENABLED: 'GREETING_AUTO_ENABLED',     // SW -> Popup: 已自动开启打招呼开关的非阻断提示（CS 不用，无需镜像 selectors.js）
  GET_DAILY_SEND_COUNT: 'GET_DAILY_SEND_COUNT',       // Popup -> SW: 读当天（本地自然日）已成功投递岗位数，投递前 gate 用（CS 不用，无需镜像 selectors.js）
};

// ── Storage key 白名单（sw:/ui: 前缀隔离） ──
const STORAGE_KEYS = {
  // Service Worker 持久化（sw: 前缀）
  SW: {
    STATE: 'sw:state',
    API_KEY: 'sw:apiKey',
    AI_CONFIG: 'sw:aiConfig',
    TEXT_RESUME: 'sw:textResume',
    PHASE: 'sw:phase',
    JOBS: 'sw:jobs',
    GREETINGS: 'sw:greetings',
    SEND_PROGRESS: 'sw:sendProgress',
    SENT_JOB_IDS: 'sw:sentJobIds',
    SEND_RESULTS: 'sw:sendResults',
    SEND_DURATION: 'sw:sendDuration',
    SEARCH_URL: 'sw:searchUrl',
    PENDING_GREETING: 'sw:pendingGreeting',
    PENDING_JOB_ID: 'sw:pendingJobId',
    SEND_QUEUE_V6: 'sw:sendQueueV6',
    SEND_QUEUE_INDEX: 'sw:sendQueueIndex',
    SEND_PHASE: 'sw:sendPhase',
    SELECTED_POSITIONS: 'sw:selectedPositions',
    CUSTOM_POSITIONS: 'sw:customPositions',
    MISSED_JOBS: 'sw:missedJobs',
    DAILY_SEND_COUNT: 'sw:dailySendCount',  // 投递数量闸门：{date:'YYYY-MM-DD', count:N}，本地自然日成功投递岗位数，跨日归零
    LAST_SNAPSHOT: 'sw:lastSnapshot',       // 诊断旁路：每次 persistState 落盘的内存态快照摘要（脱敏），SW 卸载后导出仍有基本完整快照
  },
  // 诊断滚动持久化（diag: 前缀）—— 与 SW 内存态解耦，新任务清内存也不丢
  DIAG: {
    RECENT_RUNS: 'diag:recentRuns',         // ring buffer：最近 5 次投递任务结束时的完整诊断摘要（含时间戳/sendResults/snapshot）
  },
  // UI / Popup 持久化（ui: 前缀）
  UI: {
    LAST_CITY: 'ui:lastCity',
    FILTER_STATE: 'ui:filterState',
    GROUP_EXPANDED: 'ui:groupExpanded',
    JOB_CUSTOM: 'ui:jobCustom',
  },
};

// ── 全局配置参数 ──
const CONFIG = {
  // 每组分组的最大岗位数
  MAX_JOBS_PER_GROUP: 6,
  // AI 招呼语生成超时（ms）
  GREETING_TIMEOUT_MS: 8000,
  // AI 招呼语并发数
  GREETING_CONCURRENCY: 3,
  // JD 自动补拉单批岗位数
  JD_HYDRATION_BATCH_SIZE: 12,
  // JD 自动补拉并发数
  JD_HYDRATION_CONCURRENCY: 2,
  // 连续无新增成功的批次数，达到后自动暂停补拉
  JD_HYDRATION_STALL_LIMIT: 2,
  // 采集/发送批处理大小
  BATCH_SIZE: 50,
  // 发送间隔下限（ms）
  SEND_INTERVAL_MIN_MS: 2000,
  // 发送间隔上限（ms）
  SEND_INTERVAL_MAX_MS: 4000,
  // 批次间休息时间（ms）
  BATCH_REST_MS: 90000,
  // 最大采集标签页数
  MAX_COLLECT_TABS: 2,
  // 简历图片最大数量
  RESUME_MAX_COUNT: 10,
  // 简历缩略图宽度（px）
  RESUME_THUMB_WIDTH: 200,
  // v6 并行发送架构
  MAX_SEND_WORKERS: 3, // 并行发送 worker 数（每个 worker 跑在独立后台窗口，避免 hidden tab WS 风暴）
  EXTRACT_CARD_DELAY_MS: 1500,
  CONVERSATION_POLL_MS: 500,
  CONVERSATION_TIMEOUT_MS: 6000,
  POST_EXTRACT_DELAY_MS: 3000,
  // 后台 tab 节流下的填字/确认等待（>=600ms 给 BOSS Vue 重渲染 btn-send 状态）
  FILL_SETTLE_MS: 700,
  // 图片上传 XHR 超时（loadend 不到时兜底）
  IMG_UPLOAD_TIMEOUT_MS: 15000,
  // SW → worker tab keepalive 心跳间隔（chrome.alarms 最低 30s）
  KEEPALIVE_PERIOD_MIN: 0.5,
  // 投递数量闸门
  DAILY_SEND_LIMIT: 150,   // 日累积上限（本地自然日）：当天成功投递岗位数超过即硬拦
  SOFT_BATCH_LIMIT: 75,    // 单批软提示阈值：单批选中 > 75 时提示但允许继续
};

const DEFAULT_EXCLUDE_KEYWORDS = [
  '外包',
  '驻场',
  '培训',
  '推广',
  '销售',
  '主播',
  '客服',
  '讲师',
  '剪辑',
  '游戏前端',
  '伪AI',
  '包装AI应用开发',
];

function uniqueStrings(list) {
  var seen = {};
  return (Array.isArray(list) ? list : []).map(function(item) {
    return String(item || '').trim();
  }).filter(function(item) {
    if (!item || seen[item]) return false;
    seen[item] = true;
    return true;
  });
}

function normalizeFilterStateDefaults(filterState) {
  var raw = filterState && typeof filterState === 'object' ? filterState : {};
  return Object.assign({}, raw, {
    excludeKeywords: uniqueStrings(
      Array.isArray(raw.excludeKeywords) ? raw.excludeKeywords : DEFAULT_EXCLUDE_KEYWORDS
    ),
    skipHistoryEnabled: raw.skipHistoryEnabled !== false,
    skipHistoryScope: 'hr',
  });
}

function findExcludeKeywordHit(job, excludeKeywords) {
  var keywords = uniqueStrings(excludeKeywords);
  if (!keywords.length || !job) return '';
  var haystack = [
    job.name,
    job.title,
    job.positionName,
    job.company,
    job.companyName,
    job.salary,
    Array.isArray(job.tags) ? job.tags.join(' ') : '',
    job.detail,
    job.desc,
    job.description,
    job.aiScreen && job.aiScreen.reason,
    job.aiScreen && Array.isArray(job.aiScreen.risks) ? job.aiScreen.risks.join(' ') : '',
  ].map(function(part) {
    return String(part || '').toLowerCase();
  }).join(' ');
  for (var i = 0; i < keywords.length; i++) {
    var kw = keywords[i];
    if (kw && haystack.indexOf(kw.toLowerCase()) >= 0) return kw;
  }
  return '';
}

// ── 岗位归类：单一真相源（分来源打分） ──
// 一个 job 该归到哪个期望词组的唯一判定。SW（采集过滤 / 发送分组 / cluster）
// 与 popup（B 页 prepareGroups）都调它，保证「编辑 key === 发送 key」、归组结果一致。
// 病根修复：历史上三套不同打分（采集 50% / 发送 60% / 分组无重叠分支）导致编辑组≠发送组、落「其他」。
//
// 分来源：picker 严格（不用字符重叠，避免「AI产品经理」靠重叠把纯产品经理岗都带进来）；
//         custom 宽松（保留 50% 字符重叠，适配自由文本）。
//   picker 词：name===pos +10 / 分词(/[\s·/&]+/)后每 token 都 includes 岗位名 +5
//   custom 词：name===pos +10 / name 含 pos(>=2) +5 / else 字符重叠>=阈值 +3
//   两类都：tag===pos +8 / tag 与 pos 互含 +3
// 返回最佳期望词（bestScore>=3）；0 匹配的极端 fallback 才返回 '其他'。
const CHAR_OVERLAP_THRESHOLD = 0.5;
function matchJobToExpected(job, picker, custom) {
  var pickerArr = Array.isArray(picker) ? picker : [];
  var customArr = Array.isArray(custom) ? custom : [];
  if (!pickerArr.length && !customArr.length) return '其他';
  // BOSS 返回 name/tags 大小写不可控，比较前两侧 toLowerCase，但返回值用 original pos 保 key 一致
  var jobNameLc = ((job && job.name) || '').toLowerCase();
  var tags = (job && job.tags) || [];
  var bestPos = '其他', bestScore = 0;

  // custom（宽松）的 tag 打分：双向互含都给分
  function scoreTagsLoose(posLc) {
    var s = 0;
    for (var t = 0; t < tags.length; t++) {
      var tLc = (tags[t] || '').toLowerCase();
      if (tLc === posLc) s += 8;
      else if (tLc.indexOf(posLc) >= 0 || posLc.indexOf(tLc) >= 0) s += 3;
    }
    return s;
  }
  // picker（严格）的 tag 打分：仅 tag===pos(+8) 或 tag 完整含 pos(+3)。
  // 不给 pos 含 tag 片段的反向分 —— 否则「AI产品经理」会因 tag『产品』被纯产品经理岗误纳。
  function scoreTagsStrict(posLc) {
    var s = 0;
    for (var t = 0; t < tags.length; t++) {
      var tLc = (tags[t] || '').toLowerCase();
      if (tLc === posLc) s += 8;
      else if (tLc.indexOf(posLc) >= 0) s += 3;
    }
    return s;
  }

  // picker：严格，不用字符重叠。复用 filterJobsByExpected 原 picker 逻辑（分词全命中）
  for (var i = 0; i < pickerArr.length; i++) {
    var pos = pickerArr[i];
    var posLc = (pos || '').toLowerCase();
    var score = 0;
    if (jobNameLc === posLc) score += 10;
    else {
      var tokens = posLc.split(/[\s·/&]+/).filter(Boolean);
      if (tokens.length && tokens.every(function (k) { return jobNameLc.indexOf(k) >= 0; })) score += 5;
    }
    score += scoreTagsStrict(posLc);
    if (score > bestScore) { bestScore = score; bestPos = pos; }
  }

  // custom：宽松，保留 50% 字符重叠兜底
  for (var ci = 0; ci < customArr.length; ci++) {
    var cpos = customArr[ci];
    var cposLc = (cpos || '').toLowerCase();
    var cscore = 0;
    if (jobNameLc === cposLc) cscore += 10;
    else if (cposLc.length >= 2 && jobNameLc.indexOf(cposLc) >= 0) cscore += 5;
    else {
      // 区分性部分必须命中，按 custom 词是否含英文段分流：
      // ① 含英文段（如 flutter / flutter工程师）：英文是区分词，要求至少一个长度>=2 的
      //    英文段是岗位名子串。否则「后端工程师」会靠通用中文后缀「工程师」蹭进「flutter工程师」组，
      //    纯英文「flutter」也会靠单字母 l/u/t/e/r 重叠误纳无关英文岗位。
      // ② 纯中文（如 前端开发）：每字是语素，保留 50% 字符重叠兜底自由文本。
      var latinSegs = (cposLc.match(/[a-z0-9]+/g) || []).filter(function (s) { return s.length >= 2; });
      if (latinSegs.length) {
        if (latinSegs.some(function (s) { return jobNameLc.indexOf(s) >= 0; })) cscore += 3;
      } else {
        var chars = Array.from(new Set(cposLc.replace(/[^一-鿿]/g, '').split(''))).filter(Boolean);
        if (chars.length) {
          var hit = chars.filter(function (ch) { return jobNameLc.indexOf(ch) >= 0; }).length;
          if (hit / chars.length >= CHAR_OVERLAP_THRESHOLD) cscore += 3;
        }
      }
    }
    cscore += scoreTagsLoose(cposLc);
    if (cscore > bestScore) { bestScore = cscore; bestPos = cpos; }
  }

  return (bestPos !== '其他' && bestScore >= 3) ? bestPos : '其他';
}
