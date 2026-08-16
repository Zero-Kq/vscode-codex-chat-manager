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
  running?: boolean;
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

export interface SearchHit {
  text: string;
  role: "title" | "user" | "assistant";
  occurrence: number;
}

export interface SearchResult {
  id: string;
  title: string;
  archived: boolean;
  running?: boolean;
  cwd?: string;
  project?: string;
  hits: SearchHit[];
}

export interface ConversationStore {
  list(filter?: ArchiveFilter): Promise<ConversationSummary[]>;
  get(id: string): Promise<ConversationDetail | undefined>;
  search(query: string): Promise<SearchResult[]>;
  delete(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  archive(id: string): Promise<void>;
  watchRoots(): string[];
}
