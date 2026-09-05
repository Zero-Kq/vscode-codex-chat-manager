import * as path from "path";
import * as vscode from "vscode";
import {
  ConversationMetadata,
  ConversationMetadataSnapshot,
  ConversationMetadataStore
} from "../metadata/conversationMetadataStore";
import { parseSearchQuery } from "../search/searchQuery";
import { isAbortError } from "../search/sessionSearchIndex";
import { ConversationStore, ConversationSummary, SearchResult } from "../stores/types";
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
  projectKey: string;
  favorite: boolean;
  pinned: boolean;
  tags: string[];
  note: string;
}

interface SidebarMessage {
  type?: string;
  id?: string;
  query?: string;
  occurrence?: number;
  requestId?: number;
  tag?: string;
}

const EMPTY_METADATA: ConversationMetadata = {
  favorite: false,
  pinned: false,
  tags: [],
  note: "",
  projectKey: "",
  updatedAt: ""
};

export class ConversationSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codexChatManager.sidebar";
  private view?: vscode.WebviewView;
  private activeSearch?: AbortController;

  constructor(
    private readonly store: ConversationStore,
    private readonly metadata: ConversationMetadataStore,
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

    webviewView.webview.onDidReceiveMessage(async (message: SidebarMessage) => {
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
        case "continue":
          if (message.id) {
            await this.continueInCodex(message.id);
          }
          break;
        case "favorite":
          if (message.id) {
            await this.toggleFavorite(message.id);
          }
          break;
        case "pin":
          if (message.id) {
            await this.togglePinned(message.id);
          }
          break;
        case "toggleTag":
          if (message.id && message.tag) {
            await this.toggleTag(message.id, message.tag);
          }
          break;
        case "newTag":
          if (message.id) {
            await this.createTag(message.id);
          }
          break;
        case "note":
          if (message.id) {
            await this.editNote(message.id);
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
    const [conversations, metadata] = await Promise.all([
      this.store.list("all"),
      this.metadata.snapshot()
    ]);
    await this.view.webview.postMessage({
      type: "conversations",
      conversations: conversations.map((item) => this.toViewModel(item, metadata)),
      globalTags: metadata.globalTags
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
      const [results, metadata] = await Promise.all([
        this.store.search(query, {
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
        }),
        this.metadata.snapshot()
      ]);
      if (this.activeSearch !== controller || controller.signal.aborted) {
        return;
      }
      await this.view.webview.postMessage({
        type: "searchResults",
        query,
        requestId,
        terms: parsed.terms,
        filters: { archived: parsed.archived },
        results: results.map((result) => this.decorateSearchResult(result, metadata)),
        globalTags: metadata.globalTags
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

  private async toggleFavorite(id: string): Promise<void> {
    const context = await this.conversationContext(id);
    if (!context) {
      return;
    }
    await this.metadata.update(id, context.projectKey, { favorite: !context.metadata.favorite });
    await this.refresh();
  }

  private async togglePinned(id: string): Promise<void> {
    const context = await this.conversationContext(id);
    if (!context) {
      return;
    }
    await this.metadata.update(id, context.projectKey, { pinned: !context.metadata.pinned });
    await this.refresh();
  }

  private async toggleTag(id: string, tag: string): Promise<void> {
    const context = await this.conversationContext(id);
    if (!context) {
      return;
    }
    const normalized = tag.trim();
    if (!normalized) {
      return;
    }
    const key = normalized.toLocaleLowerCase();
    const existingIndex = context.metadata.tags.findIndex((value) => value.toLocaleLowerCase() === key);
    const tags = [...context.metadata.tags];
    if (existingIndex >= 0) {
      tags.splice(existingIndex, 1);
    } else {
      if (tags.length >= 12) {
        void vscode.window.showWarningMessage("每个对话最多设置 12 个标签。");
        return;
      }
      tags.push(normalized);
    }
    await this.metadata.update(id, context.projectKey, { tags });
    await this.refresh();
  }

  private async createTag(id: string): Promise<void> {
    const context = await this.conversationContext(id);
    if (!context) {
      return;
    }
    if (context.metadata.tags.length >= 12) {
      void vscode.window.showWarningMessage("每个对话最多设置 12 个标签。");
      return;
    }
    const available = await this.metadata.tags();
    const availableKeys = new Set(available.map((tag) => tag.toLocaleLowerCase()));
    const value = await vscode.window.showInputBox({
      title: `新建标签 · ${context.summary.title}`,
      prompt: "输入新标签名称；新建后会自动添加到当前对话。",
      placeHolder: "标签名称",
      validateInput: (input) => {
        const tag = input.trim();
        if (!tag) {
          return "标签名称不能为空";
        }
        if (tag.length > 40) {
          return "每个标签最多 40 个字符";
        }
        if (tag.includes(",") || tag.includes("，")) {
          return "每次只新建一个标签";
        }
        if (availableKeys.has(tag.toLocaleLowerCase())) {
          return "标签已存在，请直接从右键菜单选择";
        }
        return undefined;
      }
    });
    if (value == null) {
      return;
    }
    await this.metadata.update(id, context.projectKey, {
      tags: [...context.metadata.tags, value.trim()]
    });
    await this.refresh();
  }

  private async editNote(id: string): Promise<void> {
    const context = await this.conversationContext(id);
    if (!context) {
      return;
    }
    const note = await vscode.window.showInputBox({
      title: `编辑备注 · ${context.summary.title}`,
      prompt: "备注仅保存在本插件中；留空可删除备注。",
      value: context.metadata.note,
      validateInput: (value) => value.length > 2000 ? "备注最多 2000 个字符" : undefined
    });
    if (note == null) {
      return;
    }
    await this.metadata.update(id, context.projectKey, { note });
    await this.refresh();
  }

  private async continueInCodex(id: string): Promise<void> {
    const codex = vscode.extensions.getExtension("openai.chatgpt");
    if (!codex) {
      void vscode.window.showErrorMessage("未安装或未启用 OpenAI Codex 插件，无法继续该对话。");
      return;
    }
    try {
      await codex.activate();
      const resource = vscode.Uri.file(`/local/${id}`).with({
        scheme: "openai-codex",
        authority: "route"
      });
      await vscode.commands.executeCommand(
        "vscode.openWith",
        resource,
        "chatgpt.conversationEditor",
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false }
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`打开 Codex 对话失败：${text}`);
    }
  }

  private async conversationContext(id: string): Promise<{
    summary: ConversationSummary;
    projectKey: string;
    metadata: ConversationMetadata;
  } | undefined> {
    const summary = (await this.store.list("all")).find((item) => item.id === id);
    if (!summary) {
      void vscode.window.showWarningMessage("未找到该对话。");
      return undefined;
    }
    const projectKey = this.projectKey(summary);
    return {
      summary,
      projectKey,
      metadata: await this.metadata.get(id, projectKey)
    };
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
      await this.metadata.remove(id);
      await this.refresh();
      void vscode.window.showWarningMessage(
        "已从本地记录中删除。若 Codex 窗口仍显示该对话，请先关掉它或重载 Codex：官方插件会把当前打开的会话缓存在内存里，并可能写回磁盘。"
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`删除失败：${text}`);
    }
  }

  private projectKey(item: Pick<ConversationSummary, "cwd">): string {
    return item.cwd?.trim() || "未分类";
  }

  private toViewModel(item: ConversationSummary, snapshot: ConversationMetadataSnapshot): SidebarConversation {
    const cwd = item.cwd?.trim() || "";
    const projectKey = this.projectKey(item);
    const metadata = snapshot.conversations[item.id] ?? EMPTY_METADATA;
    return {
      id: item.id,
      title: item.title,
      preview: item.preview,
      archived: item.archived,
      running: item.running,
      updatedAt: item.updatedAt?.toISOString(),
      cwd: cwd || undefined,
      project: cwd ? path.basename(cwd) : "未分类",
      projectKey,
      favorite: metadata.favorite,
      pinned: metadata.pinned,
      tags: metadata.tags,
      note: metadata.note
    };
  }

  private decorateSearchResult(result: SearchResult, snapshot: ConversationMetadataSnapshot): SearchResult & {
    favorite: boolean;
    pinned: boolean;
    tags: string[];
    note: string;
    projectKey: string;
  } {
    const metadata = snapshot.conversations[result.id] ?? EMPTY_METADATA;
    return {
      ...result,
      favorite: metadata.favorite,
      pinned: metadata.pinned,
      tags: metadata.tags,
      note: metadata.note,
      projectKey: result.cwd?.trim() || "未分类"
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
              <button class="filter" data-filter="all">全部</button>
              <button class="filter active" data-filter="active">未归档</button>
              <button class="filter" data-filter="archived">已归档</button>
              <button class="filter" data-filter="favorite">★ 收藏</button>
            </div>
            <div class="list" id="list"></div>
            <div class="footer-hint">单击预览，双击回到 Codex 继续对话</div>
          </div>
          <div class="menu" id="menu" hidden>
            <button type="button" data-menu="continue">在 Codex 中继续</button>
            <button type="button" data-menu="favorite">收藏</button>
            <button type="button" data-menu="pin">置顶</button>
            <div class="menu-separator"></div>
            <div class="menu-submenu" id="tag-submenu">
              <button type="button" class="menu-submenu-trigger" aria-haspopup="menu">
                <span>标签</span><span class="menu-submenu-arrow">›</span>
              </button>
              <div class="menu-submenu-panel" id="tag-submenu-panel" role="menu">
                <div class="tag-menu-items" id="tag-menu-items"></div>
                <div class="menu-separator"></div>
                <button type="button" data-menu="newTag">＋ 新建标签…</button>
              </div>
            </div>
            <button type="button" data-menu="note">编辑备注…</button>
            <div class="menu-separator"></div>
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
