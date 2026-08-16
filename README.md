# Codex Chat Manager

本地 VS Code 插件，用于浏览和管理本机 **Codex** 对话。不上架 Marketplace。

侧边栏样式对齐 Codex 历史窗口：搜索框、标题 + 相对时间。会话列表以 `~/.codex/state_5.sqlite` 的 `threads` 表为准（与官方插件同一数据源），并用 `session_index.jsonl` 补全标题。

## 功能

- 显示 Codex 同款会话标题（不再用 `rollout-...` 文件名）
- 按项目分组，右键菜单重命名 / 归档 / 删除
- 筛选：全部对话、未归档、已归档
- 只列出用户对话（不展示子代理等内部会话）
- 搜索标题和对话内容，命中片段可跳转高亮
- 识别进行中的会话
- 打开对话预览

## 安装（本地 .vsix）

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

在 VS Code / Cursor 扩展视图中选择 **Install from VSIX...**，安装生成的 `vscode-codex-chat-manager-0.3.0.vsix`。

## 开发

```bash
npm install
npm run compile
```

按 `F5` 打开 Extension Development Host 调试。改完代码后在调试窗口执行 **Developer: Reload Window**。
