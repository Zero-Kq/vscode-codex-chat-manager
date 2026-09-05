import { createHash } from "crypto";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { ConversationMessage, ConversationSummary, SearchProgress } from "../stores/types";

const CACHE_VERSION = 1;

interface FileFingerprint {
  sourcePath: string;
  size: number;
  mtimeMs: number;
}

export interface IndexedConversation extends FileFingerprint {
  summary: ConversationSummary;
  messages: ConversationMessage[];
}

interface PersistedMessage {
  role: ConversationMessage["role"];
  content: string;
  timestamp?: string;
}

interface PersistedCacheEntry extends FileFingerprint {
  version: number;
  messages: PersistedMessage[];
}

interface ManifestEntry extends FileFingerprint {
  cacheFile: string;
}

interface CacheManifest {
  version: number;
  entries: ManifestEntry[];
}

export interface IndexSyncOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SearchProgress) => void;
  prune?: boolean;
}

type MessageParser = (record: Record<string, unknown>) => ConversationMessage | undefined;

export class SessionSearchIndex {
  private readonly entriesById = new Map<string, IndexedConversation>();
  private readonly manifest = new Map<string, ManifestEntry>();
  private manifestLoaded = false;
  private manifestDirty = false;

  constructor(private readonly cacheRoot?: string) {}

  async sync(
    items: ConversationSummary[],
    parseMessage: MessageParser,
    options: IndexSyncOptions = {}
  ): Promise<IndexedConversation[]> {
    await this.ensureManifestLoaded();
    const next: IndexedConversation[] = [];
    const activeIds = new Set<string>();
    const activePaths = new Set(items.map((item) => item.sourcePath));
    let indexed = 0;
    let reused = 0;

    try {
      for (let index = 0; index < items.length; index += 1) {
        throwIfAborted(options.signal);
        const item = items[index];
        activeIds.add(item.id);
        const entry = await this.loadEntry(item, parseMessage, options.signal);
        if (entry) {
          next.push(entry.value);
          if (entry.reused) {
            reused += 1;
          } else {
            indexed += 1;
          }
        }
        options.onProgress?.({
          phase: "indexing",
          completed: index + 1,
          total: items.length,
          indexed,
          reused,
          current: item.title
        });
      }

      if (options.prune) {
        for (const id of this.entriesById.keys()) {
          if (!activeIds.has(id)) {
            this.entriesById.delete(id);
          }
        }
        await this.pruneManifest(activePaths);
      }
      await this.saveManifest();
      return next;
    } catch (error) {
      await this.saveManifest();
      throw error;
    }
  }

  async messagesFor(
    item: ConversationSummary,
    parseMessage: MessageParser,
    signal?: AbortSignal
  ): Promise<ConversationMessage[]> {
    await this.ensureManifestLoaded();
    const entry = await this.loadEntry(item, parseMessage, signal);
    await this.saveManifest();
    return entry?.value.messages ?? [];
  }

  invalidate(id?: string): void {
    if (id) {
      this.entriesById.delete(id);
      return;
    }
    this.entriesById.clear();
  }

  private async loadEntry(
    item: ConversationSummary,
    parseMessage: MessageParser,
    signal?: AbortSignal
  ): Promise<{ value: IndexedConversation; reused: boolean } | undefined> {
    let stat;
    try {
      stat = await fs.stat(item.sourcePath);
    } catch {
      this.entriesById.delete(item.id);
      return undefined;
    }
    throwIfAborted(signal);

    const fingerprint: FileFingerprint = {
      sourcePath: item.sourcePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
    const existing = this.entriesById.get(item.id);
    if (existing && sameFingerprint(existing, fingerprint)) {
      existing.summary = item;
      return { value: existing, reused: true };
    }

    const cached = await this.readPersistedEntry(fingerprint, signal);
    if (cached) {
      const value = { ...fingerprint, summary: item, messages: cached };
      this.entriesById.set(item.id, value);
      return { value, reused: true };
    }

    let messages: ConversationMessage[];
    try {
      messages = await streamJsonlMessages(item.sourcePath, parseMessage, signal);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      messages = [];
    }
    throwIfAborted(signal);

    const value = { ...fingerprint, summary: item, messages };
    this.entriesById.set(item.id, value);
    await this.persistEntry(value);
    return { value, reused: false };
  }

  private async ensureManifestLoaded(): Promise<void> {
    if (this.manifestLoaded) {
      return;
    }
    this.manifestLoaded = true;
    if (!this.cacheRoot) {
      return;
    }
    try {
      const raw = await fs.readFile(this.manifestPath(), "utf8");
      const parsed = JSON.parse(raw) as CacheManifest;
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const entry of parsed.entries) {
        if (entry.sourcePath && entry.cacheFile) {
          this.manifest.set(entry.sourcePath, entry);
        }
      }
    } catch {
      // 首次运行或缓存损坏时重新建立。
    }
  }

  private async readPersistedEntry(
    fingerprint: FileFingerprint,
    signal?: AbortSignal
  ): Promise<ConversationMessage[] | undefined> {
    if (!this.cacheRoot) {
      return undefined;
    }
    const manifestEntry = this.manifest.get(fingerprint.sourcePath);
    if (!manifestEntry || !sameFingerprint(manifestEntry, fingerprint)) {
      return undefined;
    }
    throwIfAborted(signal);
    try {
      const raw = await fs.readFile(path.join(this.cacheRoot, manifestEntry.cacheFile), "utf8");
      throwIfAborted(signal);
      const parsed = JSON.parse(raw) as PersistedCacheEntry;
      if (parsed.version !== CACHE_VERSION || !sameFingerprint(parsed, fingerprint) || !Array.isArray(parsed.messages)) {
        return undefined;
      }
      return parsed.messages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp ? new Date(message.timestamp) : undefined
      }));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.manifest.delete(fingerprint.sourcePath);
      this.manifestDirty = true;
      return undefined;
    }
  }

  private async persistEntry(entry: IndexedConversation): Promise<void> {
    if (!this.cacheRoot) {
      return;
    }
    const cacheFile = `${createHash("sha256").update(entry.sourcePath).digest("hex")}.json`;
    const payload: PersistedCacheEntry = {
      version: CACHE_VERSION,
      sourcePath: entry.sourcePath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      messages: entry.messages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp?.toISOString()
      }))
    };
    await fs.mkdir(this.cacheRoot, { recursive: true });
    await writeFileAtomic(path.join(this.cacheRoot, cacheFile), JSON.stringify(payload));
    this.manifest.set(entry.sourcePath, {
      sourcePath: entry.sourcePath,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      cacheFile
    });
    this.manifestDirty = true;
  }

  private async pruneManifest(activePaths: Set<string>): Promise<void> {
    if (!this.cacheRoot) {
      return;
    }
    for (const [sourcePath, entry] of this.manifest) {
      if (activePaths.has(sourcePath)) {
        continue;
      }
      this.manifest.delete(sourcePath);
      this.manifestDirty = true;
      try {
        await fs.unlink(path.join(this.cacheRoot, entry.cacheFile));
      } catch {
        // 缓存文件可能已经不存在。
      }
    }
  }

  private async saveManifest(): Promise<void> {
    if (!this.cacheRoot || !this.manifestDirty) {
      return;
    }
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const payload: CacheManifest = {
      version: CACHE_VERSION,
      entries: [...this.manifest.values()]
    };
    await writeFileAtomic(this.manifestPath(), JSON.stringify(payload));
    this.manifestDirty = false;
  }

  private manifestPath(): string {
    return path.join(this.cacheRoot ?? "", "manifest.json");
  }
}

async function streamJsonlMessages(
  filePath: string,
  parseMessage: MessageParser,
  signal?: AbortSignal
): Promise<ConversationMessage[]> {
  throwIfAborted(signal);
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const abort = (): void => {
    input.destroy(createAbortError());
  };
  signal?.addEventListener("abort", abort, { once: true });
  const messages: ConversationMessage[] = [];

  try {
    for await (const line of lines) {
      throwIfAborted(signal);
      if (!line.trim()) {
        continue;
      }
      try {
        const message = parseMessage(JSON.parse(line) as Record<string, unknown>);
        if (message) {
          messages.push(message);
        }
      } catch {
        // 跳过截断、损坏或不相关的 JSONL 行。
      }
    }
    return messages;
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    lines.close();
    input.destroy();
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.sourcePath === right.sourcePath && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error("Search cancelled");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, filePath);
}
