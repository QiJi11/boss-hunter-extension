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
const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const scoreThresholdInput = document.getElementById('scoreThreshold');
const textResumeInput = document.getElementById('textResume');
const aiScreeningEnabledInput = document.getElementById('aiScreeningEnabled');
const autoResumeReplyEnabledInput = document.getElementById('autoResumeReplyEnabled');
const autoResumeIdInput = document.getElementById('autoResumeId');
const apiSectionToggle = document.getElementById('apiSectionToggle');
const apiSectionBody = document.getElementById('apiSectionBody');
const testAiBtn = document.getElementById('testAiBtn');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
const exportBtn = document.getElementById('exportBtn');
const sensitiveExportBtn = document.getElementById('sensitiveExportBtn');
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
      const origin = getProviderOriginPattern(newAiConfig.baseUrl);
      if (!confirm(`将向 ${origin} 外发文字简历和岗位信息。是否申请该域名权限并保存？`)) {
        setStatus('已取消保存', '');
        return;
      }
      const permission = await requestProviderPermission(newAiConfig.baseUrl);
      if (!permission.granted) throw new Error(`未授予 ${permission.origin} 权限`);
      const autoResumeId = autoResumeIdInput ? autoResumeIdInput.value.trim() : '';
      if (autoResumeReplyEnabledInput?.checked && !autoResumeId) {
        throw new Error('开启自动回复前必须填写并确认在线简历名称或 ID');
      }
      if (autoResumeReplyEnabledInput?.checked
        && !confirm(`确认自动发送 BOSS 在线简历“${autoResumeId}”？`)) {
        throw new Error('已取消自动回复简历确认');
      }
      await applySnapshotToStorage({
        resumeImages: await serializeCurrentResumeImages(resumeImages),
        textResume: newTextResume,
        aiConfig: newAiConfig,
      });
      await chrome.storage.local.set({
        aiScreeningEnabled: !aiScreeningEnabledInput || aiScreeningEnabledInput.checked,
        autoResumeReplyEnabled: !!autoResumeReplyEnabledInput?.checked,
        autoResumeId,
        backupVersion: 2,
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
  if (sensitiveExportBtn) {
    sensitiveExportBtn.addEventListener('click', async () => {
      if (!confirm('该文件将包含 API Key、文字简历和图片简历。确认继续？')) return;
      if (!confirm('再次确认：只应保存到可信本机位置。')) return;
      sensitiveExportBtn.disabled = true;
      try {
        downloadBackup(await readBackupSnapshot({ sensitive: true }), 'liezhi-sensitive-含密钥和简历');
      } catch (e) {
        showImportStatus('导出失败: ' + e.message, 'error');
      } finally {
        sensitiveExportBtn.disabled = false;
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
        if (pendingImportDraft.aiConfig !== undefined) {
          const origin = getProviderOriginPattern(pendingImportDraft.aiConfig.baseUrl);
          if (!confirm(`导入后将向 ${origin} 外发文字简历和岗位信息。是否申请该域名权限？`)) {
            throw new Error('已取消 Provider 权限申请，未导入');
          }
          const permission = await requestImportProviderPermission(pendingImportDraft);
          if (!permission?.granted) throw new Error(`未授予 ${origin} 权限`);
        }
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
    chrome.storage.local.get(['apiKey', 'textResume', AI_CONFIG_KEY, 'aiScreeningEnabled', 'autoResumeReplyEnabled', 'autoResumeId']).catch(() => ({})),
  ]);

  aiConfig = normalizeAiConfig(storedConfig[AI_CONFIG_KEY] || {});
  if (storedConfig.apiKey && !aiConfig.apiKey) aiConfig.apiKey = storedConfig.apiKey;
  textResume = storedConfig.textResume || '';

  if (providerInput) providerInput.value = aiConfig.provider || DEFAULT_AI_CONFIG.provider;
  if (baseUrlInput) baseUrlInput.value = aiConfig.baseUrl || '';
  if (apiKeyInput) apiKeyInput.value = aiConfig.apiKey || '';
  if (modelInput) modelInput.value = aiConfig.model || '';
  if (scoreThresholdInput) scoreThresholdInput.value = Number.isFinite(Number(aiConfig.scoreThreshold)) ? aiConfig.scoreThreshold : DEFAULT_AI_CONFIG.scoreThreshold;
  if (textResumeInput) textResumeInput.value = textResume;
  if (aiScreeningEnabledInput) aiScreeningEnabledInput.checked = storedConfig.aiScreeningEnabled !== false;
  if (autoResumeReplyEnabledInput) autoResumeReplyEnabledInput.checked = storedConfig.autoResumeReplyEnabled === true;
  if (autoResumeIdInput) autoResumeIdInput.value = storedConfig.autoResumeId || '';

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
    scoreThreshold: scoreThresholdInput ? Number(scoreThresholdInput.value === '' ? DEFAULT_AI_CONFIG.scoreThreshold : scoreThresholdInput.value) : DEFAULT_AI_CONFIG.scoreThreshold,
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

function downloadBackup(snapshot, prefix) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = url;
  link.download = `${prefix || 'liezhi-backup'}-${stamp}.json`;
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
