# Codex Chat Manager

本地 VS Code 插件，用于浏览和管理本机 **Codex** 对话。不上架 Marketplace。

侧边栏样式对齐 Codex 历史窗口：搜索框、标题 + 相对时间。会话列表以 `~/.codex/state_5.sqlite` 的 `threads` 表为准（与官方插件同一数据源），并用 `session_index.jsonl` 补全标题。

## 功能

- 显示 Codex 同款会话标题（不再用 `rollout-...` 文件名）
- 按项目分组，右键菜单重命名 / 归档 / 删除
- 筛选：全部对话、未归档、已归档
- 只列出用户对话（不展示子代理等内部会话）
- 搜索标题和对话内容，命中片段可跳转高亮
- 增量搜索索引：按文件路径、大小和修改时间复用缓存，只重新解析变化的会话
- 大型 JSONL 会话流式读取，避免一次性把原文件读入内存
- 搜索输入 250ms 防抖，可取消旧搜索，并显示索引/搜索进度
- 高级搜索语法：`project:`、`role:`、`is:`、`after:`
- 识别进行中的会话
- 打开对话预览，使用接近 Codex 的 Markdown 排版（标题、列表、引用、表格、代码块与复制按钮）

## 高级搜索

搜索词默认不区分大小写；多个普通搜索词采用 AND 语义。包含空格的值可使用引号：

```text
project:SUPERLIO rosbag
project:"SUPER LIO" "编译 失败"
role:user 编译失败
role:assistant Docker
is:archived Docker
is:active markdown
after:2026-08-01 markdown
```

- `project:`：匹配项目名或工作目录，可重复使用
- `role:`：限定 `user` 或 `assistant`，可写成 `role:user,assistant`
- `is:`：支持 `archived`、`active`（也支持 `unarchived`）
- `after:`：按会话更新时间筛选，格式为 `YYYY-MM-DD`

首次搜索会为候选会话建立索引；后续搜索直接复用内存和扩展全局存储中的本地缓存。源文件的路径、大小或修改时间发生变化时，仅重建对应会话。缓存只保存本机解析后的对话文本，不会上传网络。

## 安装

仓库已包含打包好的 `vscode-codex-chat-manager-0.4.0.vsix`，无需编译。

1. 克隆或下载本仓库
2. 在 VS Code / Cursor 扩展视图中选择 **Install from VSIX...**
3. 选中仓库根目录下的 `vscode-codex-chat-manager-0.4.0.vsix`

本机需要已使用过 Codex（存在 `~/.codex`），并安装 `sqlite3` 或 `python3`。插件读取的是当前设备上的 Codex 对话，不会同步其他电脑的记录。

## 自行打包

如需从源码重新生成 `.vsix`：

```bash
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
```

## 开发

```bash
npm install
npm run compile
```

按 `F5` 打开 Extension Development Host 调试。改完代码后在调试窗口执行 **Developer: Reload Window**。
