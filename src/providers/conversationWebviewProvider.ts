import * as vscode from "vscode";
import { ConversationStore } from "../stores/types";

export interface OpenConversationOptions {
  query?: string;
  occurrence?: number;
}

export class ConversationDetailProvider {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly store: ConversationStore) {}

  async open(id: string, options: OpenConversationOptions = {}): Promise<void> {
    const detail = await this.store.get(id);
    if (!detail) {
      void vscode.window.showWarningMessage("未找到该对话内容。");
      return;
    }

    const html = renderDetailHtml(detail.summary.title, detail.summary.cwd || detail.summary.sourcePath, detail.messages, options);
    if (this.panel) {
      this.panel.title = detail.summary.title;
      this.panel.webview.html = html;
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel("codexChatManager.conversation", detail.summary.title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    this.panel.webview.html = html;
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightHtml(text: string, query: string, start: { value: number }): string {
  const escaped = escapeHtml(text);
  const needle = query.trim();
  if (!needle) {
    return escaped;
  }
  return escaped.replace(new RegExp(escapeRegExp(escapeHtml(needle)), "gi"), (match) => {
    const index = start.value;
    start.value += 1;
    return `<mark id="hit-${index}">${match}</mark>`;
  });
}

function renderDetailHtml(
  title: string,
  meta: string,
  messages: { role: string; content: string }[],
  options: OpenConversationOptions
): string {
  const query = options.query?.trim() ?? "";
  const occurrence = options.occurrence ?? -1;
  const counter = { value: 0 };
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const body =
    visible.length === 0
      ? "<p class='empty'>暂无可展示的消息。</p>"
      : visible
          .map(
            (message) => `
                <article class="msg ${escapeHtml(message.role)}">
                  <header>${escapeHtml(roleLabel(message.role))}</header>
                  <pre>${highlightHtml(message.content, query, counter)}</pre>
                </article>`
          )
          .join("");

  const nonce = getNonce();
  const current = occurrence >= 0 ? occurrence : query ? 0 : -1;
  const script =
    current >= 0
      ? `<script nonce="${nonce}">
          const el = document.getElementById(${JSON.stringify(`hit-${current}`)});
          if (el) {
            el.classList.add("current");
            el.scrollIntoView({ block: "center", inline: "nearest" });
          }
        </script>`
      : "";

  return `<!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
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
            .empty { color: var(--vscode-descriptionForeground); }
            .msg { max-width: 720px; border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; }
            .msg header { font-size: 11px; opacity: 0.7; margin-bottom: 6px; }
            .msg.user { background: color-mix(in srgb, var(--vscode-editor-background) 82%, #4c8dff); margin-left: 48px; }
            .msg.assistant { background: color-mix(in srgb, var(--vscode-editor-background) 88%, #888); margin-right: 48px; }
            pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: inherit; }
            mark {
              background: color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c0055) 80%, transparent);
              color: inherit;
              border-radius: 2px;
              padding: 0 1px;
            }
            mark.current {
              background: var(--vscode-editor-findMatchBackground, #ea5c00);
              color: #fff;
              outline: 1px solid var(--vscode-focusBorder, #3794ff);
            }
          </style>
        </head>
        <body>
          <div class="top">
            <h1>${highlightHtml(title, query, { value: 100000 })}</h1>
          </div>
          <p class="meta">${escapeHtml(meta)}</p>
          ${body}
          ${script}
        </body>
      </html>`;
}

function roleLabel(role: string): string {
  return role === "user" ? "你" : "Codex";
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
