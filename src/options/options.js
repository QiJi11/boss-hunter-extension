const {
  FILTER_STATE_KEY,
  AI_CONFIG_KEY,
  DEFAULT_AI_CONFIG,
  readBackupSnapshot,
  normalizeImportPayload,
  applySnapshotToStorage,
  serializeCurrentResumeImages,
  deserializeResumeImages,
  normalizeAiConfig,
  buildImportPreviewMeta,
  buildImportPreviewItems,
} = window.SettingsBackup;

const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const previewGrid = document.getElementById('previewGrid');
const providerInput = document.getElementById('provider');
const baseUrlInput = document.getElementById('baseUrl');
const baseUrlGroup = document.getElementById('baseUrlGroup');
const apiKeyInput = document.getElementById('apiKey');
const apiKeyToggle = document.getElementById('apiKeyToggle');
const modelInput = document.getElementById('model');
const refreshModelsBtn = document.getElementById('refreshModelsBtn');
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
const AI_PROVIDER_PRESETS = window.SettingsBackup.AI_PROVIDER_PRESETS || [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4.1-mini' },
  { id: 'openai-compatible', name: '自定义 OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini', custom: true },
];

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
  populateProviderSelect(providerInput);
  wireSecretToggle(apiKeyInput, apiKeyToggle);
  if (providerInput) {
    providerInput.addEventListener('change', () => {
      const preset = getAiProviderPreset(providerInput.value);
      if (baseUrlInput) baseUrlInput.value = normalizeAiBaseUrlForUi(preset.id, baseUrlInput.value);
      populateModelSelect(modelInput, [{ id: preset.defaultModel, label: preset.defaultModel }], preset.defaultModel);
      updateBaseUrlVisibility();
      setStatus('', '');
    });
  }
  if (refreshModelsBtn) {
    refreshModelsBtn.addEventListener('click', () => {
      loadModelsForConfig(readAiConfigFromForm(), modelInput, setStatus, refreshModelsBtn);
    });
  }

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
        resumeImages: await serializeCurrentResumeImages(resumeImages),
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
  populateProviderSelect(providerInput);
  const [storedImages, storedResumeData, storedConfig] = await Promise.all([
    getResumeImages().catch(() => []),
    chrome.storage.local.get(['resumeImages', 'apiKey', 'textResume', AI_CONFIG_KEY, FILTER_STATE_KEY]).catch(() => ({})),
    chrome.storage.local.get(['apiKey', 'textResume', AI_CONFIG_KEY]).catch(() => ({})),
  ]);

  aiConfig = normalizeAiConfig(storedConfig[AI_CONFIG_KEY] || {});
  if (storedConfig.apiKey && !aiConfig.apiKey) aiConfig.apiKey = storedConfig.apiKey;
  textResume = storedConfig.textResume || '';

  aiConfig.provider = inferAiProvider(aiConfig.provider, aiConfig.baseUrl);
  if (providerInput) providerInput.value = aiConfig.provider || DEFAULT_AI_CONFIG.provider;
  if (baseUrlInput) baseUrlInput.value = normalizeAiBaseUrlForUi(aiConfig.provider, aiConfig.baseUrl);
  if (apiKeyInput) apiKeyInput.value = aiConfig.apiKey || '';
  if (modelInput) populateModelSelect(modelInput, [{ id: aiConfig.model || getAiProviderPreset(aiConfig.provider).defaultModel, label: aiConfig.model || getAiProviderPreset(aiConfig.provider).defaultModel }], aiConfig.model || getAiProviderPreset(aiConfig.provider).defaultModel);
  if (scoreThresholdInput) scoreThresholdInput.value = aiConfig.scoreThreshold || DEFAULT_AI_CONFIG.scoreThreshold;
  if (textResumeInput) textResumeInput.value = textResume;
  updateBaseUrlVisibility();

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
  const provider = providerInput ? providerInput.value.trim() : DEFAULT_AI_CONFIG.provider;
  return {
    provider,
    baseUrl: normalizeAiBaseUrlForUi(provider, baseUrlInput ? baseUrlInput.value.trim() : ''),
    apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
    model: modelInput ? modelInput.value.trim() : '',
    scoreThreshold: scoreThresholdInput ? Number(scoreThresholdInput.value || DEFAULT_AI_CONFIG.scoreThreshold) : DEFAULT_AI_CONFIG.scoreThreshold,
  };
}

function getAiProviderPreset(provider) {
  return AI_PROVIDER_PRESETS.find((item) => item.id === provider) || AI_PROVIDER_PRESETS[0];
}

function inferAiProvider(provider, baseUrl) {
  if (window.SettingsBackup.inferAiProvider) return window.SettingsBackup.inferAiProvider(provider, baseUrl);
  const id = String(provider || '').trim();
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (id && id !== 'openai-compatible') return getAiProviderPreset(id).id;
  const matched = AI_PROVIDER_PRESETS.find((item) => !item.custom && item.baseUrl.replace(/\/+$/, '') === url);
  return matched ? matched.id : (id || DEFAULT_AI_CONFIG.provider);
}

function normalizeAiBaseUrlForUi(provider, baseUrl) {
  if (window.SettingsBackup.normalizeAiBaseUrlForStorage) {
    return window.SettingsBackup.normalizeAiBaseUrlForStorage(provider, baseUrl);
  }
  const preset = getAiProviderPreset(provider);
  let url = preset.custom ? String(baseUrl || preset.baseUrl || DEFAULT_AI_CONFIG.baseUrl).trim() : preset.baseUrl;
  url = String(url || DEFAULT_AI_CONFIG.baseUrl).replace(/\/+$/, '');
  if (!/\/v\d+(?:\.\d+)?$/.test(url) && !/\/compatible-mode\/v\d+$/.test(url) && !/\/api\/paas\/v\d+$/.test(url)) url += '/v1';
  return url;
}

function populateProviderSelect(select) {
  if (!select || select.options.length) return;
  AI_PROVIDER_PRESETS.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    select.appendChild(opt);
  });
}

function ensureSelectOption(select, value, label) {
  if (!select || !value) return;
  if (Array.from(select.options).some((opt) => opt.value === value)) return;
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label || value;
  select.appendChild(opt);
}

function populateModelSelect(select, models, currentModel) {
  if (!select) return;
  const keep = currentModel || select.value || '';
  select.innerHTML = '';
  const list = models && models.length ? models : [{ id: keep || DEFAULT_AI_CONFIG.model, label: keep || DEFAULT_AI_CONFIG.model }];
  list.forEach((item) => {
    const id = String(item.id || item.label || '').trim();
    if (id) ensureSelectOption(select, id, item.label || id);
  });
  if (keep) ensureSelectOption(select, keep, keep);
  select.value = keep || (select.options[0] && select.options[0].value) || '';
}

function updateBaseUrlVisibility() {
  const preset = getAiProviderPreset(providerInput ? providerInput.value : DEFAULT_AI_CONFIG.provider);
  if (baseUrlInput) baseUrlInput.value = normalizeAiBaseUrlForUi(preset.id, baseUrlInput.value);
  if (baseUrlGroup) baseUrlGroup.classList.toggle('hidden', !preset.custom);
}

function wireSecretToggle(input, button) {
  if (!input || !button) return;
  button.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.classList.toggle('revealed', reveal);
    button.title = reveal ? '隐藏 API Key' : '显示 API Key';
    button.setAttribute('aria-label', button.title);
  });
}

function loadModelsForConfig(cfg, modelEl, statusSetter, button) {
  if (!modelEl) return;
  if (button) button.disabled = true;
  statusSetter('正在获取模型列表...', '');
  chrome.runtime.sendMessage({ type: 'LIST_AI_MODELS', config: cfg }, (resp) => {
    if (button) button.disabled = false;
    if (chrome.runtime.lastError || !resp || !resp.success) {
      populateModelSelect(modelEl, null, cfg.model);
      statusSetter('模型获取失败: ' + ((resp && resp.error) || chrome.runtime.lastError?.message || '未知错误'), 'error');
      return;
    }
    populateModelSelect(modelEl, resp.models, cfg.model);
    statusSetter('模型列表已更新', 'success');
  });
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

function toFileLike(file) {
  if (file instanceof File) return file;
  if (file && file.blob) {
    return new File([file.blob], file.name || 'resume.jpg', { type: file.blob.type || 'image/jpeg' });
  }
  return file;
}
