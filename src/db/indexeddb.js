// IndexedDB 封装 — 简历图片 + 设置 + 岗位记录存储
const DB_NAME = 'zitou';
const DB_VERSION = 2;
const HANDLED_JOB_STATUSES = ['selected', 'sent', 'alreadyChatted', 'skipped', 'failed', 'unsent'];
const JOB_STATUS_PRIORITY = {
  collected: 0,
  selected: 10,
  skipped: 20,
  failed: 20,
  unsent: 20,
  sent: 30,
  alreadyChatted: 30,
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('resumes')) {
        db.createObjectStore('resumes', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('jobRecords')) {
        db.createObjectStore('jobRecords', { keyPath: 'jobKey' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked, please close other extension pages and retry'));
  });
}

async function withStore(name, mode) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

async function withTransaction(name, mode, handler) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  return new Promise((resolve, reject) => {
    var settled = false;
    var result;
    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err || tx.error || new Error('IndexedDB transaction failed'));
    }
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('IndexedDB transaction aborted'));
    try {
      result = handler(store, tx);
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      fail(e);
    }
  });
}

// ── 简历图片 ──
async function saveResumeImages(files) {
  const store = await withStore('resumes', 'readwrite');
  await new Promise((resolve, reject) => {
    // 清空旧图片再存新的
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
      let count = 0;
      for (const file of files) {
        const addReq = store.add({ blob: file, name: file.name, time: Date.now() });
        addReq.onsuccess = () => { count++; if (count === files.length) resolve(); };
        addReq.onerror = () => reject(addReq.error);
      }
      if (files.length === 0) resolve();
    };
    clearReq.onerror = () => reject(clearReq.error);
  });
}

async function getResumeImages() {
  const store = await withStore('resumes', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 清空 IndexedDB 中保存的简历图片。
 */
async function clearResumeImages() {
  const store = await withStore('resumes', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── 设置 ──
async function saveSetting(key, value) {
  const store = await withStore('settings', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getSetting(key) {
  const store = await withStore('settings', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function saveSettings(obj) {
  const store = await withStore('settings', 'readwrite');
  return new Promise((resolve, reject) => {
    let count = 0;
    const entries = Object.entries(obj);
    if (entries.length === 0) resolve();
    for (const [key, value] of entries) {
      const req = store.put({ key, value });
      req.onsuccess = () => { count++; if (count === entries.length) resolve(); };
      req.onerror = () => reject(req.error);
    }
  });
}

/**
 * 生成稳定岗位主键，优先使用平台 ID，其次链接，最后用岗位核心信息派生。
 */
function buildJobKey(record) {
  if (!record || typeof record !== 'object') return '';
  var jobId = String(record.jobId || record.id || '').trim();
  if (jobId) return jobId;
  var jobLink = String(record.jobLink || record.link || record.url || '').trim();
  if (jobLink) return jobLink;
  var parts = [
    record.companyName || record.company || '',
    record.positionName || record.name || record.title || '',
    record.hrName || record.bossName || '',
    record.city || record.location || '',
  ].map(function (part) { return String(part || '').trim(); }).filter(Boolean);
  return parts.join('|');
}

/**
 * 将采集或投递结果统一成可持久化的岗位记录。
 */
function normalizeJobRecord(record) {
  if (!record || typeof record !== 'object') return null;
  var now = new Date().toISOString();
  var status = String(record.status || 'collected').trim() || 'collected';
  var jobKey = String(record.jobKey || buildJobKey(record)).trim();
  if (!jobKey) return null;
  var normalized = {
    jobKey: jobKey,
    jobId: String(record.jobId || record.id || '').trim(),
    jobLink: String(record.jobLink || record.link || record.url || '').trim(),
    positionName: String(record.positionName || record.name || record.title || '').trim(),
    companyName: String(record.companyName || record.company || '').trim(),
    hrName: String(record.hrName || record.bossName || '').trim(),
    city: String(record.city || record.location || '').trim(),
    salary: String(record.salary || '').trim(),
    status: status,
    source: String(record.source || '').trim(),
    error: String(record.error || '').trim(),
    firstCollectedAt: String(record.firstCollectedAt || record.createdAt || now),
    lastSeenAt: String(record.lastSeenAt || now),
    lastHandledAt: String(record.lastHandledAt || ''),
  };
  if (HANDLED_JOB_STATUSES.includes(normalized.status) && !normalized.lastHandledAt) {
    normalized.lastHandledAt = now;
  }
  return normalized;
}

function mergeJobRecord(existing, incoming) {
  if (!existing) return incoming;
  var merged = Object.assign({}, existing, incoming);
  merged.firstCollectedAt = existing.firstCollectedAt || incoming.firstCollectedAt;
  var existingPriority = JOB_STATUS_PRIORITY[existing.status] || 0;
  var incomingPriority = JOB_STATUS_PRIORITY[incoming.status] || 0;
  if (existing.status && existingPriority > incomingPriority) {
    merged.status = existing.status;
    merged.lastHandledAt = existing.lastHandledAt || incoming.lastHandledAt || '';
  }
  if (!incoming.lastHandledAt && existing.lastHandledAt) {
    merged.lastHandledAt = existing.lastHandledAt;
  }
  return merged;
}

/**
 * 批量保存岗位记录，重复岗位按 jobKey 合并，且不会把已处理状态降级回 collected。
 */
async function saveJobRecords(records) {
  var list = (Array.isArray(records) ? records : [records]).map(normalizeJobRecord).filter(Boolean);
  if (!list.length) return [];
  var saved = [];
  await withTransaction('jobRecords', 'readwrite', function(store) {
    var index = 0;
    function next() {
      if (index >= list.length) {
        return;
      }
      var incoming = list[index++];
      var getReq = store.get(incoming.jobKey);
      getReq.onerror = () => {};
      getReq.onsuccess = () => {
        var merged = mergeJobRecord(getReq.result, incoming);
        var putReq = store.put(merged);
        putReq.onerror = () => {};
        putReq.onsuccess = () => {
          saved.push(merged);
          next();
        };
      };
    }
    next();
    return saved;
  });
  return saved;
}

/**
 * 读取所有已持久化的岗位记录。
 */
async function getJobRecords() {
  const store = await withStore('jobRecords', 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 清空 IndexedDB 中保存的岗位记录。
 */
async function clearJobRecords() {
  const store = await withStore('jobRecords', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
