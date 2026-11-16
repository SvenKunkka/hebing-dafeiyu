# 合并大肥鱼 · Hebing Dafeiyu

面向 DSH 机器人的开源 macOS 客户端，提供卡牌式多机器人融合。复用 DeepSeek Harness 的聊天、流式回复、工具审批与停止，以及第三方 DeepSeekBot 的长期身份和记忆，将选定机器人的规则、记忆文档与可验证来源档案组合成一个新机器人。

当前版本为 **0.1.0**。程序窗口、内部组件和资料目录仍沿用开发名称 **DSH Forge**，以保持现有配置兼容。本项目为独立客户端，与 DeepSeek 官方及 DeepSeekBot 分别维护；不接管原 DSH 的机器人库。

## 能做什么

- 拖入或点选 **2–12 个机器人**，生成可复核的融合草案。
- 精确重复文件去重；同名不同内容保留来源并要求明确选择。
- 可选模型整理：编辑人格、记忆与冲突，明确采用后再创建新机器人。
- 随机头像随任务保存；重试找回同一个新身份和头像。
- 保留原始会话、分支、可见频道消息、附件及记忆版本历史，供新机器人检索。
- 迁移选定例程：先建立暂停副本，再停旧、按原启用状态启新，保留时区且不补跑。
- 创建与回读、实际能力确认后，才允许可选的来源清理；系统 Tob 受保护。
- 使用持久化任务记录恢复中断的创建、切换与清理。

## 首次启动与隐私

**首次启动默认自动从本机已有 DSH 筛选复制模型设置与受支持的模型凭证。** 副本保存在本应用独立私有目录中；范围包括存在于本机的默认 DeepSeek 凭证和已配置提供方的相关凭证。浏览器身份、IM 登录和电脑授权不会搬入，后续模型设置不会写回原 DSH。请将凭证副本按密钥文件保护。

这一步是本地复制。正常聊天与明确触发的“智能整理”仍会向你选择的模型提供方发送认证信息与相关请求内容。原文归档、哈希去重、确定性融合和随机头像不调用模型。

公开仓库只含源码、锁文件、文档及合成测试。模型凭证、运行数据库、聊天、上传文件、原始验收资料及内部开发历史不随源码发布。

## 从源码运行

当前构建目标：**Apple Silicon Mac、macOS 15 或以上**。已在 macOS 26.6.2 实测，未逐一验证全部中间系统版本。需要 Node.js 26、npm 与系统 Git。

```sh
git clone https://github.com/SvenKunkka/hebing-dafeiyu.git
cd hebing-dafeiyu
npm ci --ignore-scripts
npm run setup:electron
npm run build
npm test
npm start
```

`setup:electron` 校验官方 Electron 分发包并使用 macOS 自带解压工具。首次运行会创建独立应用资料目录；关闭应用会停止自己的运行时，本地例程需要保持客户端运行。

```sh
# 隔离集成测试，默认不调用模型
node scripts/integration.mjs

# 本地构建 Mac 安装包
npm run pack
```

集成测试的 `--model` 选项会额外调用一次已配置模型。`scripts/import-smoke.mjs` 是可选的真实本机来源导入验证，会读取已有 DSH 的身份和记忆，生成独立测试副本并清理；常规测试不需要运行它。

详细步骤见[使用说明](docs/usage.md)，验证范围见[验收摘要](VALIDATION.md)。

## 范围与限制

- 原 DSH 导入入口只复制身份与当前记忆文档；原安装的聊天、完整 Git 历史、账号、授权及例程不随该入口迁入。
- 融合历史保留为可检索档案，不伪造一条新的原生聊天时间线，不恢复旧 Bot ID 或活动平台状态。
- 模型建议可编辑，不自动生效；账号、工具与工作区权限不取并集。
- 当前用户不可见的频道不越权读取，清理时会明确列出未归档范围。未知插件状态不承诺完整恢复。
- 原生导入总量最多 100 MiB；独立历史归档和模型输入另有容量限制，超过时停止并提示，不截断。
- 例程切换会拒绝锁定、运行中、未处理触发、临近触发及无法完整判断历史的情况。
- 首版默认关闭 IM、浏览器和电脑控制插件。现有本地安装包为本地签名，未做 Apple 公证。

## 许可与依赖

原创源码采用 [MIT 许可](LICENSE)。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、第三方 [DeepSeekBot](https://github.com/BotHarness/DeepSeekBot)、Electron、Node.js 及其他依赖各自遵守其许可，见[第三方说明](THIRD-PARTY-NOTICES.md)。完整应用包含多种许可组件，不能将整包统称为 MIT。

## English

**Hebing Dafeiyu (合并大肥鱼)** is an open-source macOS client for DSH bots with card-based multi-bot fusion. It reuses DeepSeek Harness and the third-party DeepSeekBot layer for conversations, streaming, approvals, cancellation, persistent identities and memory.

The application, internal components and data directory retain the development name **DSH Forge** for compatibility. This is an independently maintained project, with its own bot database.

### Features

Select 2–12 bots, review file conflicts, optionally edit model-generated suggestions, and create a new bot with a persistent random avatar. Original sessions, branches, visible channel messages, uploads and Git history remain retrievable archives. Selected schedules use a create-disabled → stop-old → restore-original-enabled-state sequence. Source deletion is optional and requires readback, behavioral checks and explicit confirmation.

### First launch and privacy

First launch automatically copies filtered local DSH model settings and supported model credentials into the app's private directory. This may include available default DeepSeek credentials and credentials associated with configured providers. Browser identities, IM logins and computer-control permissions are not imported; subsequent settings are not written back to the original installation.

Credential copying happens locally. Conversations and explicitly requested model-assisted editing send authentication information and relevant request content to the selected provider. Archiving, hashing, deterministic fusion and avatar generation do not call a model. Protect copied credentials as secrets.

This repository excludes credentials, runtime databases, conversations, uploads, private validation evidence and internal development history.

### Build and limitations

Use the commands above on an Apple Silicon Mac with macOS 15+, Node.js 26, npm and system Git. The default integration test uses an isolated runtime without model calls. The optional `--model` flag incurs a model request; the optional import smoke test reads the user's existing local DSH data.

The original-installation import path copies identity and current memory only. Fusion archives do not manufacture a native timeline or transfer credentials and permissions. Local schedules require the client to remain running; invisible channels and unknown plugin state are outside the guaranteed recovery scope. The current local application is not Apple-notarized.

### License

Original source is [MIT-licensed](LICENSE). Dependencies retain their own terms; see [third-party notices](THIRD-PARTY-NOTICES.md). The complete application bundle is not exclusively MIT-licensed.
