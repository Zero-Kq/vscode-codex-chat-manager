import * as path from "path";
import * as vscode from "vscode";
import { parseSearchQuery } from "../search/searchQuery";
import { isAbortError } from "../search/sessionSearchIndex";
import { ConversationStore, ConversationSummary } from "../stores/types";
import { ConversationDetailProvider } from "./conversationWebviewProvider";

interface SidebarConversation {
  id: string;
  title: string;
  preview?: string;
  archived: boolean;
  running?: boolean;
  updatedAt?: string;
  cwd?: string;
  project: string;
}

export class ConversationSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codexChatManager.sidebar";
  private view?: vscode.WebviewView;
  private activeSearch?: AbortController;

  constructor(
    private readonly store: ConversationStore,
    private readonly extensionUri: vscode.Uri,
    private readonly detail: ConversationDetailProvider
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; id?: string; query?: string; occurrence?: number; requestId?: number }) => {
      switch (message.type) {
        case "ready":
        case "refresh":
          await this.refresh();
          break;
        case "search":
          await this.searchContent(message.query ?? "", message.requestId ?? 0);
          break;
        case "cancelSearch":
          this.activeSearch?.abort();
          this.activeSearch = undefined;
          break;
        case "open":
          if (message.id) {
            await this.detail.open(message.id, {
              query: message.query,
              occurrence: message.occurrence
            });
          }
          break;
        case "rename":
          if (message.id) {
            await this.renameConversation(message.id);
          }
          break;
        case "delete":
          if (message.id) {
            await this.deleteConversation(message.id);
          }
          break;
        case "unarchive":
          if (message.id) {
            await this.unarchiveConversation(message.id);
          }
          break;
        case "archive":
          if (message.id) {
            await this.archiveConversation(message.id);
          }
          break;
        default:
          break;
      }
    });

    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    const conversations = await this.store.list("all");
    await this.view.webview.postMessage({
      type: "conversations",
      conversations: conversations.map((item) => this.toViewModel(item))
    });
  }

  private async searchContent(query: string, requestId: number): Promise<void> {
    if (!this.view) {
      return;
    }
    this.activeSearch?.abort();
    const controller = new AbortController();
    this.activeSearch = controller;
    const parsed = parseSearchQuery(query);
    let lastProgressAt = 0;

    try {
      const results = await this.store.search(query, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (this.activeSearch !== controller || controller.signal.aborted) {
            return;
          }
          const now = Date.now();
          const complete = progress.completed >= progress.total;
          if (!complete && now - lastProgressAt < 80) {
            return;
          }
          lastProgressAt = now;
          void this.view?.webview.postMessage({
            type: "searchProgress",
            query,
            requestId,
            progress
          });
        }
      });
      if (this.activeSearch !== controller || controller.signal.aborted) {
        return;
      }
      await this.view.webview.postMessage({
        type: "searchResults",
        query,
        requestId,
        terms: parsed.terms,
        filters: { archived: parsed.archived },
        results
      });
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || this.activeSearch !== controller) {
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      await this.view.webview.postMessage({
        type: "searchError",
        query,
        requestId,
        error: text
      });
    } finally {
      if (this.activeSearch === controller) {
        this.activeSearch = undefined;
      }
    }
  }

  private async archiveConversation(id: string): Promise<void> {
    try {
      await this.store.archive(id);
      await this.refresh();
      void vscode.window.showInformationMessage("已归档。");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`归档失败：${text}`);
    }
  }

  private async unarchiveConversation(id: string): Promise<void> {
    try {
      await this.store.unarchive(id);
      await this.refresh();
      void vscode.window.showInformationMessage("已取消归档。");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`取消归档失败：${text}`);
    }
  }

  private async renameConversation(id: string): Promise<void> {
    const current = (await this.store.list("all")).find((item) => item.id === id);
    if (!current) {
      void vscode.window.showWarningMessage("未找到该对话。");
      return;
    }
    const title = await vscode.window.showInputBox({
      title: "重命名对话",
      prompt: "输入新的对话标题",
      value: current.title,
      valueSelection: [0, current.title.length],
      validateInput: (value) => (value.trim() ? undefined : "标题不能为空")
    });
    if (title == null) {
      return;
    }
    try {
      await this.store.rename(id, title);
      await this.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`重命名失败：${text}`);
    }
  }

  private async deleteConversation(id: string): Promise<void> {
    try {
      await this.store.delete(id);
      await this.refresh();
      void vscode.window.showWarningMessage(
        "已从本地记录中删除。若 Codex 窗口仍显示该对话，请先关掉它或重载 Codex：官方插件会把当前打开的会话缓存在内存里，并可能写回磁盘。"
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`删除失败：${text}`);
    }
  }

  private toViewModel(item: ConversationSummary): SidebarConversation {
    const cwd = item.cwd?.trim() || "";
    return {
      id: item.id,
      title: item.title,
      preview: item.preview,
      archived: item.archived,
      running: item.running,
      updatedAt: item.updatedAt?.toISOString(),
      cwd: cwd || undefined,
      project: cwd ? path.basename(cwd) : "未分类"
    };
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.css"));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sidebar.js"));

    return `<!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
          <link rel="stylesheet" href="${styleUri}" />
        </head>
        <body>
          <div class="wrap">
            <div class="header">
              <h1>聊天</h1>
              <button class="icon-btn" id="refresh" title="刷新">↻</button>
            </div>
            <label class="search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/>
                <path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              <input id="search" type="search" placeholder="搜索标题或对话内容" title="支持 project:、role:、is:archived、after:YYYY-MM-DD" />
            </label>
            <div class="filters">
              <button class="filter" data-filter="all">全部对话</button>
              <button class="filter active" data-filter="active">未归档</button>
              <button class="filter" data-filter="archived">已归档</button>
            </div>
            <div class="list" id="list"></div>
          </div>
          <div class="menu" id="menu" hidden>
            <button type="button" data-menu="rename">重命名</button>
            <button type="button" data-menu="archive">归档</button>
            <button type="button" data-menu="unarchive">取消归档</button>
            <button type="button" data-menu="delete" class="danger">删除</button>
          </div>
          <div class="modal" id="modal">
            <div class="dialog">
              <h2>删除对话</h2>
              <p id="modal-text">确定删除该对话吗？删除后无法恢复。</p>
              <div class="actions">
                <button class="cancel" id="cancel-delete">取消</button>
                <button class="confirm" id="confirm-delete">删除</button>
              </div>
            </div>
          </div>
          <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
      </html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
