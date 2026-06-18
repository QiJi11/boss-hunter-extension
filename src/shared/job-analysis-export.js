(function (global) {
  const DEFAULT_RANGE = 'last7';
  const STATUS_KEYS = ['collected', 'selected', 'sent', 'alreadyChatted', 'skipped', 'failed', 'unsent'];

  /**
   * 根据岗位记录的处理、最近出现或首次采集时间，返回用于时间筛选的时间戳。
   */
  function getJobRecordTime(record) {
    const candidates = [record && record.lastHandledAt, record && record.lastSeenAt, record && record.firstCollectedAt];
    for (let i = 0; i < candidates.length; i++) {
      const ts = Date.parse(candidates[i]);
      if (!Number.isNaN(ts)) return ts;
    }
    return 0;
  }

  /**
   * 计算岗位分析导出的时间范围。
   */
  function resolveJobAnalysisRange(options) {
    const now = options && options.now ? new Date(options.now) : new Date();
    const type = (options && options.type) || DEFAULT_RANGE;
    const end = endOfDay(options && options.endDate ? parseDateInput(options.endDate) : now);
    let start = null;

    if (type === 'today') {
      start = startOfDay(now);
    } else if (type === 'last30') {
      start = startOfDay(addDays(now, -29));
    } else if (type === 'all') {
      start = null;
    } else if (type === 'custom') {
      start = options && options.startDate ? startOfDay(parseDateInput(options.startDate)) : null;
    } else {
      start = startOfDay(addDays(now, -6));
    }

    return {
      type: type,
      startDate: start ? formatDateInput(start) : '',
      endDate: type === 'all' ? '' : formatDateInput(end),
      startTs: start ? start.getTime() : 0,
      endTs: type === 'all' ? Number.MAX_SAFE_INTEGER : end.getTime(),
    };
  }

  /**
   * 按时间范围过滤岗位记录。
   */
  function filterJobRecordsByRange(records, rangeOptions) {
    const range = resolveJobAnalysisRange(rangeOptions || {});
    return (Array.isArray(records) ? records : []).filter((record) => {
      const ts = getJobRecordTime(record);
      if (!ts) return range.type === 'all';
      return ts >= range.startTs && ts <= range.endTs;
    });
  }

  /**
   * 汇总岗位记录状态分布。
   */
  function summarizeJobRecords(records) {
    const summary = {
      total: 0,
      collected: 0,
      selected: 0,
      sent: 0,
      alreadyChatted: 0,
      skipped: 0,
      failed: 0,
      unsent: 0,
    };
    (Array.isArray(records) ? records : []).forEach((record) => {
      const status = String(record && record.status || 'collected');
      summary.total++;
      if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status]++;
    });
    return summary;
  }

  /**
   * 构建岗位分析导出 JSON 对象。
   */
  function buildJobAnalysisExport(records, options) {
    const range = resolveJobAnalysisRange(options || {});
    const filtered = filterJobRecordsByRange(records, range);
    const aiBatchOverview = options && options.aiBatchOverview ? options.aiBatchOverview : null;
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      range: {
        type: range.type,
        startDate: range.startDate || null,
        endDate: range.endDate || null,
      },
      summary: summarizeJobRecords(filtered),
      records: filtered,
      aiBatchOverview: aiBatchOverview,
    };
  }

  /**
   * 校验岗位分析导入 JSON，并返回可写入 IndexedDB 的岗位记录。
   */
  function normalizeJobAnalysisImportPayload(raw) {
    if (Array.isArray(raw)) {
      return normalizeImportedRecords(raw);
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error('岗位分析导入文件必须是对象');
    }
    if (!Array.isArray(raw.records)) {
      throw new Error('岗位分析导入文件缺少 records 数组');
    }
    return normalizeImportedRecords(raw.records);
  }

  /**
   * 下载岗位分析导出文件。
   */
  function downloadJobAnalysisExport(payload) {
    const range = payload && payload.range || {};
    const nameRange = range.type === 'all'
      ? 'all-' + timestampForFilename(new Date())
      : (compactDate(range.startDate) || 'start') + '-' + (compactDate(range.endDate) || 'end');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'boss-hunter-job-analysis-' + nameRange + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function normalizeImportedRecords(records) {
    return records.map((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('岗位记录格式错误');
      }
      const copy = Object.assign({}, record);
      if (!copy.jobId && !copy.jobLink && !(copy.companyName && copy.positionName)) {
        throw new Error('岗位记录缺少 jobId、jobLink 或公司岗位信息');
      }
      if (copy.status && STATUS_KEYS.indexOf(copy.status) < 0) {
        throw new Error('岗位记录状态不支持: ' + copy.status);
      }
      return copy;
    });
  }

  function parseDateInput(value) {
    if (typeof value === 'string') {
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
    const date = value instanceof Date ? value : new Date(String(value || ''));
    if (Number.isNaN(date.getTime())) return new Date();
    return date;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  }

  function endOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatDateInput(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  function compactDate(value) {
    return String(value || '').replace(/-/g, '');
  }

  function timestampForFilename(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + pad(date.getHours()) + pad(date.getMinutes());
  }

  global.JobAnalysisExport = {
    DEFAULT_RANGE,
    STATUS_KEYS,
    getJobRecordTime,
    resolveJobAnalysisRange,
    filterJobRecordsByRange,
    summarizeJobRecords,
    buildJobAnalysisExport,
    normalizeJobAnalysisImportPayload,
    downloadJobAnalysisExport,
  };
})(window);
