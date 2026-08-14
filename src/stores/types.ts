export type ArchiveFilter = "all" | "active" | "archived";

export interface ConversationSummary {
  id: string;
  title: string;
  preview?: string;
  createdAt?: Date;
  updatedAt?: Date;
  cwd?: string;
  source?: string;
  sourcePath: string;
  archived: boolean;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  content: string;
  timestamp?: Date;
}

export interface ConversationDetail {
  summary: ConversationSummary;
  messages: ConversationMessage[];
}

export interface ConversationStore {
  list(filter?: ArchiveFilter): Promise<ConversationSummary[]>;
  get(id: string): Promise<ConversationDetail | undefined>;
  delete(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  watchRoots(): string[];
}
