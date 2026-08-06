# 猎职扩展 MVP 实施计划

**日期：** 2026-08-07
**目标仓库：** `boss-hunter-extension`（分支 `feature/personalized-v1.3.0`，当前有未提交工作）
**标尺：** `TODO.md` 验收清单 10 条 + `tests/run-tests.js`（当前全绿）

---

## 0. 现状盘点（调研结论）

### 已在工作区但未提交（feature/personalized-v1.3.0 分支，+799/-594）
这是一个进行中的**逐岗复核确认重构**，语法全通过、测试全绿：
1. **逐岗复核**：popup「一键发送」→「逐岗复核」，新增 `singleSendOverlay` 弹层（当前岗位 / AI 分数理由风险 / 招呼语 / 简历 / 历史沟通 / 跳过 / 确认并沟通）。消息闭环：popup `events-b.js`(PREPARE/CONFIRM_SINGLE_SEND) ↔ SW `service-worker.js`(处理 + 确认过期拦截)。
2. **feature 开关**：`aiScreeningEnabled`（采集后自动 AI 筛选）、`autoResumeReplyEnabled`（HR 索要简历自动发送）+ `autoResumeId`。
3. **敏感导出**：`compositeSensitiveExportBtn`（含密钥和简历的完整快照导出）。
4. **移除 A1 一键补发**：`REPAIR_MISSED`/`WORKER_REPAIR` 消息删除，review 页改为"逐岗打开复核"提示；`render-review.js` 结算统计改为排除 `alreadyChatted`/`skipped`。
5. **筛选默认值扩展**：排除关键词加「实习/博士/硕士及以上/5年以上/3-5年」；默认城市/职位/学历/经验预设。

### TODO 待做项 vs 现状
| TODO 项 | 现状 | 需要做 |
|---|---|---|
| 1. 真实页面手动验收结算/重投/AI筛选/投递统计 | 未做（需真登录 BOSS） | 提供验收脚本/清单；真机验收需用户 |
| 2. 岗位卡片 JD 详情展开 + 跳转 BOSS 详情页入口 | 有 JD 补拉机制、`jdEmptyText`、JD 进度，但**卡片内展开 + 跳转入口待确认** | 检查/补齐卡片 JD 摘要展开 + 详情页跳转 |
| 3. 首页 AI 对话框 | 未实现 | 决策：MVP 范围是否包含 |
| 4. 招呼语 AI 润色框 | 未实现（TODO 标"暂缓到筛选和投递稳定后"） | 决策：MVP 范围是否包含 |

### 关键风险
- 未提交分支是**进行中的工作**：若不先提交固化，后续改动叠加会失控；但提交是改 Git 历史，需用户确认。
- `autoResumeReplyEnabled` 依赖 `autoResumeId` 在线简历，需真页面确认 ID 形态。
- 真实 BOSS 页面自动化受 memory「no-hijack-user-mouse」约束，只能脚本探测 + 用户手动验收。

---

## 1. MVP 范围决策（建议）

**范围 = 让当前未提交分支成为可发布 v1.3.0：**
- P0（必须）：固化未提交分支 → 补齐 TODO-2 JD 卡片展开 + 跳转入口 → 回归测试全绿 → 提供真机验收清单。
- P1（可选，视工作量）：首页 AI 对话框（TODO-3）最简版。
- P2（明确不做）：招呼语 AI 润色框（TODO-4，待流程稳定）；真实页面自动化（受 no-hijack 约束）。

## 2. 实施步骤

### Step 1 — 固化当前分支
- [ ] 确认分支意图：向用户说明未提交改动内容，取得提交授权。
- [ ] `git add -A && git commit -m "feat(v1.3.0): 逐岗复核确认 + AI 筛选开关 + 自动回复在线简历 + 敏感导出"`（先本地提交，不 push）。

### Step 2 — 补齐 TODO-2 JD 卡片展开 + 跳转入口
- [ ] 调研 `render-b.js` 岗位卡片渲染与 `job.detail`/`jdStatus` 字段。
- [ ] 卡片增加 JD 摘要展开区（默认折叠，点击展开前 3-5 行）。
- [ ] 提供「查看 BOSS 详情」按钮 → 打开 `zhipin.com/job_detail/<jobId>.html`（新 tab，host_permissions 已含）。
- [ ] `node --check` + `npm test` 全绿。

### Step 3 — 回归与真机验收清单
- [ ] 全 JS 语法检查 + `tests/run-tests.js`。
- [ ] 产出 `MVP-ACCEPTANCE.md`：10 条验收清单 + 逐步操作说明（供用户在真实 BOSS 页面执行）。

### Step 4 — P1 首页 AI 对话框（视工作量决定，先做 P0）
- [ ] 若 P0 顺利且有剩余，实现最简首页 AI 对话框（复用 AI 配置）。

## 3. 验收标准
- `tests/run-tests.js` 全绿；`node --check` 全部通过。
- 岗位卡片可展开 JD 摘要、可跳转 BOSS 详情页。
- 未提交分支已固化提交（本地），工作区无遗留 diff。
- 提供真机验收清单，用户在真实 BOSS 页面逐条确认。

## 4. 非目标（本轮不做）
- 真机自动化验收（受 no-hijack-user-mouse 约束）
- 招呼语 AI 润色框（TODO-4）
- 推送/发布到 GitHub（除非用户要求）
