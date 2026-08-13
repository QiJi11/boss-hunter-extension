(function (global) {
  const OUTCOME_LABELS = Object.freeze({
    replied: '已回复',
    interview: '约面',
    notFit: '不合适',
    noResponse: '暂无回复',
  });
  const SCORE_BANDS = Object.freeze([
    { id: 'high', label: '75-100 分', min: 75 },
    { id: 'mid', label: '50-74 分', min: 50 },
    { id: 'low', label: '0-49 分', min: 0 },
    { id: 'unscored', label: '未评分', min: -Infinity },
  ]);
  const MAX_RECORDS = 120;

  function normalizeOutcome(outcome) {
    return Object.prototype.hasOwnProperty.call(OUTCOME_LABELS, outcome) ? outcome : '';
  }

  function normalizeJobId(jobId) {
    return String(jobId || '').trim().slice(0, 160);
  }

  function normalizeScoreBand(scoreBand) {
    return SCORE_BANDS.some(function (band) { return band.id === scoreBand; })
      ? scoreBand
      : 'unscored';
  }

  function normalizeRecordedAt(recordedAt) {
    var value = Number(recordedAt);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  function scoreBandFor(score) {
    var value = Number(score);
    if (!Number.isFinite(value)) return 'unscored';
    for (var i = 0; i < SCORE_BANDS.length; i++) {
      if (value >= SCORE_BANDS[i].min) return SCORE_BANDS[i].id;
    }
    return 'unscored';
  }

  function normalizeRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    var jobId = normalizeJobId(record.jobId);
    var outcome = normalizeOutcome(record.outcome);
    var recordedAt = normalizeRecordedAt(record.recordedAt);
    if (!jobId || !outcome || recordedAt === null) return null;
    return {
      jobId: jobId,
      outcome: outcome,
      scoreBand: normalizeScoreBand(record.scoreBand),
      recordedAt: recordedAt,
    };
  }

  function normalizeRecords(records) {
    var byJobId = Object.create(null);
    (Array.isArray(records) ? records : []).forEach(function (record) {
      var normalized = normalizeRecord(record);
      if (!normalized) return;
      var current = byJobId[normalized.jobId];
      if (!current || normalized.recordedAt >= current.recordedAt) {
        byJobId[normalized.jobId] = normalized;
      }
    });
    return Object.keys(byJobId)
      .map(function (jobId) { return byJobId[jobId]; })
      .sort(function (left, right) { return right.recordedAt - left.recordedAt; })
      .slice(0, MAX_RECORDS);
  }

  function createRecord(input) {
    var jobId = normalizeJobId(input && input.jobId);
    var outcome = normalizeOutcome(input && input.outcome);
    if (!jobId || !outcome) return null;
    return {
      jobId: jobId,
      outcome: outcome,
      scoreBand: scoreBandFor(input && input.score),
      recordedAt: Date.now(),
    };
  }

  function upsertRecord(records, input) {
    var record = normalizeRecord(input);
    if (!record) return normalizeRecords(records);
    var remaining = removeRecord(records, record.jobId);
    return [record].concat(remaining).slice(0, MAX_RECORDS);
  }

  function removeRecord(records, jobId) {
    var normalizedJobId = normalizeJobId(jobId);
    return normalizeRecords(records).filter(function (current) {
      return current.jobId !== normalizedJobId;
    });
  }

  function recordsByJobId(records, jobIds) {
    var wanted = Object.create(null);
    (Array.isArray(jobIds) ? jobIds : []).forEach(function (jobId) {
      var normalized = normalizeJobId(jobId);
      if (normalized) wanted[normalized] = true;
    });
    var output = Object.create(null);
    normalizeRecords(records).forEach(function (record) {
      if (wanted[record.jobId]) output[record.jobId] = record;
    });
    return output;
  }

  function emptyOutcomeCounts() {
    return {
      replied: 0,
      interview: 0,
      notFit: 0,
      noResponse: 0,
    };
  }

  function buildSummary(records) {
    var normalized = normalizeRecords(records);
    var scoreBands = {};
    SCORE_BANDS.forEach(function (band) {
      scoreBands[band.id] = {
        id: band.id,
        label: band.label,
        total: 0,
        outcomes: emptyOutcomeCounts(),
      };
    });
    var outcomes = emptyOutcomeCounts();
    normalized.forEach(function (record) {
      outcomes[record.outcome] += 1;
      var band = scoreBands[record.scoreBand] || scoreBands.unscored;
      band.total += 1;
      band.outcomes[record.outcome] += 1;
    });
    return {
      total: normalized.length,
      outcomes: outcomes,
      scoreBands: SCORE_BANDS.map(function (band) { return scoreBands[band.id]; }),
    };
  }

  function buildPromptContext(records) {
    var summary = buildSummary(records);
    if (!summary.total) return '';
    var lines = [
      '[本机人工反馈校准摘要]',
      '以下仅来自用户手动选择的结果标签；不包含公司、HR、聊天内容、简历、姓名、岗位文本或自由备注。',
      '总样本 ' + summary.total
        + ' 条：已回复 ' + summary.outcomes.replied
        + '，约面 ' + summary.outcomes.interview
        + '，不合适 ' + summary.outcomes.notFit
        + '，暂无回复 ' + summary.outcomes.noResponse + '。',
    ];
    summary.scoreBands.forEach(function (band) {
      if (!band.total) return;
      lines.push(
        band.label + '：' + band.total
          + ' 条（已回复 ' + band.outcomes.replied
          + '，约面 ' + band.outcomes.interview
          + '，不合适 ' + band.outcomes.notFit
          + '，暂无回复 ' + band.outcomes.noResponse + '）。'
      );
    });
    lines.push('样本少于 5 条时只作弱信号；不要覆盖岗位正文、硬性排除规则或人工判断。');
    return lines.join('\n');
  }


  // ── 1.4.0 M6: 基于 jobRecords 的回复/约面分层指标 ──
  // 输入：jobRecords 数组（含 deliveredAt/repliedAt/interviewAt/status/companyName/city/frozenPrediction/greetingVariant）
  // 只统计 delivered 记录；样本 <5 时返回空（不显示伪精确概率）
  var METRICS_MIN_SAMPLE = 5;

  function _num(ts) { var n = Number(ts); return Number.isFinite(n) && n > 0 ? n : 0; }
  function _ts(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function buildResponseMetrics(records) {
    var list = (Array.isArray(records) ? records : []).filter(function(r) {
      return r && r.status === 'delivered' && _ts(r.deliveredAt) > 0;
    });
    var out = { total: list.length, sampleOk: list.length >= METRICS_MIN_SAMPLE, metrics: null, byScoreBand: {}, byCity: {}, byGreeting: {} };

    function bucket(add, rec) {
      var deliveredMs = _ts(rec.deliveredAt);
      var repliedMs = _ts(rec.repliedAt) || _ts(rec.viewedAt) || 0;
      var interviewMs = _ts(rec.interviewAt) || 0;
      var repliedIn7 = repliedMs > 0 && (repliedMs - deliveredMs) <= 7 * 86400000;
      var interviewIn14 = interviewMs > 0 && (interviewMs - deliveredMs) <= 14 * 86400000;
      add.total++;
      if (repliedMs > 0) add.replied++;
      if (repliedIn7) add.replied7d++;
      if (interviewMs > 0) add.interview++;
      if (interviewIn14) add.interview14d++;
    }
    function pct(part, total) { return total ? Math.round(part / total * 1000) / 10 : 0; }
    function finalize(add) {
      return {
        n: add.total,
        replied7dPct: pct(add.replied7d, add.total),
        interview14dPct: pct(add.interview14d, add.total),
        repliedPct: pct(add.replied, add.total),
        interviewPct: pct(add.interview, add.total),
      };
    }
    if (list.length >= METRICS_MIN_SAMPLE) {
      var m = { total: 0, replied: 0, replied7d: 0, interview: 0, interview14d: 0 };
      list.forEach(function(r) { bucket(m, r); });
      out.metrics = finalize(m);
      // 评分档位
      var byBand = {};
      list.forEach(function(r) {
        var fp = (r.frozenPrediction && (r.frozenPrediction.applyScore !== undefined ? r.frozenPrediction.applyScore : r.frozenPrediction.score)) || 0;
        var band = fp >= 75 ? 'high' : (fp >= 60 ? 'mid' : 'low');
        byBand[band] = byBand[band] || { total: 0, replied: 0, replied7d: 0, interview: 0, interview14d: 0 };
        bucket(byBand[band], r);
      });
      Object.keys(byBand).forEach(function(k) { out.byScoreBand[k] = finalize(byBand[k]); });
      // 城市
      var byCity = {};
      list.forEach(function(r) {
        var city = String(r.city || '').trim() || '未知';
        byCity[city] = byCity[city] || { total: 0, replied: 0, replied7d: 0, interview: 0, interview14d: 0 };
        bucket(byCity[city], r);
      });
      Object.keys(byCity).forEach(function(k) { out.byCity[k] = finalize(byCity[k]); });
      // 招呼语版本
      var byGreet = {};
      list.forEach(function(r) {
        var v = String(r.greetingVariant || '').trim() || 'unknown';
        byGreet[v] = byGreet[v] || { total: 0, replied: 0, replied7d: 0, interview: 0, interview14d: 0 };
        bucket(byGreet[v], r);
      });
      Object.keys(byGreet).forEach(function(k) { out.byGreeting[k] = finalize(byGreet[k]); });
    }
    return out;
  }

  global.JobOutcomeFeedback = Object.freeze({

    OUTCOME_LABELS: OUTCOME_LABELS,
    MAX_RECORDS: MAX_RECORDS,
    normalizeRecords: normalizeRecords,
    createRecord: createRecord,
    upsertRecord: upsertRecord,
    removeRecord: removeRecord,
    recordsByJobId: recordsByJobId,
    buildSummary: buildSummary,
    buildPromptContext: buildPromptContext,
    buildResponseMetrics: buildResponseMetrics,
  });
})(globalThis);
