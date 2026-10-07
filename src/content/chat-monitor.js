// 聊天监听模块 — MutationObserver + PDF 自动回复
const ChatMonitor = {
  observer: null,
  enabled: false,
  // HR 消息含这些关键词时自动发 PDF 简历
  resumeKeywords: ['简历', '附件', 'PDF', 'pdf', '清晰', '文件', '发我', '发一份', '发个', '再发', '详细的'],

  /**
   * 启动聊天消息监听，HR 消息命中关键词时触发自动发送简历。
   */
  start() {
    if (this.observer) return;
    this.enabled = true;

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

    // 初始检查已有消息
    this.checkMessages(target);
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

    // 通知 background
    chrome.runtime.sendMessage({ type: 'CHAT_DETECTED', text: text.slice(0, 100) });

    const sent = await this.sendResume();
    chrome.runtime.sendMessage({ type: sent ? 'AUTO_REPLY_SENT' : 'AUTO_REPLY_SKIPPED', reason: sent ? 'resumeSent' : 'resumeSendFailed' });
  },

  /**
   * 点击聊天工具栏里的发简历入口，选择第一份简历并确认发送。
   */
  async sendResume() {
    try {
      const resumeBtn = await waitChatElement([
        SELECTORS.chatDetail.resumeBtn + '[title*="简历"]',
        SELECTORS.chatDetail.resumeBtn + '[aria-label*="简历"]',
        SELECTORS.chatDetail.resumeBtn,
      ], 3000);
      if (!resumeBtn) return false;
      resumeBtn.click();

      const dialog = await waitChatElement(SELECTORS.chatDetail.resumeDialog, 5000);
      if (!dialog) return false;
      const item = await waitChatElement(SELECTORS.chatDetail.resumeItem, 5000);
      if (!item) return false;
      item.click();

      const confirm = await waitChatElement(SELECTORS.chatDetail.resumeConfirm, 5000);
      if (!confirm) return false;
      confirm.click();
      return true;
    } catch (e) {
      console.warn('[猎职] 自动发送简历失败:', e && e.message);
      return false;
    }
  },

  stop() {
    this.enabled = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  },
};

async function waitChatElement(selectors, timeoutMs = 5000) {
  const start = Date.now();
  const list = Array.isArray(selectors) ? selectors : [selectors];
  while (Date.now() - start < timeoutMs) {
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.offsetParent !== null || getComputedStyle(el).position === 'fixed') return el;
    }
    await sleep(200);
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
