# 即投增强版扩展加载测试

## 加载方式

1. 解压 `boss-hunter-extension.zip`。
2. 打开 Chrome 或 Edge：`chrome://extensions/`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择解压后的目录，目录根部必须能看到 `manifest.json`。
6. 打开 BOSS 直聘岗位页：`https://www.zhipin.com/web/geek/jobs`。
7. 点击浏览器工具栏里的“即投”扩展图标，打开右侧 side panel。

## 验收点

1. 扩展页没有 manifest 加载错误。
2. BOSS 岗位页打开后，点击扩展图标能出现右侧“即投”面板。
3. 能进入设置页配置 AI：`baseUrl`、`apiKey`、`model`、`provider`、筛选阈值。
4. 能配置简历、城市、岗位并开始采集。
5. 采集后岗位卡片能显示 AI 分数、理由、风险和建议状态。
6. 修改筛选配置后，旧结算页不会自动弹回。
7. 结算页点击“重新投递”后回到岗位列表重选，不触发重新采集。

## 注意

- 这是 Chrome MV3 side panel 扩展，不是页面 DOM 内直接注入的右侧面板。
- `apiKey` 只保存在本机 `chrome.storage.local`。
- 不绕验证码，不处理 BOSS 安全验证；遇到验证码或安全验证需要人工处理。
- 如果 BOSS 页面提示安全检查或未登录，先人工登录后再测试。
