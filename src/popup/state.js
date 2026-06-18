// ════════════════════════════════════════════════════════════
// 即投 — 全局状态 Store
// API: get / set / getSnapshot / restore
// ════════════════════════════════════════════════════════════

(function () {
  var _state = {
    mode: 'settings',
    city: { name: '', code: '' },
    selectedCities: [],
    resumeImages: [],
    selectedPositions: [],
    customPositions: [],
    hrActiveFilter: '不限',
    posSearchQuery: '',
    selectedIndustries: [],
    indSearchQuery: '',
    showAllIndustries: false,
    workAreas: ['不限'],
    jobTypes: ['不限'],
    salaryRanges: ['不限'],
    aiSalaryRange: { minK: '', maxK: '', mode: 'loose' },
    experience: ['不限'],
    education: ['不限'],
    companySizes: ['不限'],
    fundingStages: ['不限'],
    excludeKeywords: typeof DEFAULT_EXCLUDE_KEYWORDS !== 'undefined' ? DEFAULT_EXCLUDE_KEYWORDS.slice() : [],
    skipHistoryEnabled: true,
    skipHistoryScope: 'hr',
    cityOpen: false,
    progressDone: false,
    collecting: false,
    jobs: [],
    sending: false,
    groups: [],
    greetings: {},
    jobCustom: {},
    groupExpanded: {},
    sendGreeting: true,
    filterSuggestionDraft: null,
    aiBatchOverview: null,
    aiOverviewSummary: null,
    collectionSummary: null,
    jdHydrationProgress: {
      running: false,
      done: 0,
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      completedBatches: 0,
      stalledBatches: 0,
    },
  };

  // Backward-compatible alias (existing code uses S.xxx directly)
  window.S = _state;

  window.Store = {
    /** 读单个或全部（无参返回全部） */
    get: function (key) {
      return key === undefined ? _state : _state[key];
    },

    /** 写（开发模式有 schema 校验） */
    set: function (key, value) {
      _state[key] = value;
      // 自动持久化 ui: 前缀的状态
      persistUIState();
    },

    /** 深克隆，用于 SW 同步 */
    getSnapshot: function () {
      return JSON.parse(JSON.stringify(_state));
    },

    /** 恢复（popup 重开用），完全替换内部状态 */
    restore: function (snapshot) {
      var defaults = JSON.parse(JSON.stringify(_state));
      var copy = Object.assign(defaults, JSON.parse(JSON.stringify(snapshot || {})));
      if (typeof normalizeSalaryFilterPair === 'function') {
        var salaryPair = normalizeSalaryFilterPair(copy.salaryRanges, copy.aiSalaryRange);
        copy.salaryRanges = salaryPair.salaryRanges;
        copy.aiSalaryRange = salaryPair.aiSalaryRange;
      } else {
        copy.aiSalaryRange = typeof normalizeAiSalaryRange === 'function'
          ? normalizeAiSalaryRange(copy.aiSalaryRange)
          : (copy.aiSalaryRange || { minK: '', maxK: '', mode: 'loose' });
      }
      var keys = Object.keys(_state);
      for (var i = 0; i < keys.length; i++) delete _state[keys[i]];
      var ckeys = Object.keys(copy);
      for (var i = 0; i < ckeys.length; i++) {
        _state[ckeys[i]] = copy[ckeys[i]];
      }
    },
  };
})();

// UI 状态自动持久化（Store.set 触发，300ms 防抖）
var _persistTimer = null;
function persistUIState() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  if (typeof STORAGE_KEYS === 'undefined') return;
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(function () {
    try {
      var state = window.S || {};
      var save = {};
      if (state.groupExpanded) {
        save[STORAGE_KEYS.UI.GROUP_EXPANDED] = state.groupExpanded;
      }
      if (state.jobCustom) {
        save[STORAGE_KEYS.UI.JOB_CUSTOM] = state.jobCustom;
      }
      chrome.storage.local.set(save);
    } catch (e) {}
  }, 300);
}
