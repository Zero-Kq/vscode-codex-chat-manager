import * as vscode from "vscode";
import { ConversationStore } from "../stores/types";

export interface OpenConversationOptions {
  query?: string;
  occurrence?: number;
}

interface RenderState {
  query: string;
  counter: { value: number };
  codeBlocks: number;
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

function renderInlineMarkdown(text: string, state: RenderState): string {
  let html = highlightHtml(text, state.query, state.counter);
  const protectedParts: string[] = [];
  const protect = (value: string): string => {
    const token = `\u0000MDPART${protectedParts.length}\u0000`;
    protectedParts.push(value);
    return token;
  };

  html = html.replace(/`([^`\n]+)`/g, (_match, code: string) => protect(`<code class="inline-code">${code}</code>`));
  html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_match, label: string, url: string) => {
    return protect(`<a href="${url.replace(/&quot;|["']/g, "")}" title="${url.replace(/&quot;|["']/g, "")}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");

  return html.replace(/\u0000MDPART(\d+)\u0000/g, (_match, index: string) => protectedParts[Number(index)] ?? "");
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(lines: string[], start: number, state: RenderState): { html: string; next: number } | undefined {
  if (start + 1 >= lines.length || !lines[start].includes("|") || !isTableSeparator(lines[start + 1])) {
    return undefined;
  }

  const header = splitTableRow(lines[start]);
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const head = header.map((cell) => `<th>${renderInlineMarkdown(cell, state)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${header.map((_cell, cellIndex) => `<td>${renderInlineMarkdown(row[cellIndex] ?? "", state)}</td>`).join("")}</tr>`)
    .join("");

  return {
    html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`,
    next: index
  };
}

function renderMarkdown(content: string, state: RenderState): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let index = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(`<p>${paragraph.map((line) => renderInlineMarkdown(line, state)).join("<br>")}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```\s*([^`]*)$/);
    if (fence) {
      flushParagraph();
      const language = fence[1].trim().split(/\s+/, 1)[0];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const id = `code-${state.codeBlocks++}`;
      const label = language || "纯文本";
      blocks.push(`<div class="code-block">
        <div class="code-toolbar"><span>${escapeHtml(label)}</span><button type="button" class="copy-code" data-copy-target="${id}" title="复制代码"><span class="copy-icon" aria-hidden="true"></span><span class="copy-label">复制</span></button></div>
        <pre><code id="${id}">${highlightHtml(codeLines.join("\n"), state.query, state.counter)}</code></pre>
      </div>`);
      continue;
    }

    const table = renderTable(lines, index, state);
    if (table) {
      flushParagraph();
      blocks.push(table.html);
      index = table.next;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2].replace(/\s+#+\s*$/, ""), state)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"), state)}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      const ordered = Boolean(listMatch[2]);
      const tag = ordered ? "ol" : "ul";
      const startAt = ordered && listMatch[2] !== "1" ? ` start="${Number(listMatch[2])}"` : "";
      const items: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/);
        if (!match || Boolean(match[2]) !== ordered) {
          break;
        }
        let value = match[3];
        const task = value.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          value = `<span class="task-box${checked ? " checked" : ""}" aria-hidden="true">${checked ? "✓" : ""}</span>${renderInlineMarkdown(task[2], state)}`;
        } else {
          value = renderInlineMarkdown(value, state);
        }
        items.push(`<li>${value}</li>`);
        index += 1;
      }
      blocks.push(`<${tag}${startAt}>${items.join("")}</${tag}>`);
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks.join("\n");
}

function renderDetailHtml(
  title: string,
  meta: string,
  messages: { role: string; content: string }[],
  options: OpenConversationOptions
): string {
  const query = options.query?.trim() ?? "";
  const occurrence = options.occurrence ?? -1;
  const state: RenderState = { query, counter: { value: 0 }, codeBlocks: 0 };
  const visible = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const body =
    visible.length === 0
      ? "<p class='empty'>暂无可展示的消息。</p>"
      : visible
          .map((message) => {
            const role = message.role === "user" ? "user" : "assistant";
            return `<article class="message ${role}">
              <div class="message-head"><span class="avatar ${role}" aria-hidden="true">${role === "user" ? "你" : "✦"}</span><span>${escapeHtml(roleLabel(role))}</span></div>
              <div class="markdown-body">${renderMarkdown(message.content, state)}</div>
            </article>`;
          })
          .join("");

  const nonce = getNonce();
  const current = occurrence >= 0 ? occurrence : query ? 0 : -1;
  const titleCounter = { value: 100000 };

  return `<!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <style>
            :root {
              color-scheme: light dark;
              --page-bg: var(--vscode-editor-background);
              --fg: var(--vscode-editor-foreground, var(--vscode-foreground));
              --muted: var(--vscode-descriptionForeground, #999);
              --border: var(--vscode-panel-border, color-mix(in srgb, var(--fg) 14%, transparent));
              --soft-bg: color-mix(in srgb, var(--page-bg) 91%, var(--fg));
              --user-bg: color-mix(in srgb, var(--page-bg) 84%, var(--vscode-button-background, #3b82f6));
              --code-bg: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--page-bg) 88%, #888));
              --inline-code-bg: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--page-bg) 86%, #888));
              --link: var(--vscode-textLink-foreground, #4daafc);
            }
            * { box-sizing: border-box; }
            html { min-height: 100%; background: var(--page-bg); }
            body {
              margin: 0;
              color: var(--fg);
              background: var(--page-bg);
              font-family: var(--vscode-font-family, system-ui, sans-serif);
              font-size: var(--vscode-font-size, 14px);
              line-height: 1.55;
            }
            .page {
              width: min(900px, calc(100% - 40px));
              margin: 0 auto;
              padding: 34px 0 64px;
            }
            .conversation-title {
              margin: 0;
              color: var(--fg);
              font-size: clamp(22px, 3vw, 30px);
              line-height: 1.25;
              letter-spacing: -0.02em;
              font-weight: 650;
            }
            .meta {
              display: flex;
              align-items: center;
              gap: 7px;
              margin: 8px 0 30px;
              color: var(--muted);
              font-family: var(--vscode-editor-font-family, monospace);
              font-size: 12px;
              overflow-wrap: anywhere;
            }
            .meta::before {
              content: "";
              width: 7px;
              height: 7px;
              flex: none;
              border-radius: 50%;
              background: var(--vscode-charts-green, #89d185);
            }
            .message {
              position: relative;
              margin: 0 0 30px;
            }
            .message.user {
              width: min(82%, 720px);
              margin-left: auto;
              padding: 14px 17px 15px;
              border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #3794ff) 22%, transparent);
              border-radius: 16px 16px 5px 16px;
              background: var(--user-bg);
            }
            .message.assistant {
              padding: 2px 0 6px;
            }
            .message-head {
              display: flex;
              align-items: center;
              gap: 7px;
              margin-bottom: 7px;
              color: var(--muted);
              font-size: 11px;
              font-weight: 500;
              letter-spacing: 0.01em;
            }
            .avatar {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 20px;
              height: 20px;
              border-radius: 6px;
              font-size: 10px;
              line-height: 1;
            }
            .avatar.user { background: color-mix(in srgb, var(--vscode-button-background, #3b82f6) 30%, transparent); color: var(--fg); }
            .avatar.assistant { background: color-mix(in srgb, var(--vscode-charts-orange, #cca700) 22%, transparent); color: var(--vscode-charts-orange, #cca700); font-size: 13px; }
            .markdown-body { min-width: 0; overflow-wrap: anywhere; }
            .markdown-body > :first-child { margin-top: 0; }
            .markdown-body > :last-child { margin-bottom: 0; }
            .markdown-body p { margin: 0 0 13px; }
            .markdown-body h2,
            .markdown-body h3,
            .markdown-body h4,
            .markdown-body h5,
            .markdown-body h6 {
              margin: 24px 0 10px;
              color: var(--fg);
              line-height: 1.3;
              font-weight: 650;
            }
            .markdown-body h2 { padding-bottom: 7px; border-bottom: 1px solid var(--border); font-size: 1.36em; }
            .markdown-body h3 { font-size: 1.18em; }
            .markdown-body h4 { font-size: 1.05em; }
            .markdown-body h5,
            .markdown-body h6 { font-size: 1em; }
            .markdown-body strong { font-weight: 650; color: color-mix(in srgb, var(--fg) 94%, white); }
            .markdown-body del { color: var(--muted); }
            .markdown-body a { color: var(--link); text-decoration: none; }
            .markdown-body a:hover { text-decoration: underline; }
            .markdown-body ul,
            .markdown-body ol { margin: 8px 0 14px; padding-left: 26px; }
            .markdown-body li { margin: 5px 0; padding-left: 2px; }
            .markdown-body li::marker { color: var(--muted); }
            .task-box {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              width: 14px;
              height: 14px;
              margin: 0 8px 0 -21px;
              border: 1px solid var(--muted);
              border-radius: 3px;
              vertical-align: -2px;
              font-size: 10px;
            }
            .task-box.checked { color: var(--page-bg); border-color: var(--vscode-charts-green, #89d185); background: var(--vscode-charts-green, #89d185); }
            .inline-code {
              padding: 0.12em 0.38em;
              border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
              border-radius: 5px;
              background: var(--inline-code-bg);
              color: var(--vscode-textPreformat-foreground, var(--fg));
              font-family: var(--vscode-editor-font-family, monospace);
              font-size: 0.92em;
            }
            .code-block {
              margin: 15px 0;
              overflow: hidden;
              border: 1px solid var(--border);
              border-radius: 12px;
              background: var(--code-bg);
              box-shadow: 0 3px 14px color-mix(in srgb, black 13%, transparent);
            }
            .code-toolbar {
              display: flex;
              align-items: center;
              justify-content: space-between;
              min-height: 38px;
              padding: 0 11px 0 14px;
              border-bottom: 1px solid var(--border);
              color: var(--muted);
              background: color-mix(in srgb, var(--code-bg) 86%, var(--fg));
              font-size: 11px;
            }
            .copy-code {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              border: none;
              border-radius: 5px;
              padding: 5px 7px;
              color: var(--muted);
              background: transparent;
              font: inherit;
              cursor: pointer;
            }
            .copy-code:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 9%, transparent); }
            .copy-icon {
              position: relative;
              width: 12px;
              height: 12px;
              border: 1px solid currentColor;
              border-radius: 2px;
            }
            .copy-icon::before {
              content: "";
              position: absolute;
              width: 8px;
              height: 8px;
              top: -4px;
              left: -4px;
              border: 1px solid currentColor;
              border-radius: 2px;
              background: var(--code-bg);
            }
            .code-block pre {
              margin: 0;
              padding: 15px 17px 17px;
              overflow: auto;
              color: var(--vscode-editor-foreground, var(--fg));
              background: transparent;
              font-family: var(--vscode-editor-font-family, monospace);
              font-size: var(--vscode-editor-font-size, 13px);
              line-height: 1.55;
              tab-size: 2;
            }
            .code-block pre code { white-space: pre; }
            blockquote {
              margin: 14px 0;
              padding: 4px 0 4px 15px;
              border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-focusBorder, #3794ff));
              color: var(--vscode-textBlockQuote-foreground, var(--muted));
              background: linear-gradient(90deg, var(--vscode-textBlockQuote-background, transparent), transparent);
            }
            blockquote > :last-child { margin-bottom: 0; }
            hr { height: 1px; margin: 24px 0; border: 0; background: var(--border); }
            .table-wrap { margin: 15px 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 9px; }
            table { width: 100%; border-collapse: collapse; font-size: 0.94em; }
            th, td { padding: 9px 12px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
            th:last-child, td:last-child { border-right: 0; }
            tbody tr:last-child td { border-bottom: 0; }
            th { background: var(--soft-bg); font-weight: 650; }
            .empty { color: var(--muted); text-align: center; padding: 40px 0; }
            mark {
              padding: 0 1px;
              border-radius: 2px;
              color: inherit;
              background: color-mix(in srgb, var(--vscode-editor-findMatchHighlightBackground, #ea5c0055) 80%, transparent);
            }
            mark.current {
              color: #fff;
              background: var(--vscode-editor-findMatchBackground, #ea5c00);
              outline: 1px solid var(--vscode-focusBorder, #3794ff);
            }
            @media (max-width: 640px) {
              .page { width: calc(100% - 24px); padding-top: 22px; }
              .message.user { width: 94%; }
              .conversation-title { font-size: 22px; }
            }
          </style>
        </head>
        <body>
          <main class="page">
            <h1 class="conversation-title">${highlightHtml(title, query, titleCounter)}</h1>
            <p class="meta">${escapeHtml(meta)}</p>
            <section class="conversation">${body}</section>
          </main>
          <script nonce="${nonce}">
            const current = ${JSON.stringify(current >= 0 ? `hit-${current}` : "")};
            if (current) {
              const el = document.getElementById(current);
              if (el) {
                el.classList.add("current");
                el.scrollIntoView({ block: "center", inline: "nearest" });
              }
            }
            document.querySelectorAll(".copy-code").forEach((button) => {
              button.addEventListener("click", async () => {
                const target = document.getElementById(button.dataset.copyTarget || "");
                if (!target) return;
                try {
                  await navigator.clipboard.writeText(target.textContent || "");
                  const label = button.querySelector(".copy-label");
                  if (label) label.textContent = "已复制";
                  setTimeout(() => { if (label) label.textContent = "复制"; }, 1400);
                } catch {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(target);
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }
              });
            });
          </script>
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
