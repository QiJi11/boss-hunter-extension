// 聊天监听模块 — MutationObserver + PDF 自动回复
const ChatMonitor = {
  observer: null,
  enabled: false,
  resumeId: '',
  handledStorageKey: 'autoResumeReplyHandledKeys',
  // HR 消息含这些关键词时自动发 PDF 简历
  resumeKeywords: ['简历', '附件', 'PDF', 'pdf', '清晰', '文件', '发我', '发一份', '发个', '再发', '详细的'],

  start(resumeId) {
    const nextResumeId = String(resumeId || '').trim();
    if (!nextResumeId) {
      this.stop();
      return;
    }
    this.resumeId = nextResumeId;
    if (this.observer) {
      this.enabled = true;
      return;
    }
    this.enabled = true;

    document.querySelectorAll(SELECTORS.chatDetail.hrMessage).forEach((message) => {
      message.dataset.zitouChecked = '1';
    });

    this.observer = new MutationObserver((mutations) => {
      if (!this.enabled) return;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) this.checkMessages(node);
        }
      }
    });

    // 监听聊天消息区域
    const chatArea = document.querySelector('.chat-main');
    const target = chatArea || document.body;
    this.observer.observe(target, { childList: true, subtree: true });

  },

  checkMessages(container) {
    const hrMessages = container.querySelectorAll
      ? container.querySelectorAll(SELECTORS.chatDetail.hrMessage)
      : [];
    hrMessages.forEach((msg) => this.processMessage(msg));
  },

  async processMessage(msgEl) {
    if (msgEl.dataset.zitouChecked) return;
    msgEl.dataset.zitouChecked = '1';

    const text = msgEl.textContent || '';
    const hasKeyword = this.resumeKeywords.some((kw) => text.includes(kw));
    if (!hasKeyword) return;
    const messageKey = this.buildMessageKey(msgEl, text);
    const stored = await chrome.storage.local.get(this.handledStorageKey);
    const handled = Array.isArray(stored[this.handledStorageKey]) ? stored[this.handledStorageKey] : [];
    if (handled.includes(messageKey)) return;

    // 通知 background
    chrome.runtime.sendMessage({ type: 'CHAT_DETECTED', text: text.slice(0, 100) });

    const delivered = await this.sendResumeAttachment();
    if (delivered) {
      await chrome.storage.local.set({
        [this.handledStorageKey]: handled.concat(messageKey).slice(-200),
      });
    }
  },

  buildMessageKey(msgEl, text) {
    const messageId = msgEl.dataset?.messageId
      || msgEl.getAttribute('data-message-id')
      || msgEl.getAttribute('data-id')
      || '';
    return [location.pathname, location.search, messageId, String(text || '').replace(/\s+/g, '').slice(0, 120)].join('|');
  },

  async sendResumeAttachment() {
    try {
      // 点"发简历"按钮
      const resumeBtn = document.querySelector(SELECTORS.chatDetail.resumeBtn);
      if (!resumeBtn) return;
      resumeBtn.click();
      await sleep(800);

      const baseline = document.querySelectorAll(SELECTORS.chatDetail.messageSent).length;
      const items = Array.from(document.querySelectorAll(SELECTORS.chatDetail.resumeItem));
      const item = items.find((node) => {
        const id = String(node.dataset?.resumeId || node.getAttribute('data-id') || '');
        return id === this.resumeId || String(node.textContent || '').includes(this.resumeId);
      });
      if (!item) return;
      item.click();
      await sleep(300);

      // 确认发送
      const confirm = document.querySelector(SELECTORS.chatDetail.resumeConfirm);
      if (!confirm) return;
      confirm.click();
      const status = await waitForResumeDelivery(baseline, 10000, this.resumeId);
      chrome.runtime.sendMessage({
        type: 'AUTO_REPLY_SENT',
        success: status === 'delivery',
        error: status === 'delivery' ? '' : 'resume_delivery_' + status,
      });
      return status === 'delivery';
    } catch (e) {
      chrome.runtime.sendMessage({ type: 'AUTO_REPLY_SENT', success: false, error: e.message });
      return false;
    }
  },

  stop() {
    this.enabled = false;
    this.resumeId = '';
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  },
};

function matchesSelectedResume(message, resumeId) {
  const fingerprint = String(resumeId || '').replace(/\s+/g, '').toLowerCase();
  if (!fingerprint) return false;
  const text = String(message.textContent || '').replace(/\s+/g, '').toLowerCase();
  if (text.includes(fingerprint)) return true;
  const candidates = message.querySelectorAll('[data-resume-id],[data-id],[title],[download],a[href]');
  return Array.from(candidates).some((node) => {
    const evidence = [
      node.dataset?.resumeId,
      node.getAttribute('data-id'),
      node.getAttribute('title'),
      node.getAttribute('download'),
      node.getAttribute('href'),
    ].filter(Boolean).join('|').replace(/\s+/g, '').toLowerCase();
    return evidence.includes(fingerprint);
  });
}

async function waitForResumeDelivery(baseline, timeoutMs, resumeId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = document.querySelectorAll(SELECTORS.chatDetail.messageSent);
    for (let i = baseline; i < items.length; i++) {
      if (!matchesSelectedResume(items[i], resumeId)) continue;
      const status = items[i].querySelector('.message-status');
      if (status?.classList.contains('status-delivery')) return 'delivery';
      if (status?.classList.contains('status-error')) return 'error';
    }
    await sleep(300);
  }
  return 'timeout';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
