import * as fs from "fs/promises";
import * as path from "path";

export interface ConversationMetadata {
  favorite: boolean;
  pinned: boolean;
  tags: string[];
  note: string;
  projectKey: string;
  updatedAt: string;
}

export interface ConversationMetadataSnapshot {
  conversations: Record<string, ConversationMetadata>;
  globalTags: string[];
}

export type ConversationMetadataUpdate = Partial<Pick<ConversationMetadata, "favorite" | "pinned" | "tags" | "note">>;

const EMPTY_METADATA: Omit<ConversationMetadata, "projectKey" | "updatedAt"> = {
  favorite: false,
  pinned: false,
  tags: [],
  note: ""
};

function normalizeTags(values: unknown, limit = 12): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const tag = String(value).trim().slice(0, 40);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, limit);
}

function normalizeMetadata(value: unknown): ConversationMetadata | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<ConversationMetadata>;
  return {
    favorite: candidate.favorite === true,
    pinned: candidate.pinned === true,
    tags: normalizeTags(candidate.tags),
    note: typeof candidate.note === "string" ? candidate.note.trim().slice(0, 2000) : "",
    projectKey: typeof candidate.projectKey === "string" ? candidate.projectKey : "",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : ""
  };
}

function emptySnapshot(): ConversationMetadataSnapshot {
  return { conversations: {}, globalTags: [] };
}

export class ConversationMetadataStore {
  private cached?: ConversationMetadataSnapshot;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<ConversationMetadataSnapshot> {
    const data = await this.load();
    return {
      conversations: Object.fromEntries(
        Object.entries(data.conversations).map(([id, metadata]) => [id, { ...metadata, tags: [...metadata.tags] }])
      ),
      globalTags: [...data.globalTags]
    };
  }

  async get(id: string, projectKey = ""): Promise<ConversationMetadata> {
    const data = await this.load();
    const metadata = data.conversations[id];
    return metadata
      ? { ...metadata, tags: [...metadata.tags] }
      : { ...EMPTY_METADATA, tags: [], projectKey, updatedAt: "" };
  }

  async update(id: string, projectKey: string, update: ConversationMetadataUpdate): Promise<ConversationMetadata> {
    let result: ConversationMetadata | undefined;
    await this.enqueue(async () => {
      const data = await this.load();
      const current = data.conversations[id] ?? {
        ...EMPTY_METADATA,
        tags: [],
        projectKey,
        updatedAt: ""
      };
      const tags = update.tags === undefined ? current.tags : normalizeTags(update.tags);
      result = {
        favorite: update.favorite ?? current.favorite,
        pinned: update.pinned ?? current.pinned,
        tags,
        note: update.note === undefined ? current.note : update.note.trim().slice(0, 2000),
        projectKey,
        updatedAt: new Date().toISOString()
      };
      data.conversations[id] = result;
      if (tags.length > 0) {
        data.globalTags = normalizeTags([...data.globalTags, ...tags], 500);
      }
      await this.write(data);
    });
    return { ...(result as ConversationMetadata), tags: [...(result as ConversationMetadata).tags] };
  }

  async remove(id: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load();
      if (!(id in data.conversations)) {
        return;
      }
      delete data.conversations[id];
      await this.write(data);
    });
  }

  async tags(): Promise<string[]> {
    const data = await this.load();
    return [...data.globalTags];
  }

  private async load(): Promise<ConversationMetadataSnapshot> {
    if (this.cached) {
      return this.cached;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch {
      this.cached = emptySnapshot();
      return this.cached;
    }

    const source = parsed && typeof parsed === "object"
      ? parsed as Partial<ConversationMetadataSnapshot> & { projectTags?: Record<string, unknown> }
      : {};
    const conversations: Record<string, ConversationMetadata> = {};
    for (const [id, value] of Object.entries(source.conversations ?? {})) {
      const metadata = normalizeMetadata(value);
      if (metadata) {
        conversations[id] = metadata;
      }
    }
    // Version 1 stored tags per project. Flatten those values when loading so
    // existing installations migrate automatically to the shared tag list.
    const legacyTags = Object.values(source.projectTags ?? {}).flatMap((tags) =>
      Array.isArray(tags) ? tags : []
    );
    const conversationTags = Object.values(conversations).flatMap((metadata) => metadata.tags);
    const globalTags = normalizeTags([...(source.globalTags ?? []), ...legacyTags, ...conversationTags], 500);
    this.cached = { conversations, globalTags };
    return this.cached;
  }

  private async enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(action, action);
    this.writeQueue = next.catch(() => undefined);
    await next;
  }

  private async write(data: ConversationMetadataSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 2, ...data }, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filePath);
    this.cached = data;
  }
}
