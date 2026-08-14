import * as vscode from "vscode";
import { ConversationStore } from "../stores/types";

export class ConversationDetailProvider {
  constructor(private readonly store: ConversationStore) {}

  async open(id: string): Promise<void> {
    const detail = await this.store.get(id);
    if (!detail) {
      void vscode.window.showWarningMessage("未找到该对话内容。");
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "codexChatManager.conversation",
      detail.summary.title,
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    const escaped = (text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const body =
      detail.messages.length === 0
        ? "<p class='empty'>暂无可展示的消息。</p>"
        : detail.messages
            .map(
              (message) => `
                <article class="msg ${escaped(message.role)}">
                  <header>${escaped(roleLabel(message.role))}</header>
                  <pre>${escaped(message.content)}</pre>
                </article>`
            )
            .join("");

    const archived = detail.summary.archived ? "<span class='badge'>已归档</span>" : "";

    panel.webview.html = `<!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
          <style>
            body {
              margin: 0;
              font-family: var(--vscode-font-family);
              color: var(--vscode-foreground);
              background: var(--vscode-editor-background);
              padding: 20px 24px 40px;
            }
            .top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
            h1 { font-size: 18px; font-weight: 600; margin: 0; }
            .meta { color: var(--vscode-descriptionForeground); margin-bottom: 20px; font-size: 12px; }
            .badge {
              font-size: 11px;
              color: var(--vscode-descriptionForeground);
              border: 1px solid var(--vscode-widget-border, #444);
              border-radius: 999px;
              padding: 1px 8px;
            }
            .empty { color: var(--vscode-descriptionForeground); }
            .msg { max-width: 720px; border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
            .msg header { font-size: 11px; opacity: 0.7; margin-bottom: 6px; }
            .msg.user { background: color-mix(in srgb, var(--vscode-editor-background) 82%, #4c8dff); margin-left: 48px; }
            .msg.assistant { background: color-mix(in srgb, var(--vscode-editor-background) 88%, #888); margin-right: 48px; }
            pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; }
          </style>
        </head>
        <body>
          <div class="top">
            <h1>${escaped(detail.summary.title)}</h1>
            ${archived}
          </div>
          <p class="meta">${escaped(detail.summary.cwd || detail.summary.sourcePath)}</p>
          ${body}
        </body>
      </html>`;
  }
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "你";
    case "assistant":
      return "Codex";
    case "system":
      return "系统";
    case "tool":
      return "工具";
    default:
      return role;
  }
}
