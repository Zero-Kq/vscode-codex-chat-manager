import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { matchesSearchMetadata, parseSearchQuery } from "../search/searchQuery";
import { isAbortError, SessionSearchIndex } from "../search/sessionSearchIndex";
import { querySqlite, sqlString } from "./sqlite";
import {
  ArchiveFilter,
  ConversationDetail,
  ConversationMessage,
  ConversationStore,
  ConversationSummary,
  SearchHit,
  SearchOptions,
  SearchResult
} from "./types";

interface SessionIndexEntry {
  id?: string;
  thread_name?: string;
  title?: string;
  updated_at?: string;
}

interface ThreadRow {
  [key: string]: unknown;
  id?: unknown;
  title?: unknown;
  preview?: unknown;
  cwd?: unknown;
  source?: unknown;
  rollout_path?: unknown;
  created_at?: unknown;
  created_at_ms?: unknown;
  updated_at?: unknown;
  updated_at_ms?: unknown;
  recency_at?: unknown;
  recency_at_ms?: unknown;
  archived?: unknown;
  archived_at?: unknown;
  first_user_message?: unknown;
  agent_nickname?: unknown;
  agent_role?: unknown;
  thread_source?: unknown;
}

function expandHome(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function asDate(value: unknown): Date | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const text = String(value);
  if (/^\d+$/.test(text)) {
    return asDate(Number(text));
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = asString(value).trim().toLowerCase();
  return text === "1" || text === "true";
}

function isRolloutName(name: string): boolean {
  return name.startsWith("rollout-");
}

function titleFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function looksArchivedPath(filePath: string): boolean {
  return filePath.split(path.sep).includes("archived_sessions");
}

function toActiveSessionPath(filePath: string): string {
  const parts = filePath.split(path.sep);
  const index = parts.lastIndexOf("archived_sessions");
  if (index === -1) {
    return filePath;
  }
  parts[index] = "sessions";
  return parts.join(path.sep);
}

function toArchivedSessionPath(filePath: string): string {
  const parts = filePath.split(path.sep);
  if (parts.includes("archived_sessions")) {
    return filePath;
  }
  const index = parts.lastIndexOf("sessions");
  if (index === -1) {
    return filePath;
  }
  parts[index] = "archived_sessions";
  return parts.join(path.sep);
}

function isHiddenSource(source: string): boolean {
  const normalized = source.trim().toLowerCase();
  return (
    normalized === "exec" ||
    normalized.includes("subagent") ||
    normalized.startsWith("internal")
  );
}

function isInternalHistoryPrompt(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  return (
    value.includes("Codex agent history whose request action you are assessing") ||
    value.startsWith("The following is the Codex agent history") ||
    /^the following is the codex\b/i.test(value)
  );
}

const INJECTED_CONTEXT_TAGS = [
  "recommended_plugins",
  "skills_instructions",
  "INSTRUCTIONS",
  "environment_context",
  "permissions instructions",
  "collaboration_mode",
  "apps_instructions",
  "plugins_instructions"
];

function stripInjectedContext(text: string): string {
  let value = text;
  for (const tag of INJECTED_CONTEXT_TAGS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    value = value.replace(new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}>`, "gi"), "");
  }
  value = value.replace(/^# AGENTS\.md instructions for[^\n]*\n*/gm, "");
  return value.trim();
}

function isInjectedContext(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  if (isInternalHistoryPrompt(value)) {
    return true;
  }
  return (
    value.startsWith("<recommended_plugins>") ||
    value.startsWith("<skills_instructions>") ||
    value.startsWith("<INSTRUCTIONS>") ||
    value.startsWith("<environment_context>") ||
    value.startsWith("<permissions") ||
    value.startsWith("<collaboration_mode>") ||
    value.startsWith("<apps_instructions>") ||
    value.startsWith("<plugins_instructions>") ||
    value.startsWith("# AGENTS.md instructions")
  );
}

function isDisplayableTitle(title: string): boolean {
  const value = stripInjectedContext(title);
  return Boolean(value) && !isRolloutName(value) && !isInternalHistoryPrompt(value) && !isInjectedContext(value);
}

function flattenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function makeSnippet(text: string, index: number, length: number, radius = 36): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${flattenText(text.slice(start, end))}${suffix}`;
}

function collectHits(text: string, query: string, role: SearchHit["role"], occurrence = -1): SearchHit[] {
  if (!text.trim() || !query) {
    return [];
  }
  const needle = query.toLowerCase();
  const lower = text.toLowerCase();
  const hits: SearchHit[] = [];
  let from = 0;
  let nextOccurrence = occurrence;
  while (hits.length < 40) {
    const index = lower.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    const current = nextOccurrence < 0 ? -1 : nextOccurrence++;
    hits.push({ text: makeSnippet(text, index, query.length), role, occurrence: current, query });
    from = index + Math.max(query.length, 1);
  }
  return hits;
}

function isExplicitTitle(title: string, firstUserMessage?: string): boolean {
  if (!isDisplayableTitle(title)) {
    return false;
  }
  const firstMessage = firstUserMessage?.trim() ?? "";
  return !(firstMessage && title.trim() === firstMessage);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class CodexSessionStore implements ConversationStore {
  private readonly searchIndex: SessionSearchIndex;
  private readonly runningCache = new Map<string, { size: number; mtimeMs: number; running: boolean }>();

  constructor(
    private readonly getConfig = () => vscode.workspace.getConfiguration("codexChatManager"),
    cacheRoot?: string
  ) {
    this.searchIndex = new SessionSearchIndex(cacheRoot ? path.join(cacheRoot, "search-index-v1") : undefined);
  }

  private codexHome(): string {
    const configured = this.getConfig().get<string>("codexHome")?.trim();
    return expandHome(configured || path.join(os.homedir(), ".codex"));
  }

  private sessionsDir(): string {
    const configured = this.getConfig().get<string>("sessionsDir")?.trim();
    return expandHome(configured || path.join(this.codexHome(), "sessions"));
  }

  private archivedDir(): string {
    return path.join(this.codexHome(), "archived_sessions");
  }

  private indexFile(): string {
    const configured = this.getConfig().get<string>("indexFile")?.trim();
    return expandHome(configured || path.join(this.codexHome(), "session_index.jsonl"));
  }

  private stateDb(): string {
    return path.join(this.codexHome(), "state_5.sqlite");
  }

  watchRoots(): string[] {
    return [this.codexHome()];
  }

  async list(filter: ArchiveFilter = "all"): Promise<ConversationSummary[]> {
    const titles = await this.loadIndexTitles();
    let items = await this.listFromSqlite(titles);
    if (items.length === 0) {
      items = await this.listFromFilesystem(titles);
    }
    const visible = items.filter((item) => this.matchesFilter(item, filter));
    const withStatus = await mapWithConcurrency(visible, 24, async (item) => ({
      ...item,
      running: await this.isTurnRunning(item.sourcePath)
    }));
    return this.sort(withStatus);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const parsed = parseSearchQuery(query);
    if (parsed.errors.length > 0) {
      throw new Error(parsed.errors.join("；"));
    }
    if (parsed.terms.length === 0 && parsed.projects.length === 0 && parsed.roles.length === 0 && parsed.archived === undefined && !parsed.after) {
      return [];
    }

    const allItems = await this.list("all");
    const candidates = allItems.filter((item) =>
      matchesSearchMetadata(parsed, {
        ...item,
        project: item.cwd ? path.basename(item.cwd) : "未分类"
      })
    );
    let indexed = 0;
    let reused = 0;
    const indexedItems = await this.searchIndex.sync(candidates, (record) => this.normalizeMessage(record), {
      signal: options.signal,
      onProgress: (progress) => {
        indexed = progress.indexed;
        reused = progress.reused;
        options.onProgress?.(progress);
      },
      prune: candidates.length === allItems.length
    });

    const results: SearchResult[] = [];
    for (let itemIndex = 0; itemIndex < indexedItems.length; itemIndex += 1) {
      if (options.signal?.aborted) {
        const error = new Error("Search cancelled");
        error.name = "AbortError";
        throw error;
      }
      const entry = indexedItems[itemIndex];
      const item = entry.summary;
      const hits = this.searchIndexedConversation(item, entry.messages, parsed.terms, parsed.roles);
      const hasSelectedRole = parsed.roles.length === 0 || entry.messages.some(
        (message) => (message.role === "user" || message.role === "assistant") && parsed.roles.includes(message.role)
      );
      if (hasSelectedRole && (parsed.terms.length === 0 || parsed.terms.every((term) => hits.some((hit) => hit.query.toLowerCase() === term.toLowerCase())))) {
        results.push({
          id: item.id,
          title: item.title,
          archived: item.archived,
          running: item.running,
          cwd: item.cwd,
          project: item.cwd ? path.basename(item.cwd) : "未分类",
          hits: hits.length > 0 ? hits.slice(0, 30) : [{ text: item.title, role: "title", occurrence: -1, query: "" }]
        });
      }
      options.onProgress?.({
        phase: "searching",
        completed: itemIndex + 1,
        total: indexedItems.length,
        indexed,
        reused,
        current: item.title
      });
    }
    return results;
  }

  private searchIndexedConversation(
    item: ConversationSummary,
    messages: ConversationMessage[],
    terms: string[],
    roles: Array<"user" | "assistant">
  ): SearchHit[] {
    const hits: SearchHit[] = [];
    const restrictRole = roles.length > 0;

    for (const term of terms) {
      const titleHits = collectHits(item.title, term, "title");
      if (!restrictRole) {
        hits.push(...titleHits);
      }

      let occurrence = 0;
      let allowedMatches = restrictRole ? 0 : titleHits.length;
      for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") {
          continue;
        }
        const messageHits = collectHits(message.content, term, message.role, occurrence);
        occurrence += messageHits.length;
        if (!restrictRole || roles.includes(message.role)) {
          hits.push(...messageHits);
          allowedMatches += messageHits.length;
        }
      }

      if (allowedMatches === 0 && (!restrictRole || roles.includes("user")) && item.preview) {
        hits.push(...collectHits(item.preview, term, "user"));
      }
    }
    return hits;
  }

  async get(id: string): Promise<ConversationDetail | undefined> {
    const summaries = await this.list("all");
    const summary = summaries.find((item) => item.id === id);
    if (!summary) {
      return undefined;
    }
    return {
      summary,
      messages: await this.loadMessages(summary)
    };
  }

  async delete(id: string): Promise<void> {
    const summary = (await this.list("all")).find((item) => item.id === id);
    const ids = await this.collectRelatedThreadIds(id);
    if (summary) {
      ids.add(summary.id);
    } else {
      ids.add(id);
    }

    const files = new Set<string>();
    if (summary?.sourcePath) {
      files.add(summary.sourcePath);
    }
    for (const threadId of ids) {
      for (const filePath of await this.findRolloutFiles(threadId)) {
        files.add(filePath);
      }
    }

    for (const filePath of files) {
      await this.safeUnlink(filePath);
    }
    for (const threadId of ids) {
      await this.removeIndexEntries(threadId);
      await this.deleteSqliteThread(threadId);
      this.searchIndex.invalidate(threadId);
    }
  }

  async unarchive(id: string): Promise<void> {
    const summary = (await this.list("all")).find((item) => item.id === id);
    if (!summary) {
      throw new Error("未找到该对话。");
    }
    if (!summary.archived) {
      return;
    }
    const restoredPath = await this.relocateSessionFiles(id, summary.sourcePath, false);
    await this.setSqliteArchived(id, restoredPath, false);
    this.searchIndex.invalidate(id);
  }

  async rename(id: string, title: string): Promise<void> {
    const next = title.trim().split(/\r?\n/, 1)[0].slice(0, 80);
    if (!next) {
      throw new Error("标题不能为空。");
    }
    if (!isDisplayableTitle(next)) {
      throw new Error("标题无效。");
    }
    const summary = (await this.list("all")).find((item) => item.id === id);
    if (!summary) {
      throw new Error("未找到该对话。");
    }
    await this.setIndexTitle(id, next);
    await this.setSqliteTitle(id, next);
  }

  async archive(id: string): Promise<void> {
    const summary = (await this.list("all")).find((item) => item.id === id);
    if (!summary) {
      throw new Error("未找到该对话。");
    }
    if (summary.archived) {
      return;
    }
    const archivedPath = await this.relocateSessionFiles(id, summary.sourcePath, true);
    await this.setSqliteArchived(id, archivedPath, true);
    this.searchIndex.invalidate(id);
  }

  private async relocateSessionFiles(id: string, sourcePath: string, archived: boolean): Promise<string> {
    const files = [...new Set([...(await this.findRolloutFiles(id)), sourcePath].filter(Boolean))];
    let result = sourcePath;
    for (const filePath of files) {
      const destination = archived ? toArchivedSessionPath(filePath) : toActiveSessionPath(filePath);
      if (destination === filePath) {
        result = filePath;
        continue;
      }
      await fs.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fs.rename(filePath, destination);
        result = destination;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return result;
  }

  private async collectRelatedThreadIds(rootId: string): Promise<Set<string>> {
    const ids = new Set<string>([rootId]);
    const dbPath = this.stateDb();
    try {
      await fs.access(dbPath);
    } catch {
      return ids;
    }

    let rows: Record<string, unknown>[] = [];
    try {
      rows = await querySqlite<Record<string, unknown>>(
        dbPath,
        `SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges`
      );
    } catch {
      return ids;
    }

    const children = new Map<string, string[]>();
    for (const row of rows) {
      const parent = asString(row.parent_thread_id).trim();
      const child = asString(row.child_thread_id).trim();
      if (!parent || !child) {
        continue;
      }
      const list = children.get(parent) ?? [];
      list.push(child);
      children.set(parent, list);
    }

    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) {
        continue;
      }
      for (const child of children.get(current) ?? []) {
        if (!ids.has(child)) {
          ids.add(child);
          queue.push(child);
        }
      }
    }
    return ids;
  }

  private async findRolloutFiles(threadId: string): Promise<string[]> {
    const matches: string[] = [];
    for (const root of [this.sessionsDir(), this.archivedDir()]) {
      for (const filePath of await this.collectSessionFiles(root)) {
        if (filePath.includes(threadId) || this.idFromPath(filePath) === threadId) {
          matches.push(filePath);
        }
      }
    }
    return matches;
  }

  private matchesFilter(item: ConversationSummary, filter: ArchiveFilter): boolean {
    if (filter === "archived") {
      return item.archived;
    }
    if (filter === "active") {
      return !item.archived;
    }
    return true;
  }

  private async isTurnRunning(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      const cached = this.runningCache.get(filePath);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.running;
      }
      if (stat.size <= 0) {
        this.runningCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, running: false });
        return false;
      }

      const handle = await fs.open(filePath, "r");
      try {
        const chunk = Math.min(stat.size, 64 * 1024);
        const buffer = Buffer.alloc(chunk);
        await handle.read(buffer, 0, chunk, stat.size - chunk);
        const text = buffer.toString("utf8");
        const lines = text.split(/\r?\n/).slice(stat.size > chunk ? 1 : 0);
        let running = false;
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const record = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } };
            const kind = String(record.payload?.type ?? record.type ?? "");
            if (kind === "task_started") {
              running = true;
            } else if (kind === "task_complete" || kind === "turn_aborted" || kind === "turn_failed" || kind === "error") {
              running = false;
            }
          } catch {
            // 跳过截断或不完整的行
          }
        }
        this.runningCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, running });
        return running;
      } finally {
        await handle.close();
      }
    } catch {
      this.runningCache.delete(filePath);
      return false;
    }
  }

  private async listFromSqlite(titles: Map<string, string>): Promise<ConversationSummary[]> {
    const dbPath = this.stateDb();
    try {
      await fs.access(dbPath);
    } catch {
      return [];
    }

    let rows: ThreadRow[] = [];
    try {
      rows = await querySqlite<ThreadRow>(dbPath, `SELECT * FROM threads`);
    } catch {
      return [];
    }

    const childIds = await this.loadSpawnChildIds(dbPath);
    const items: ConversationSummary[] = [];
    for (const row of rows) {
      const summary = this.rowToSummary(row, titles);
      if (summary && this.isUserFacing(summary, row) && !childIds.has(summary.id)) {
        items.push(summary);
      }
    }
    return items;
  }

  private async loadSpawnChildIds(dbPath: string): Promise<Set<string>> {
    try {
      const rows = await querySqlite<Record<string, unknown>>(
        dbPath,
        `SELECT child_thread_id FROM thread_spawn_edges`
      );
      return new Set(rows.map((row) => asString(row.child_thread_id).trim()).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private rowToSummary(row: ThreadRow, titles: Map<string, string>): ConversationSummary | undefined {
    const id = asString(row.id).trim();
    const sourcePath = asString(row.rollout_path).trim();
    if (!id || !sourcePath) {
      return undefined;
    }

    const indexedTitle = titles.get(id);
    const dbTitle = asString(row.title).trim();
    const firstUserMessage = asString(row.first_user_message).trim();
    const preview = asString(row.preview).trim() || firstUserMessage;
    const title = this.pickTitle(indexedTitle, dbTitle, firstUserMessage || preview, sourcePath);
    const archived =
      isTruthyFlag(row.archived) || Boolean(asString(row.archived_at).trim()) || looksArchivedPath(sourcePath);

    return {
      id,
      title,
      preview,
      cwd: asString(row.cwd) || undefined,
      source: asString(row.source) || undefined,
      sourcePath,
      archived,
      createdAt: asDate(row.created_at_ms ?? row.created_at),
      updatedAt: asDate(row.recency_at_ms ?? row.recency_at ?? row.updated_at_ms ?? row.updated_at)
    };
  }

  private isUserFacing(summary: ConversationSummary, row?: ThreadRow): boolean {
    if (asString(row?.agent_nickname).trim() || asString(row?.agent_role).trim()) {
      return false;
    }
    const threadSource = asString(row?.thread_source).trim().toLowerCase();
    if (threadSource && threadSource !== "user") {
      return false;
    }
    if (isHiddenSource(summary.source || asString(row?.source)) || isHiddenSource(threadSource)) {
      return false;
    }
    if (isInternalHistoryPrompt(summary.title) || isInternalHistoryPrompt(summary.preview ?? "")) {
      return false;
    }
    if (isExplicitTitle(summary.title, asString(row?.first_user_message))) {
      return true;
    }
    const preview = (summary.preview || asString(row?.first_user_message)).trim();
    return Boolean(preview) && !isInternalHistoryPrompt(preview);
  }

  private async listFromFilesystem(titles: Map<string, string>): Promise<ConversationSummary[]> {
    const active = await this.collectSessionFiles(this.sessionsDir());
    const archived = await this.collectSessionFiles(this.archivedDir());
    const items: ConversationSummary[] = [];

    for (const filePath of active) {
      items.push(await this.fileToSummary(filePath, false, titles));
    }
    for (const filePath of archived) {
      items.push(await this.fileToSummary(filePath, true, titles));
    }

    return items.filter((item) => this.isUserFacing(item));
  }

  private async fileToSummary(
    filePath: string,
    archived: boolean,
    titles: Map<string, string>
  ): Promise<ConversationSummary> {
    const id = this.idFromPath(filePath);
    const stat = await fs.stat(filePath);
    const indexedTitle = titles.get(id);
    return {
      id,
      title: this.pickTitle(indexedTitle, undefined, undefined, filePath),
      cwd: undefined,
      sourcePath: filePath,
      archived: archived || looksArchivedPath(filePath),
      createdAt: stat.birthtime,
      updatedAt: stat.mtime
    };
  }

  private idFromPath(filePath: string): string {
    const name = titleFromPath(filePath);
    const match = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match?.[0] ?? filePath;
  }

  private pickTitle(
    indexedTitle: string | undefined,
    dbTitle: string | undefined,
    firstUserMessage: string | undefined,
    sourcePath: string
  ): string {
    const candidates = [indexedTitle, dbTitle, firstUserMessage].map((value) => value?.trim() ?? "");
    for (const candidate of candidates) {
      if (isDisplayableTitle(candidate)) {
        return candidate.split(/\r?\n/, 1)[0].slice(0, 80);
      }
    }
    return titleFromPath(sourcePath);
  }

  private async loadIndexTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    let raw: string;
    try {
      raw = await fs.readFile(this.indexFile(), "utf8");
    } catch {
      return titles;
    }

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as SessionIndexEntry;
        const id = entry.id?.trim();
        const name = (entry.thread_name || entry.title || "").trim();
        if (id && isDisplayableTitle(name)) {
          titles.set(id, name);
        }
      } catch {
        // 跳过损坏的索引行
      }
    }
    return titles;
  }

  private async collectSessionFiles(root: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.collectSessionFiles(fullPath)));
      } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private async loadMessages(item: ConversationSummary): Promise<ConversationMessage[]> {
    try {
      return await this.searchIndex.messagesFor(item, (record) => this.normalizeMessage(record));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return [];
    }
  }

  private normalizeMessage(record: Record<string, unknown>): ConversationMessage | undefined {
    const type = String(record.type ?? record.kind ?? "");
    if (type === "session_meta" || type === "turn_context" || type === "compacted") {
      return undefined;
    }

    const payload = (record.payload ?? record.message ?? record) as Record<string, unknown>;
    const payloadType = String(payload.type ?? "");
    if (payloadType && payloadType !== "message" && payloadType !== "agent_message" && payloadType !== "user_message") {
      if (type === "event_msg") {
        return undefined;
      }
    }

    const role = this.extractRole(record);
    if (role !== "user" && role !== "assistant") {
      return undefined;
    }
    const content = stripInjectedContext(this.extractContent(record));
    if (!content || isInjectedContext(content) || isInternalHistoryPrompt(content)) {
      return undefined;
    }

    return {
      role,
      content,
      timestamp: asDate(record.timestamp ?? record.created_at)
    };
  }

  private extractRole(record: Record<string, unknown>): ConversationMessage["role"] {
    const payload = (record.payload ?? record.message ?? record) as Record<string, unknown>;
    const role = String(payload.role ?? record.role ?? "").toLowerCase();
    if (role === "developer" || role === "system" || role === "tool") {
      return "system";
    }
    if (role === "user" || role === "assistant") {
      return role;
    }
    const type = String(payload.type ?? record.type ?? "").toLowerCase();
    if (type.includes("user")) {
      return "user";
    }
    if (type.includes("agent") || type.includes("assistant")) {
      return "assistant";
    }
    return "unknown";
  }

  private extractContent(record: Record<string, unknown>): string {
    const payload = (record.payload ?? record.message ?? record) as Record<string, unknown>;
    const content = payload.content ?? record.content ?? payload.text ?? record.text;
    if (typeof content === "string") {
      return content.trim();
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (part && typeof part === "object" && "text" in part) {
            return String((part as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .join("\n")
        .trim();
    }
    return "";
  }

  private async setIndexTitle(id: string, title: string): Promise<void> {
    const indexPath = this.indexFile();
    let raw = "";
    try {
      raw = await fs.readFile(indexPath, "utf8");
    } catch {
      raw = "";
    }

    let found = false;
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    const next = lines.map((line) => {
      try {
        const entry = JSON.parse(line) as SessionIndexEntry;
        if (entry.id !== id) {
          return line;
        }
        found = true;
        return JSON.stringify({
          ...entry,
          thread_name: title,
          title,
          updated_at: new Date().toISOString()
        });
      } catch {
        return line;
      }
    });
    if (!found) {
      next.push(
        JSON.stringify({
          id,
          thread_name: title,
          title,
          updated_at: new Date().toISOString()
        })
      );
    }
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, next.length ? `${next.join("\n")}\n` : "");
  }

  private async setSqliteTitle(id: string, title: string): Promise<void> {
    const dbPath = this.stateDb();
    try {
      await fs.access(dbPath);
    } catch {
      return;
    }

    const quotedId = sqlString(id);
    const quotedTitle = sqlString(title);
    try {
      await querySqlite(
        dbPath,
        `UPDATE threads SET title = ${quotedTitle}, name = ${quotedTitle} WHERE id = ${quotedId}`,
        false
      );
    } catch {
      await querySqlite(dbPath, `UPDATE threads SET title = ${quotedTitle} WHERE id = ${quotedId}`, false);
    }
  }

  private async removeIndexEntries(id: string): Promise<void> {
    const indexPath = this.indexFile();
    let raw: string;
    try {
      raw = await fs.readFile(indexPath, "utf8");
    } catch {
      return;
    }

    const kept = raw
      .split(/\r?\n/)
      .filter((line) => {
        if (!line.trim()) {
          return false;
        }
        try {
          const entry = JSON.parse(line) as SessionIndexEntry;
          return entry.id !== id;
        } catch {
          return true;
        }
      })
      .join("\n");

    await fs.writeFile(indexPath, kept ? `${kept}\n` : "");
  }

  private async deleteSqliteThread(id: string): Promise<void> {
    const dbPath = this.stateDb();
    try {
      await fs.access(dbPath);
    } catch {
      return;
    }

    const quoted = sqlString(id);
    try {
      await querySqlite(
        dbPath,
        `DELETE FROM thread_spawn_edges WHERE parent_thread_id = ${quoted} OR child_thread_id = ${quoted}`,
        false
      );
    } catch {
      // 旧库可能没有该表
    }
    await querySqlite(dbPath, `DELETE FROM threads WHERE id = ${quoted}`, false);
  }

  private async setSqliteArchived(id: string, rolloutPath: string, archived: boolean): Promise<void> {
    const dbPath = this.stateDb();
    try {
      await fs.access(dbPath);
    } catch {
      return;
    }

    const quotedId = sqlString(id);
    const quotedPath = sqlString(rolloutPath);
    const archivedFlag = archived ? 1 : 0;
    const archivedAt = archived ? "strftime('%s','now')" : "NULL";
    try {
      await querySqlite(
        dbPath,
        `UPDATE threads SET archived = ${archivedFlag}, archived_at = ${archivedAt}, rollout_path = ${quotedPath} WHERE id = ${quotedId}`,
        false
      );
    } catch {
      await querySqlite(
        dbPath,
        `UPDATE threads SET archived = ${archivedFlag}, rollout_path = ${quotedPath} WHERE id = ${quotedId}`,
        false
      );
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }
  }

  private sort(items: ConversationSummary[]): ConversationSummary[] {
    return items.sort((a, b) => {
      if (Boolean(a.running) !== Boolean(b.running)) {
        return a.running ? -1 : 1;
      }
      const left = (b.updatedAt ?? b.createdAt)?.getTime() ?? 0;
      const right = (a.updatedAt ?? a.createdAt)?.getTime() ?? 0;
      return left - right;
    });
  }
}
