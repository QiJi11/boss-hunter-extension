const FILTER_STATE_KEY = 'ui:filterState';
const AI_CONFIG_KEY = 'sw:aiConfig';
const DEFAULT_AI_CONFIG = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4.1-mini',
  scoreThreshold: 60,
};

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const previewGrid = document.getElementById('previewGrid');
const providerInput = document.getElementById('provider');
const baseUrlInput = document.getElementById('baseUrl');
const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const scoreThresholdInput = document.getElementById('scoreThreshold');
const textResumeInput = document.getElementById('textResume');
const apiSectionToggle = document.getElementById('apiSectionToggle');
const apiSectionBody = document.getElementById('apiSectionBody');
const testAiBtn = document.getElementById('testAiBtn');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const importStatus = document.getElementById('importStatus');
const importPreviewCard = document.getElementById('importPreviewCard');
const importPreviewMeta = document.getElementById('importPreviewMeta');
const importPreviewSummary = document.getElementById('importPreviewSummary');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const cancelImportBtn = document.getElementById('cancelImportBtn');

let resumeImages = [];
let aiConfig = { ...DEFAULT_AI_CONFIG };
let textResume = '';
let pendingImportDraft = null;

/**
 * 初始化设置页。
 */
(async function init() {
  try {
    await hydratePageFromStorage();

    if (apiSectionToggle) {
      apiSectionToggle.addEventListener('click', () => {
        apiSectionBody.classList.toggle('open');
        apiSectionToggle.classList.toggle('open');
      });
    }

    bindEvents();
  } catch (e) {
    console.warn('Options init error:', e);
  }
})();

function bindEvents() {
  uploadZone.addEventListener('click', () => fileInput.click());

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  if (testAiBtn) {
    testAiBtn.addEventListener('click', () => {
      testAiBtn.disabled = true;
      setStatus('正在测试 AI 连接...', '');
      chrome.runtime.sendMessage({ type: 'TEST_AI_CONFIG', config: readAiConfigFromForm() }, (resp) => {
        testAiBtn.disabled = false;
        if (chrome.runtime.lastError || !resp || !resp.success) {
          setStatus('AI 连接失败: ' + ((resp && resp.error) || chrome.runtime.lastError?.message || '未知错误'), 'error');
          return;
        }
        setStatus('AI 连接成功', 'success');
      });
    });
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus('保存中...', '');

    try {
      const newAiConfig = readAiConfigFromForm();
      const newTextResume = textResumeInput ? textResumeInput.value.trim() : '';
      await applySnapshotToStorage({
        resumeImages: await serializeCurrentResumeImages(),
        textResume: newTextResume,
        aiConfig: newAiConfig,
      });

      aiConfig = newAiConfig;
      textResume = newTextResume;
      await hydratePageFromStorage();
      setStatus('已保存', 'success');
    } catch (e) {
      console.error('Save error:', e);
      setStatus('保存失败: ' + e.message, 'error');
    } finally {
      saveBtn.disabled = false;
      setTimeout(() => setStatus('', ''), 2500);
    }
  });

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      showImportStatus('正在导出配置...', '');
      try {
        const snapshot = await readBackupSnapshot();
        downloadBackup(snapshot);
        showImportStatus('配置已导出', 'success');
      } catch (e) {
        showImportStatus('导出失败: ' + e.message, 'error');
      } finally {
        exportBtn.disabled = false;
      }
    });
  }

  if (importBtn) {
    importBtn.addEventListener('click', () => importFileInput.click());
  }

  if (importFileInput) {
    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files && importFileInput.files[0];
      importFileInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        pendingImportDraft = normalizeImportPayload(parsed);
        renderImportPreview(pendingImportDraft);
        showImportStatus('导入文件解析成功，请确认覆盖。', 'success');
      } catch (e) {
        pendingImportDraft = null;
        hideImportPreview();
        showImportStatus('导入失败: ' + e.message, 'error');
      }
    });
  }

  if (confirmImportBtn) {
    confirmImportBtn.addEventListener('click', async () => {
      if (!pendingImportDraft) return;
      confirmImportBtn.disabled = true;
      cancelImportBtn.disabled = true;
      showImportStatus('正在写入导入配置...', '');
      try {
        await applySnapshotToStorage(pendingImportDraft);
        pendingImportDraft = null;
        hideImportPreview();
        await hydratePageFromStorage();
        showImportStatus('导入完成，当前页面已刷新为最新配置。', 'success');
      } catch (e) {
        showImportStatus('导入失败: ' + e.message, 'error');
      } finally {
        confirmImportBtn.disabled = false;
        cancelImportBtn.disabled = false;
      }
    });
  }

  if (cancelImportBtn) {
    cancelImportBtn.addEventListener('click', () => {
      pendingImportDraft = null;
      hideImportPreview();
      showImportStatus('已取消导入。', '');
    });
  }
}

/**
 * 从本地存储读取并刷新页面状态。
 */
async function hydratePageFromStorage() {
  const [storedImages, storedResumeData, storedConfig] = await Promise.all([
    getResumeImages().catch(() => []),
    chrome.storage.local.get(['resumeImages', 'apiKey', 'textResume', AI_CONFIG_KEY, FILTER_STATE_KEY]).catch(() => ({})),
    chrome.storage.local.get(['apiKey', 'textResume', AI_CONFIG_KEY]).catch(() => ({})),
  ]);

  aiConfig = Object.assign({}, DEFAULT_AI_CONFIG, storedConfig[AI_CONFIG_KEY] || {});
  if (storedConfig.apiKey && !aiConfig.apiKey) aiConfig.apiKey = storedConfig.apiKey;
  textResume = storedConfig.textResume || '';

  if (providerInput) providerInput.value = aiConfig.provider || DEFAULT_AI_CONFIG.provider;
  if (baseUrlInput) baseUrlInput.value = aiConfig.baseUrl || '';
  if (apiKeyInput) apiKeyInput.value = aiConfig.apiKey || '';
  if (modelInput) modelInput.value = aiConfig.model || '';
  if (scoreThresholdInput) scoreThresholdInput.value = aiConfig.scoreThreshold || DEFAULT_AI_CONFIG.scoreThreshold;
  if (textResumeInput) textResumeInput.value = textResume;

  if (storedResumeData.resumeImages?.length) {
    resumeImages = deserializeResumeImages(storedResumeData.resumeImages);
  } else if (storedImages?.length) {
    resumeImages = storedImages.map((item) => ({
      name: item.name,
      blob: item.blob || item.file || item,
    }));
  } else {
    resumeImages = [];
  }

  renderPreviews();
}

function addFiles(files) {
  const valid = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (!valid.length) return;
  resumeImages = [...resumeImages, ...valid].slice(0, 2);
  renderPreviews();
}

function removeImage(index) {
  resumeImages.splice(index, 1);
  renderPreviews();
}

function renderPreviews() {
  previewGrid.innerHTML = '';
  resumeImages.forEach((img, i) => {
    const file = toFileLike(img);
    const url = URL.createObjectURL(file.blob || file);
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `
      <img src="${url}" alt="简历图片 ${i + 1}">
      <button class="delete-btn" data-index="${i}" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    item.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      removeImage(i);
    });
    previewGrid.appendChild(item);
  });
}

function readAiConfigFromForm() {
  return {
    provider: providerInput ? providerInput.value.trim() : DEFAULT_AI_CONFIG.provider,
    baseUrl: baseUrlInput ? baseUrlInput.value.trim() : '',
    apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
    model: modelInput ? modelInput.value.trim() : '',
    scoreThreshold: scoreThresholdInput ? Number(scoreThresholdInput.value || DEFAULT_AI_CONFIG.scoreThreshold) : DEFAULT_AI_CONFIG.scoreThreshold,
  };
}

function setStatus(text, cls) {
  saveStatus.textContent = text;
  saveStatus.className = 'save-status ' + cls;
}

function showImportStatus(text, cls) {
  if (!importStatus) return;
  importStatus.textContent = text || '';
  importStatus.className = 'import-status' + (cls ? ' ' + cls : '');
  importStatus.classList.toggle('hidden', !text);
}

function hideImportPreview() {
  if (!importPreviewCard) return;
  importPreviewCard.classList.add('hidden');
  importPreviewMeta.textContent = '';
  importPreviewSummary.innerHTML = '';
}

function renderImportPreview(draft) {
  if (!draft || !importPreviewCard) return;
  importPreviewCard.classList.remove('hidden');
  importPreviewMeta.textContent = buildImportPreviewMeta(draft);
  importPreviewSummary.innerHTML = '';

  buildImportPreviewItems(draft).forEach((item) => {
    const node = document.createElement('div');
    node.className = 'import-preview-item';
    node.innerHTML = `
      <div class="import-preview-label">${item.label}</div>
      <div class="import-preview-value">${item.value}</div>
    `;
    importPreviewSummary.appendChild(node);
  });
}

/**
 * 读取当前完整备份快照。
 */
async function readBackupSnapshot() {
  const [storageItems, storedImages] = await Promise.all([
    chrome.storage.local.get(['resumeImages', 'apiKey', 'textResume', AI_CONFIG_KEY, FILTER_STATE_KEY]),
    getResumeImages().catch(() => []),
  ]);

  const images = Array.isArray(storageItems.resumeImages) && storageItems.resumeImages.length
    ? storageItems.resumeImages
    : await serializeResumeImagesFromIndexedDb(storedImages);

  const ai = Object.assign({}, DEFAULT_AI_CONFIG, storageItems[AI_CONFIG_KEY] || {});
  if (storageItems.apiKey && !ai.apiKey) ai.apiKey = storageItems.apiKey;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    filterState: storageItems[FILTER_STATE_KEY] || null,
    resumeImages: images.length ? images : null,
    textResume: typeof storageItems.textResume === 'string' ? storageItems.textResume : null,
    aiConfig: ai,
  };
}

function downloadBackup(snapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `boss-hunter-backup-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * 规范化导入 JSON，只保留合法分组。
 */
function normalizeImportPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('导入文件顶层必须是对象');
  }

  const draft = {
    version: typeof raw.version === 'number' ? raw.version : 1,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    filterState: undefined,
    resumeImages: undefined,
    textResume: undefined,
    aiConfig: undefined,
  };

  if (Object.prototype.hasOwnProperty.call(raw, 'filterState')) {
    if (raw.filterState !== null && typeof raw.filterState !== 'object') {
      throw new Error('filterState 类型错误');
    }
    draft.filterState = raw.filterState || null;
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'resumeImages')) {
    if (raw.resumeImages !== null && !Array.isArray(raw.resumeImages)) {
      throw new Error('resumeImages 类型错误');
    }
    draft.resumeImages = (raw.resumeImages || []).map(validateSerializedResumeImage);
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'textResume')) {
    if (raw.textResume !== null && typeof raw.textResume !== 'string') {
      throw new Error('textResume 类型错误');
    }
    draft.textResume = raw.textResume || '';
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'aiConfig')) {
    if (raw.aiConfig !== null && typeof raw.aiConfig !== 'object') {
      throw new Error('aiConfig 类型错误');
    }
    draft.aiConfig = normalizeAiConfig(raw.aiConfig || {});
  }

  if (
    draft.filterState === undefined &&
    draft.resumeImages === undefined &&
    draft.textResume === undefined &&
    draft.aiConfig === undefined
  ) {
    throw new Error('导入文件未包含可导入的分组');
  }

  return draft;
}

/**
 * 将导入结果统一写回 storage 和 IndexedDB。
 */
async function applySnapshotToStorage(draft) {
  const storagePatch = {};

  if (draft.resumeImages !== undefined) {
    storagePatch.resumeImages = draft.resumeImages;
  }
  if (draft.textResume !== undefined) {
    storagePatch.textResume = draft.textResume;
  }
  if (draft.aiConfig !== undefined) {
    storagePatch[AI_CONFIG_KEY] = draft.aiConfig;
    storagePatch.apiKey = draft.aiConfig.apiKey || '';
  }
  if (draft.filterState !== undefined) {
    storagePatch[FILTER_STATE_KEY] = draft.filterState;
  }

  if (Object.keys(storagePatch).length) {
    await chrome.storage.local.set(storagePatch);
  }

  if (draft.resumeImages !== undefined) {
    const fileLikes = await deserializeResumeImagesToFiles(draft.resumeImages);
    if (fileLikes.length) {
      await saveResumeImages(fileLikes);
    } else {
      await clearResumeImages();
    }
  }
}

async function serializeCurrentResumeImages() {
  return Promise.all(resumeImages.map(async (img) => serializeFileLike(toFileLike(img))));
}

async function serializeResumeImagesFromIndexedDb(items) {
  return Promise.all(
    (items || []).map(async (item) => {
      const file = toFileLike({ name: item.name, blob: item.blob || item.file || item });
      return serializeFileLike(file);
    })
  );
}

async function deserializeResumeImagesToFiles(serializedList) {
  return (serializedList || []).map((item) => ({
    name: item.name,
    blob: new Blob([new Uint8Array(item.data)], { type: item.type }),
  }));
}

function deserializeResumeImages(serializedList) {
  return (serializedList || []).map((item) => ({
    name: item.name,
    blob: new Blob([new Uint8Array(item.data)], { type: item.type }),
  }));
}

async function serializeFileLike(file) {
  const target = toFileLike(file);
  const blob = target.blob || target;
  const buffer = await blob.arrayBuffer();
  return {
    name: target.name || 'resume.jpg',
    type: blob.type || 'image/jpeg',
    data: Array.from(new Uint8Array(buffer)),
  };
}

function toFileLike(file) {
  if (file instanceof File) return file;
  if (file && file.blob) {
    return new File([file.blob], file.name || 'resume.jpg', { type: file.blob.type || 'image/jpeg' });
  }
  return file;
}

function validateSerializedResumeImage(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('resumeImages 项格式错误');
  }
  if (typeof item.name !== 'string' || typeof item.type !== 'string' || !Array.isArray(item.data)) {
    throw new Error('resumeImages 项缺少 name/type/data');
  }
  return {
    name: item.name,
    type: item.type,
    data: item.data.map((value) => {
      if (typeof value !== 'number') throw new Error('resumeImages.data 必须为数字数组');
      return value;
    }),
  };
}

function normalizeAiConfig(rawConfig) {
  const cfg = Object.assign({}, DEFAULT_AI_CONFIG, rawConfig || {});
  if (typeof cfg.provider !== 'string') throw new Error('aiConfig.provider 类型错误');
  if (typeof cfg.baseUrl !== 'string') throw new Error('aiConfig.baseUrl 类型错误');
  if (typeof cfg.apiKey !== 'string') throw new Error('aiConfig.apiKey 类型错误');
  if (typeof cfg.model !== 'string') throw new Error('aiConfig.model 类型错误');
  if (typeof cfg.scoreThreshold !== 'number' || Number.isNaN(cfg.scoreThreshold)) {
    throw new Error('aiConfig.scoreThreshold 类型错误');
  }
  return cfg;
}

function buildImportPreviewMeta(draft) {
  const parts = [];
  if (draft.version !== undefined) parts.push('版本 ' + draft.version);
  if (draft.exportedAt) parts.push('导出时间 ' + formatDateTime(draft.exportedAt));
  return parts.join(' · ') || '未提供导出时间';
}

function buildImportPreviewItems(draft) {
  const items = [];
  if (draft.filterState !== undefined) {
    items.push({ label: '筛选配置', value: summarizeFilterState(draft.filterState) });
  }
  if (draft.resumeImages !== undefined) {
    items.push({ label: '图片简历', value: draft.resumeImages.length ? `共 ${draft.resumeImages.length} 张图片` : '将清空图片简历' });
  }
  if (draft.textResume !== undefined) {
    items.push({ label: '文字简历', value: draft.textResume ? `包含文字简历，约 ${draft.textResume.length} 字` : '将清空文字简历' });
  }
  if (draft.aiConfig !== undefined) {
    items.push({ label: 'AI 设置', value: summarizeAiConfig(draft.aiConfig) });
  }
  return items;
}

function summarizeFilterState(filterState) {
  if (!filterState) return '未提供筛选配置';
  const lines = [];
  lines.push('城市：' + summarizeList(filterState.selectedCities));
  lines.push('岗位：' + summarizeList((filterState.selectedPositions || []).concat(filterState.customPositions || [])));
  lines.push('行业：' + summarizeList(filterState.selectedIndustries));
  lines.push('HR 活跃度：' + (filterState.hrActiveFilter || '不限'));
  lines.push('薪资：' + summarizeList(filterState.salaryRanges));
  lines.push('打招呼：' + (filterState.sendGreeting === false ? '关闭' : '开启'));
  return lines.join('；');
}

function summarizeAiConfig(config) {
  return [
    'Provider：' + (config.provider || DEFAULT_AI_CONFIG.provider),
    'Base URL：' + (config.baseUrl || '未设置'),
    'Model：' + (config.model || '未设置'),
    '阈值：' + config.scoreThreshold,
    'API Key：' + (config.apiKey ? '包含' : '未包含'),
  ].join('；');
}

function summarizeList(list) {
  return Array.isArray(list) && list.length ? list.join('、') : '不限';
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
