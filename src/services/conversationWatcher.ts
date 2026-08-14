import * as vscode from "vscode";
import { ConversationStore, ConversationSummary } from "../stores/types";

export class ConversationWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private fingerprint = "";
  private disposed = false;

  constructor(
    private readonly store: ConversationStore,
    private readonly onChange: () => Promise<void> | void,
    private readonly pollMs = 2000
  ) {}

  start(): void {
    for (const root of this.store.watchRoots()) {
      const base = vscode.Uri.file(root);
      this.watch(base, "sessions/**");
      this.watch(base, "archived_sessions/**");
      this.watch(base, "session_index.jsonl");
      this.watch(base, "state_5.sqlite");
      this.watch(base, "state_5.sqlite-wal");
    }

    this.pollTimer = setInterval(() => {
      void this.checkForChanges();
    }, this.pollMs);
    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
    void this.checkForChanges();
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private watch(base: vscode.Uri, pattern: string): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
    watcher.onDidCreate(() => this.scheduleCheck());
    watcher.onDidChange(() => this.scheduleCheck());
    watcher.onDidDelete(() => this.scheduleCheck());
    this.disposables.push(watcher);
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.checkForChanges();
    }, 400);
  }

  private async checkForChanges(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const conversations = await this.store.list("all");
      const next = fingerprint(conversations);
      if (next === this.fingerprint) {
        return;
      }
      this.fingerprint = next;
      await this.onChange();
    } catch {
      // 读取失败时保持当前列表，下一轮再试
    }
  }
}

function fingerprint(conversations: ConversationSummary[]): string {
  return conversations
    .map((item) => `${item.id}|${item.title}|${item.archived ? 1 : 0}|${item.updatedAt?.getTime() ?? 0}`)
    .join("\n");
}
