import * as vscode from "vscode";
import * as path from "path";
import { ConversationMetadataStore } from "./metadata/conversationMetadataStore";
import { ConversationSidebarProvider } from "./providers/conversationSidebarProvider";
import { ConversationDetailProvider } from "./providers/conversationWebviewProvider";
import { ConversationWatcher } from "./services/conversationWatcher";
import { CodexSessionStore } from "./stores/codexSessionStore";

export function activate(context: vscode.ExtensionContext): void {
  const store = new CodexSessionStore(undefined, context.globalStorageUri.fsPath);
  const metadata = new ConversationMetadataStore(
    path.join(context.globalStorageUri.fsPath, "conversation-metadata.json")
  );
  const detail = new ConversationDetailProvider(store);
  const sidebar = new ConversationSidebarProvider(store, metadata, context.extensionUri, detail);
  const watcher = new ConversationWatcher(store, () => sidebar.refresh());
  watcher.start();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConversationSidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("codexChatManager.refresh", () => sidebar.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexChatManager")) {
        void sidebar.refresh();
      }
    }),
    watcher
  );
}

export function deactivate(): void {}
