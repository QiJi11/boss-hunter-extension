# 猎职扩展·真机投递操作手册（2026-08-08）

> 本文档记录从零到真机投递的完整可复现流程，供下次继续投递/断点续做。
> 目标：用猎职扩展在真实 BOSS 直聘投递 AI Agent/大模型岗位（逐岗确认制）。

---

## 一、环境资产（必须先知道）

| 资产 | 值 | 备注 |
|------|-----|------|
| 扩展固定 ID | `gfnbiahendiicmfbilkgkohcoiildcea` | manifest 内嵌 RSA key |
| 打包私钥 | `C:\Users\tianh\Documents\Codex-Contexts\liezhi-private.pem` | 勿提交仓库 |
| 隔离浏览器 profile | `C:\Users\tianh\Documents\Codex-Contexts\acceptance-profiles\liezhi-clean` | 已登录 BOSS（陈jh） |
| CDP 端口 | **9250** | `--remote-debugging-port=9250` |
| 扩展源码目录 | `C:\Users\tianh\Documents\Codex-Contexts\boss-hunter-extension` | 开发模式加载 |
| 分支 | `feature/personalized-v1.3.0` | 已推远程 |
| 当前工作树 | 1.3.11 本地 MVP 安全构建 | 当前安全增量未发布，见尾部 |

### AI 配置（Grok）
- baseUrl: `https://bearlab.space/v1`
- model: `grok-4.5`
- key: 只保存在扩展本地设置中，不写入文档或安装包
- **注意**：baseUrl 必须带 `/v1`，否则 405；凭据变更只在本地设置页完成

### 辅助脚本（acceptance-tools/）
| 脚本 | 用途 |
|------|------|
| `cdp.mjs` | CDP 通用操作（nav/new/eval/tabs） |
| `sw-eval.mjs` | 在扩展 SW 求值（查 state/sentJobIds） |
| `popup-eval.mjs` | 在 popup 求值（查 Store） |
| `deliver-job.mjs <jobId> [--confirm]` | 通过 popup 消息通道 PREPARE+CONFIRM 投递单岗 |
| `set-search-tab.mjs` | 设 state.searchTabId 为搜索 tab |
| `check-search.mjs` / `check-jobid-in-search.mjs <jobId>` | 验证岗位卡片在搜索页 |
| `scroll-search.mjs <关键词>` | 滚动搜索页加载更多岗位 |
| `resume-screen.mjs` | 触发断点续筛（从 aiScreeningProgress.done 继续） |
| `deliver-batch.mjs` | 批量投递（公司名→岗位名两阶段搜索） |
| `uncheck-low.mjs` | 取消低分岗勾选，只留高分岗 |

---

## 二、启动流程（浏览器 + 扩展）

```powershell
# 1. 启动隔离浏览器（用 liezhi-clean profile 保持登录态）
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$prof = 'C:\Users\tianh\Documents\Codex-Contexts\acceptance-profiles\liezhi-clean'
$args = @("--user-data-dir=$prof", "--remote-debugging-port=9250", "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble")
Start-Process $chrome -ArgumentList $args

# 2. 扩展自动加载（unpacked）。若未加载，手动: chrome://extensions → 加载已解压 → boss-hunter-extension 目录
```

**注意**：若扩展 SW 是旧代码（unpacked 缓存），需在 chrome://extensions 点猎职的「重新加载」按钮，
或 kill 浏览器重启。验证方式：`sw-eval.mjs "fetch(chrome.runtime.getURL('src/background/service-worker.js')).then(r=>r.text()).then(t=>t.indexOf('_screenKeepaliveTimer')>=0)"` → true 为新代码。

---

## 三、关键认知（真机验证的坑，务必记住）

### 3.1 匿名公司岗位 ≠ 不能投
- BOSS 隐藏真实名的岗位显示为「某大型XX公司」「某知名XX公司」。
- **公司名 query 搜不到**（"某大型电子商务公司"不是可搜索的真实名）。
- **按岗位名 query 能搜到**（真机：`query=大模型Agent应用专家` 命中并投成）。
- 投递搜索策略：**两阶段** 公司名（实名命中）→ 岗位名（匿名命中），已在 startSendV6 实现。

### 3.2 岗位名太泛搜不到
- 如「大模型算法工程师（智能体与AI应用方向）」岗位名含括号/太泛，BOSS 搜索结果被同名词淹没，目标排不到前 17。
- 岗位存在（job_detail 可开）但搜索不返回 → 无法投递，跳过。

### 3.3 搜索页只显示首屏 17 岗
- 需滚动加载更多（scroll-search.mjs 滚动 10 次）。但部分岗位即使滚动也不出现（算法排序）。

### 3.4 SW 冷启动竞态
- SW 被消息唤醒时 state.jobs 未恢复，PREPARE 会误报"岗位已失效"。
- 已修复：PREPARE case 先 `await bootRestored`。**投递前先 sw-eval 唤醒确认 jobs>0**。

### 3.5 AI 筛选保活
- Grok 单岗 40s+ > Chrome SW 空闲终止阈值 30s → 不保活则筛选冻结。
- 已修复：`_screenKeepaliveAlarm` periodInMinutes:0.2（12s）持续触发保持 SW 活跃。

---

## 四、投递流程（逐岗确认制）

### 4.1 前置检查
```bash
# 唤醒 SW 确认状态
node acceptance-tools/sw-eval.mjs "({ jobs: (state.jobs||[]).length, sent: sentJobIds.size, done: state.aiScreeningProgress?.done })"
# 期望: jobs=297, sent=29, done≈244
```

### 4.2 投递单岗（手动可控）
```bash
# 1) 搜索 tab 导航到岗位名/公司名 query
node acceptance-tools/cdp.mjs --port 9250 --cmd new --url "https://www.zhipin.com/web/geek/jobs?query=<URL编码岗位名>&city=101210100"
# 2) 验证 jobId 卡片在搜索结果
node acceptance-tools/check-jobid-in-search.mjs <jobId>
# 3) 设搜索 tab + 投递（PREPARE→CONFIRM，立即受理）
node acceptance-tools/set-search-tab.mjs && node acceptance-tools/deliver-job.mjs <jobId> --confirm
# 4) 监控结果（ok:true = 送达）
node acceptance-tools/sw-eval.mjs "new Promise(r=>{const t=setInterval(()=>{if(state.phase!=='sending'){clearInterval(t);r({phase:state.phase,results:(state.sendResults||[]).slice(-1).map(x=>({ok:x.success,reason:(x.reason||x.error||'').slice(0,120)}))})}},4000);setTimeout(()=>{clearInterval(t);r({timeout:true})},180000)})"
```

### 4.2.1 真实简历配置（投递前必须做！）

**重要教训**：投递 29+1 岗的招呼语曾全是测试假简历（"张三/3年后端"），已真实发出无法撤回。

真实简历（陈俊豪）：
- **文字简历**（AI 招呼语用）: 设置 → AI 助手 → 文字简历，或 storage `textResume` / `sw:textResume`
- **图片简历**（候选附件）: storage `resumeImages`（PDF 转 PNG 上传）。逐岗复核默认不发送，只有当前岗位明确勾选后才放行。
  - PDF 源: `job-application-assets\陈俊豪_简历优化_AgentKB-final-20260708\陈俊豪_简历_AI.pdf`
  - 转图: `python -c "import fitz; ..."`（PyMuPDF）
  - 上传: `upload-resume-imgs.mjs`（CDP DOM.setFileInputFiles）
- **招呼语重新生成**: 清空 `state.greetings` 后 `generateAllGreetingsConcurrent()`，用 `pump-greetings.mjs` 循环应对 Grok 慢响应

**华为 OD 排除**: 排除词含 OD 特征（线上面试/接受无经验/接受应届/机考/15薪），共 22 个持久化在 `ui:filterState.excludeKeywords`。投递前确认。

### 4.2.2 岗位级招呼语残留（历史事故与现行防护）

**历史教训**：旧版投递优先级是 `custom.customGreeting || job.aiGreeting || group.greeting.text`。
AI 筛选时用假简历生成了**岗位级 `job.aiGreeting`**（234 岗全是"张三"），只清组级 `state.greetings` 没用。

**现行防护**：
1. AI 岗位筛选不再生成或写入 `job.aiGreeting`，发送链也不再读取历史岗位级招呼语。
2. 自动生成、AI 润色、历史缓存和手工 `customGreeting` 都走同一份招呼语安全模块；候选人、招聘者、客户、旧公司、学校和署名信息会在复核前清理。
3. 逐岗复核时把当前展示的招呼语绑定到一次性 token；后台岗位/公司信息变化时不再静默改字，而是要求重新打开复核。
4. 图片简历复核框每次打开都默认不勾选；未显式许可时发送层不读取图片 storage。选择发图后，一次性 token 会绑定当时展示的具体图片；若仍选择发图但图片被替换、增加、删除或调换顺序，本次发送直接失效并要求重新复核。取消发图则安全降级为只发文字。
5. 旧“自动回复在线简历”授权和备份导入授权会失效，必须回到设置页重新确认具体在线简历。
6. BOSS 自带的默认招呼模板是独立外发来源。扩展只读检查其开关：任务开始、点击“立即沟通”前、进入 stage2、worker 实际发文前和验证码恢复时，开启或状态未知都会硬拦；扩展不再自动开启或修改用户设置。关闭后的整页跳转由既有 stage1 恢复链处理。
7. 所有外发招呼语先按文字简历中的候选人、客户、旧公司、学校和岗位公司信息清理；stage1 取得 HR 姓名/公司后，worker 会再次核对。最终文本只要需要再改字就不发送，必须重新逐岗复核。推荐结构是“岗位匹配点 + 1 个真实项目/技能证据 + 简短询问”，不写任何个人、客户或公司名字。
8. 一次性逐岗确认有效期为 5 分钟。正常发送或验证码暂停后若已过期，队列直接失效，必须重新逐岗复核。

### 4.3 批量投递（自动两阶段搜索）
```bash
node acceptance-tools/deliver-batch.mjs "公司名|jobId|岗位名" "公司2|jobId2|岗位名2" ...
# 每个岗位: 公司名query→验证jobId→(不中)岗位名query→验证→投递→等180s
```

---

## 五、当前状态快照（2026-08-08）

- **已投递 29 岗全部 ok:true**（sentJobIds 确认，BOSS 上限 150，余量 121）
- 首批 4: 谦贞数字/某人工智能公司/问顶科技/量驰
- 二批 4: 复知智云/北觅科技/大我网络/追觅创新科技
- 三批 3: 格尔软件/赞意/初始之塔
- 四批 4: 爱凡哲投资管理/上海启链云/盛趣游戏/上海蓬海涞讯
- 五批 6: 唯众传媒/宁波小伏/宁波奇鲲/枫清科技/易得融信/海虹信息
- 六批 2: 新研智材/曼孚科技
- 七批 3: 师顺科技/杭州星池智算/华为
- 单投: 磐石云 / 某大型电子商务公司(匿名岗位名搜索首投成) / Agent后端专家(某大型互联网上市公司)
- **筛选**: 244/297（53 个未筛；续筛可用 resume-screen.mjs，但 SW 重启后 `_screeningActive` 残留需先 reset）

### 待投高分岗（18 个，多为匿名，岗位名搜索可能命中）
见 SW: `state.jobs.filter(j=>j.aiScreen?.applyScore>=70 && j.aiScreen?.interviewScore>=70 && !sentJobIds.has(j.id))`

### 已知投不出的岗位（岗位名太泛/已下架）
- 大模型算法工程师（智能体与AI应用方向）@ 某知名计算机软件上市公司
- 大模型部署与应用工程师 @ 某中型仪器仪表
- 大模型工程师 @ 拼多多集团-PDD
- Python 相关多个 @ 华为/某大型知名计算机软件公司

---

## 六、断点续做清单（下次打开后）

1. 启动浏览器（liezhi-clean profile, 9250）→ 确认扩展加载 + BOSS 登录态
2. `sw-eval.mjs "({jobs:(state.jobs||[]).length, sent:sentJobIds.size})"` 确认数据在
3. 若要续筛: `sw-eval.mjs "(()=>{state._screeningActive=false;return true})()"` → `resume-screen.mjs`
4. 批量投剩余高分岗: 用 4.3 流程
5. 投完查 `sentJobIds.size` 汇总

### 6.1 后续结果反馈（MVP 后飞轮）

- 打开侧边栏的「查看上次投递结果」，只有 `ok:true` 的已确认送达岗位能手动标记“已回复 / 约面 / 不合适 / 暂无回复”。
- 标记仅写入当前浏览器本机；不读取聊天记录，不自动判断回复，也不会发起 BOSS 操作。再次选择会覆盖旧标签，点「撤销」可删除单条。
- 完整设置中的“把本机人工结果汇总用于下一轮 AI 筛选”默认关闭。开启后，本机至少有 5 条标记时，下一轮筛选只附加按评分档位汇总的匿名计数。
- 新增反馈摘要不会包含公司、HR、聊天内容、简历、姓名、岗位 ID 或自由备注；原有 AI 筛选仍按既有授权使用简历和岗位信息。
- 需要彻底清空时，在完整设置点击「清除本机结果反馈」。这不会影响已投递记录或 BOSS 账户。

---

## 七、版本发布记录

| 版本 | commit | 内容 |
|------|--------|------|
| v1.3.10 | 718a13b | 投递前公司名导航 + 筛选保活(b9d17fc) |
| v1.3.11 | 7d7aeb5 | 投递后自动清理多余 BOSS 搜索窗口 + 手动清理按钮 |
| 本地 MVP 安全增量 | 当前未提交工作树 | 图片简历逐岗许可、内容哈希绑定、无姓名招呼语与 BOSS 自带招呼语硬拦 |

> 现有 `v1.3.11` tag 不包含当前安全增量。本地验收包按 MVP 约定仍使用 `1.3.11`；若公开发布，必须先升级为新版本号，避免同版本内容不一致。
