// 岗位收集模块 — DOM 解析 + 无限滚动 + 标签聚类 + URL 筛选
function extractHrName(card, companyText) {
  const selectors = ['.boss-name', '.name', '.job-boss-info .name', '[class*="boss-name"]'];
  for (const selector of selectors) {
    const el = card.querySelector(selector);
    const text = el?.textContent.trim();
    if (text) return text.replace(companyText || '', '').trim();
  }
  const raw = card.querySelector('.job-card-footer')?.textContent.trim() || '';
  if (!raw) return '';
  const cleaned = raw.replace(companyText || '', '').replace(/\s+/g, ' ').trim();
  return cleaned.split(/[·|｜\s]/).filter(Boolean)[0] || '';
}

// ── 工作经验年限提取（自包含，content script 不加载 constants.js） ──
// 从岗位卡片 tags 里识别年限项（如「1-3年」「经验不限」），返回独立 experience 字段。
// 匹配优先级从长到短（「10年以上」要先于「1年」匹配）。
const EXPERIENCE_TAG_RES = [
  { label: '在校生(实习)', re: /在校生|实习生/ },
  { label: '应届生(校招)', re: /应届生/ },
  { label: '经验不限', re: /经验不限/ },
  { label: '1年以内', re: /1\s*年以内|一年以内/ },
  { label: '1-3年', re: /[1一二]\s*[-~至到]\s*[3三]\s*年/ },
  { label: '3-5年', re: /[3三]\s*[-~至到]\s*[5五]\s*年/ },
  { label: '5-10年', re: /[5五]\s*[-~至到]\s*10\s*年/ },
  { label: '10年以上', re: /10\s*年?以上|[1一][0〇]年[以之]上/ },
  { label: '5年以上', re: /5\s*年?以上|5年[以之]上/ },
];
function extractExperienceFromTags(tags) {
  if (!Array.isArray(tags)) return '';
  for (let i = 0; i < tags.length; i++) {
    const tag = String(tags[i] || '').trim();
    for (let j = 0; j < EXPERIENCE_TAG_RES.length; j++) {
      if (EXPERIENCE_TAG_RES[j].re.test(tag)) return EXPERIENCE_TAG_RES[j].label;
    }
  }
  return '';
}
// 从 tags 里移除已识别的年限项，避免卡片上重复显示
function stripExperienceFromTags(tags, experience) {
  if (!experience || !Array.isArray(tags)) return tags;
  return tags.filter((t) => t.trim() !== experience);
}

const JobCollector = {
  collected: new Map(), // id → job
  stopped: false,
  scrollDelay: 1500,
  maxPages: 20, // 最多翻20页

  // ── 卡片解析 ──
  parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salaryEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const companyEl = card.querySelector(SELECTORS.jobs.company);
    const tags = [...card.querySelectorAll(SELECTORS.jobs.tagList)].map((t) => t.textContent.trim());
    const link = card.querySelector('a')?.href || '';
    const id = link.match(/job_detail\/([^.]+)\.html/)?.[1] || link;
    const companyText = companyEl?.textContent.trim() || '';
    const hrName = extractHrName(card, companyText);
    const experience = extractExperienceFromTags(tags);
    const cleanTags = stripExperienceFromTags(tags, experience);

    return {
      id,
      name: nameEl?.textContent.trim() || '',
      salary: decodeSalary(salaryEl?.textContent || ''),
      company: companyText,
      hrName,
      experience,
      tags: cleanTags,
      link,
    };
  },

  // ── 解析当前页所有卡片 ──
  parseCurrentPage() {
    const cards = typeof getJobCards === 'function' ? getJobCards() : document.querySelectorAll(SELECTORS.jobs.jobCard);
    let newCount = 0;
    Array.from(cards).forEach((card) => {
      const job = this.parseCard(card);
      if (job.id && !this.collected.has(job.id)) {
        this.collected.set(job.id, job);
        newCount++;
      }
    });
    return newCount;
  },

  // ── 获取当前筛选标签 ──
  getActiveTags() {
    const tags = [];
    const synthesis = document.querySelector(SELECTORS.jobs.synthesis);
    if (synthesis) tags.push({ type: 'recommend', name: synthesis.textContent.trim() });

    document.querySelectorAll(SELECTORS.jobs.expectItemText).forEach((el) => {
      tags.push({ type: 'expect', name: el.textContent.trim() });
    });
    return tags;
  },

  // ── 无限滚动 ──
  async scrollToLoad(progressCb) {
    this.stopped = false;

    // 等首批卡片渲染（页面刚跳转 AJAX 未回时，避免立即 break 退出）
    const cardSelector = SELECTORS.jobs.jobCard;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10000) {
      const cards = typeof getJobCards === 'function' ? getJobCards() : document.querySelectorAll(cardSelector);
      if (cards.length > 0) break;
      await sleep(500);
    }

    let page = 0;
    let prevCount = 0;

    while (!this.stopped && page < this.maxPages) {
      this.parseCurrentPage();
      const currentCount = this.collected.size;
      if (currentCount !== prevCount) {
        progressCb({ collected: currentCount });
        prevCount = currentCount;
      }

      // 滚动到底
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(this.scrollDelay);

      // 检测是否有新内容加载
      const newCards = typeof getJobCards === 'function' ? getJobCards() : document.querySelectorAll(SELECTORS.jobs.jobCard);
      if (newCards.length <= currentCount + 1) {
        // 可能没有更多了
        await sleep(1000);
        this.parseCurrentPage();
        if (this.collected.size === currentCount) break;
      }
      page++;
    }

    // 最终解析
    this.parseCurrentPage();
  },

  // ── 按标签聚类 ──
  clusterByTag() {
    const clusters = {};
    for (const job of this.collected.values()) {
      const primaryTag = job.tags[0] || '其他';
      if (!clusters[primaryTag]) clusters[primaryTag] = [];
      clusters[primaryTag].push(job);
    }
    return clusters;
  },

  // ── 取每类代表性 JD ──
  sampleJDs(clusters, perCluster = 5) {
    const samples = {};
    for (const [tag, jobs] of Object.entries(clusters)) {
      samples[tag] = jobs.slice(0, perCluster).map((j) => ({
        title: j.name,
        tags: j.tags,
        desc: j.name, // JD 详情需额外抓取
      }));
    }
    return samples;
  },

  // ── 按标签分组顺序发送计划 ──
  buildSendPlan(clusters, greetings) {
    const plan = [];
    for (const [tag, jobs] of Object.entries(clusters)) {
      for (const job of jobs) {
        plan.push({
          jobId: job.id,
          category: tag,
          greeting: greetings[tag] || '',
        });
      }
    }
    return plan;
  },
};

// ── 收集入口 ──
// 注意：导航逻辑已移至 service worker，避免页面重载销毁 content script 执行上下文
async function runCollection(params, progressCb) {
  JobCollector.collected.clear();

  await JobCollector.scrollToLoad(progressCb);
  const clusters = JobCollector.clusterByTag();

  return {
    jobs: [...JobCollector.collected.values()],
    clusters,
    count: JobCollector.collected.size,
    jdSamples: JobCollector.sampleJDs(clusters),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
