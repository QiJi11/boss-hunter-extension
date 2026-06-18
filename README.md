# Boss Hunter

BOSS 直聘 AI 岗位筛选与投递辅助扩展。它会在 BOSS 直聘岗位页打开侧边栏，按城市、岗位、薪资、经验、学历等条件采集岗位，并用你配置的 AI 接口结合简历内容判断岗位匹配度。

## 下载与安装

1. 下载最新安装包：
   https://github.com/QiJi11/boss-hunter-extension/releases/download/v1.2.0/boss-hunter-extension-v1.2.0.zip
2. 解压 zip 文件。
3. 打开 Chrome 或 Edge 的扩展管理页：`chrome://extensions/`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”。
6. 选择解压后的目录，目录根部应能看到 `manifest.json`。
7. 打开 BOSS 直聘岗位页：`https://www.zhipin.com/web/geek/jobs`。
8. 点击浏览器工具栏里的 Boss Hunter 图标，打开右侧面板。

## AI 接入

Boss Hunter 使用 OpenAI-compatible 接口，也就是兼容 OpenAI Chat Completions 格式的接口。可以接入 OpenAI 官方接口，也可以接入其他兼容服务。

在扩展侧边栏点击“完整设置”，填写：

1. `Provider`：默认填 `openai-compatible`。
2. `Base URL`：接口地址，例如 `https://api.openai.com/v1`。
3. `API Key`：你的模型服务密钥。
4. `Model`：模型名，例如 `gpt-4.1-mini`，或你的服务商提供的兼容模型名。
5. `AI 筛选阈值`：岗位 AI 分数达到该阈值时更倾向于推荐。
6. 点击“测试 AI 连接”，成功后保存设置。

如果使用 OpenAI 官方接口：

```text
Provider: openai-compatible
Base URL: https://api.openai.com/v1
API Key: sk-...
Model: gpt-4.1-mini
```

如果使用第三方兼容接口：

```text
Provider: openai-compatible
Base URL: 填服务商给你的 OpenAI-compatible /v1 地址
API Key: 填服务商给你的密钥
Model: 填服务商支持的模型名
```

API Key 只保存在本机浏览器的 `chrome.storage.local`，不会写入仓库或安装包。配置导出功能可能包含 AI 设置，请只在可信设备上保存和分享配置文件。

## 使用流程

1. 在“完整设置”里配置 AI 接口和文字简历。
2. 在首页选择城市、岗位、薪资、经验、学历等筛选条件。
3. 可填写“AI 薪资范围”，设置最低和最高 K/月，并选择宽松或严格模式。
4. 点击开始采集，等待岗位列表和 AI 匹配结果。
5. 查看岗位卡片里的 AI 分数、理由、风险和建议状态。
6. 确认要投递的岗位后再执行后续操作。

## 说明

- 本扩展不绕过验证码、不处理安全验证、不保证投递成功率。
- 遇到 BOSS 登录、安全检查或验证码，需要人工处理。
- 建议先小批量测试筛选条件和 AI 判断效果，再扩大采集范围。
- 项目地址：https://github.com/QiJi11/boss-hunter-extension
