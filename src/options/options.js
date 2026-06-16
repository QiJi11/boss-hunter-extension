// ── DOM refs ──
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

// ── State ──
let resumeImages = [];
let aiConfig = {};
let textResume = '';

// ── Init ──
(async function init() {
  try {
    const [storedImages, storedData, storedApi] = await Promise.all([
      getResumeImages().catch(() => []),
      chrome.storage.local.get(['resumeImages']).catch(() => ({})),
      chrome.storage.local.get(['apiKey', 'textResume', 'sw:aiConfig']).catch(() => ({})),
    ]);

    aiConfig = Object.assign({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1-mini',
      scoreThreshold: 60,
    }, storedApi['sw:aiConfig'] || {});
    if (storedApi.apiKey && !aiConfig.apiKey) aiConfig.apiKey = storedApi.apiKey;
    textResume = storedApi.textResume || '';
    if (providerInput) providerInput.value = aiConfig.provider || 'openai-compatible';
    if (baseUrlInput) baseUrlInput.value = aiConfig.baseUrl || '';
    if (apiKeyInput) apiKeyInput.value = aiConfig.apiKey || '';
    if (modelInput) modelInput.value = aiConfig.model || '';
    if (scoreThresholdInput) scoreThresholdInput.value = aiConfig.scoreThreshold || 60;
    if (textResumeInput) textResumeInput.value = textResume;

    // Collapsible toggle
    if (apiSectionToggle) {
      apiSectionToggle.addEventListener('click', () => {
        apiSectionBody.classList.toggle('open');
        apiSectionToggle.classList.toggle('open');
      });
    }

    // 优先从 chrome.storage 读取（序列化格式）
    if (storedData.resumeImages?.length) {
      resumeImages = storedData.resumeImages.map((s) => ({
        name: s.name,
        blob: new Blob([new Uint8Array(s.data)], { type: s.type }),
      }));
    } else if (storedImages?.length) {
      resumeImages = storedImages;
    }
    renderPreviews();
  } catch (e) {
    console.warn('Options init error:', e);
  }
})();

// ── Image Upload ──
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
    const file = img.blob ? new File([img.blob], img.name || 'resume.jpg', { type: img.blob.type }) : img;
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
    provider: providerInput ? providerInput.value.trim() : 'openai-compatible',
    baseUrl: baseUrlInput ? baseUrlInput.value.trim() : '',
    apiKey: apiKeyInput ? apiKeyInput.value.trim() : '',
    model: modelInput ? modelInput.value.trim() : '',
    scoreThreshold: scoreThresholdInput ? Number(scoreThresholdInput.value || 60) : 60,
  };
}

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

// ── Save ──
saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  setStatus('保存中...', '');

  try {
    // 序列化图片到 chrome.storage（content script 需要）
    const imageData = await Promise.all(
      resumeImages.map(async (img) => {
        const file = img.blob ? new File([img.blob], img.name || 'resume.jpg', { type: img.blob.type }) : img;
        const buf = await file.arrayBuffer();
        return { name: file.name, type: file.type, data: Array.from(new Uint8Array(buf)) };
      })
    );

    const newAiConfig = readAiConfigFromForm();
    const newTextResume = textResumeInput ? textResumeInput.value.trim() : '';

    await Promise.all([
      saveResumeImages(resumeImages),
      chrome.storage.local.set({ resumeImages: imageData }),
      chrome.storage.local.set({ apiKey: newAiConfig.apiKey, 'sw:aiConfig': newAiConfig, textResume: newTextResume }),
    ]);

    aiConfig = newAiConfig;
    textResume = newTextResume;

    setStatus('已保存', 'success');
  } catch (e) {
    console.error('Save error:', e);
    setStatus('保存失败: ' + e.message, 'error');
  } finally {
    saveBtn.disabled = false;
    setTimeout(() => setStatus('', ''), 2500);
  }
});

function setStatus(text, cls) {
  saveStatus.textContent = text;
  saveStatus.className = 'save-status ' + cls;
}
