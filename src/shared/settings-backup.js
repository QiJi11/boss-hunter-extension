(function (global) {
  const FILTER_STATE_KEY = 'ui:filterState';
  const AI_CONFIG_KEY = 'sw:aiConfig';
  const DEFAULT_AI_CONFIG = {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4.1-mini',
    scoreThreshold: 60,
  };
  const AI_PROVIDER_PRESETS = [
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini' },
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
    { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash' },
    { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-7B-Instruct' },
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4.1-mini' },
    { id: 'openai-compatible', name: '自定义 OpenAI-compatible', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini', custom: true },
  ];

  function getAiProviderPreset(provider) {
    const id = String(provider || DEFAULT_AI_CONFIG.provider).trim();
    return AI_PROVIDER_PRESETS.find((item) => item.id === id) || AI_PROVIDER_PRESETS[0];
  }

  function inferAiProvider(provider, baseUrl) {
    const id = String(provider || '').trim();
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (id && id !== 'openai-compatible') return getAiProviderPreset(id).id;
    const matched = AI_PROVIDER_PRESETS.find((item) => !item.custom && item.baseUrl.replace(/\/+$/, '') === url);
    return matched ? matched.id : (id || DEFAULT_AI_CONFIG.provider);
  }

  function normalizeAiBaseUrlForStorage(provider, baseUrl) {
    const preset = getAiProviderPreset(provider);
    let url = preset.custom ? String(baseUrl || preset.baseUrl || DEFAULT_AI_CONFIG.baseUrl).trim() : preset.baseUrl;
    url = String(url || DEFAULT_AI_CONFIG.baseUrl).trim().replace(/\/+$/, '');
    if (!/\/v\d+(?:\.\d+)?$/.test(url) && !/\/compatible-mode\/v\d+$/.test(url) && !/\/api\/paas\/v\d+$/.test(url)) {
      url += '/v1';
    }
    return url;
  }

  /**
   * 读取当前完整备份快照。
   */
  async function readBackupSnapshot() {
    const [storageItems, storedImages] = await Promise.all([
      chrome.storage.local.get(['resumeImages', 'apiKey', 'textResume', AI_CONFIG_KEY, FILTER_STATE_KEY]),
      global.getResumeImages().catch(() => []),
    ]);

    const images = Array.isArray(storageItems.resumeImages) && storageItems.resumeImages.length
      ? storageItems.resumeImages
      : await serializeResumeImagesFromIndexedDb(storedImages);

    const aiConfig = normalizeAiConfig(storageItems[AI_CONFIG_KEY] || {});
    if (storageItems.apiKey && !aiConfig.apiKey) aiConfig.apiKey = storageItems.apiKey;

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      filterState: normalizeFilterStateForBackup(storageItems[FILTER_STATE_KEY] || null),
      resumeImages: images.length ? images : null,
      textResume: typeof storageItems.textResume === 'string' ? storageItems.textResume : null,
      aiConfig,
    };
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
      draft.filterState = normalizeFilterStateForBackup(raw.filterState || null);
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
      const fileLikes = deserializeResumeImages(draft.resumeImages);
      if (fileLikes.length) {
        await global.saveResumeImages(fileLikes);
      } else {
        await global.clearResumeImages();
      }
    }
  }

  /**
   * 将当前页面里的 File/Blob 结构转成可存储快照。
   */
  async function serializeCurrentResumeImages(resumeImages) {
    return Promise.all((resumeImages || []).map(async (img) => serializeFileLike(toFileLike(img))));
  }

  /**
   * 将 IndexedDB 中的简历图序列化为备份结构。
   */
  async function serializeResumeImagesFromIndexedDb(items) {
    return Promise.all(
      (items || []).map(async (item) => {
        const file = toFileLike({ name: item.name, blob: item.blob || item.file || item });
        return serializeFileLike(file);
      })
    );
  }

  /**
   * 将序列化的简历图恢复为页面可直接使用的 blob 列表。
   */
  function deserializeResumeImages(serializedList) {
    return (serializedList || []).map((item) => ({
      name: item.name,
      blob: new Blob([new Uint8Array(item.data)], { type: item.type }),
    }));
  }

  /**
   * 统一 AI 配置结构并校验字段类型。
   */
  function normalizeAiConfig(rawConfig) {
    const cfg = Object.assign({}, DEFAULT_AI_CONFIG, rawConfig || {});
    if (typeof cfg.provider !== 'string') throw new Error('aiConfig.provider 类型错误');
    if (typeof cfg.baseUrl !== 'string') throw new Error('aiConfig.baseUrl 类型错误');
    if (typeof cfg.apiKey !== 'string') throw new Error('aiConfig.apiKey 类型错误');
    if (typeof cfg.model !== 'string') throw new Error('aiConfig.model 类型错误');
    if (typeof cfg.scoreThreshold !== 'number' || Number.isNaN(cfg.scoreThreshold)) {
      throw new Error('aiConfig.scoreThreshold 类型错误');
    }
    cfg.provider = inferAiProvider(cfg.provider, cfg.baseUrl);
    const preset = getAiProviderPreset(cfg.provider);
    cfg.provider = preset.id;
    cfg.baseUrl = normalizeAiBaseUrlForStorage(cfg.provider, cfg.baseUrl);
    cfg.model = cfg.model.trim() || preset.defaultModel || DEFAULT_AI_CONFIG.model;
    cfg.apiKey = cfg.apiKey.trim();
    return cfg;
  }

  /**
   * 生成导入预览顶部文案。
   */
  function buildImportPreviewMeta(draft) {
    const parts = [];
    if (draft.version !== undefined) parts.push('版本 ' + draft.version);
    if (draft.exportedAt) parts.push('导出时间 ' + formatDateTime(draft.exportedAt));
    return parts.join(' · ') || '未提供导出时间';
  }

  /**
   * 生成导入预览摘要列表。
   */
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

  function summarizeFilterState(filterState) {
    if (!filterState) return '未提供筛选配置';
    filterState = normalizeFilterStateForBackup(filterState);
    const lines = [];
    lines.push('城市：' + summarizeList(filterState.selectedCities));
    lines.push('岗位：' + summarizeList((filterState.selectedPositions || []).concat(filterState.customPositions || [])));
    lines.push('行业：' + summarizeList(filterState.selectedIndustries));
    lines.push('HR 活跃度：' + (filterState.hrActiveFilter || '不限'));
    lines.push('薪资：' + summarizeList(filterState.salaryRanges));
    lines.push('AI 薪资范围：' + summarizeAiSalaryRange(filterState.aiSalaryRange));
    lines.push('打招呼：' + (filterState.sendGreeting === false ? '关闭' : '开启'));
    lines.push('排除：' + summarizeList(filterState.excludeKeywords));
    lines.push('历史跳过：' + (filterState.skipHistoryEnabled === false ? '关闭' : '同 HR'));
    return lines.join('；');
  }

  function normalizeFilterStateForBackup(filterState) {
    if (!filterState || typeof filterState !== 'object') return filterState;
    if (typeof global.normalizeFilterStateDefaults === 'function') {
      return global.normalizeFilterStateDefaults(filterState);
    }
    const copy = Object.assign({}, filterState);
    copy.aiSalaryRange = typeof global.normalizeAiSalaryRange === 'function'
      ? global.normalizeAiSalaryRange(copy.aiSalaryRange)
      : { minK: '', maxK: '', mode: 'loose' };
    copy.excludeKeywords = Array.isArray(copy.excludeKeywords) ? copy.excludeKeywords : [];
    copy.skipHistoryEnabled = copy.skipHistoryEnabled !== false;
    copy.skipHistoryScope = 'hr';
    return copy;
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

  function summarizeAiSalaryRange(range) {
    const normalized = typeof global.normalizeAiSalaryRange === 'function'
      ? global.normalizeAiSalaryRange(range)
      : { minK: '', maxK: '', mode: 'loose' };
    if (!normalized.minK && !normalized.maxK) return '不限';
    return (normalized.minK || '不限') + '-' + (normalized.maxK || '不限') + 'K/月，' + (normalized.mode === 'strict' ? '严格' : '宽松');
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  global.SettingsBackup = {
    FILTER_STATE_KEY,
    AI_CONFIG_KEY,
    DEFAULT_AI_CONFIG,
    AI_PROVIDER_PRESETS,
    getAiProviderPreset,
    inferAiProvider,
    normalizeAiBaseUrlForStorage,
    readBackupSnapshot,
    normalizeImportPayload,
    applySnapshotToStorage,
    serializeCurrentResumeImages,
    deserializeResumeImages,
    normalizeAiConfig,
    buildImportPreviewMeta,
    buildImportPreviewItems,
  };
})(window);
