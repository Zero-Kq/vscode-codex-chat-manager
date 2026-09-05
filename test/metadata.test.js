const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { ConversationMetadataStore } = require("../out/metadata/conversationMetadataStore");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-manager-metadata-"));
  const filePath = path.join(root, "conversation-metadata.json");
  try {
    const store = new ConversationMetadataStore(filePath);
    const first = await store.update("thread-1", "/workspace/project-a", {
      favorite: true,
      pinned: true,
      tags: ["待办", "重要", "待办"],
      note: "下次继续处理构建错误"
    });
    assert.strictEqual(first.favorite, true);
    assert.strictEqual(first.pinned, true);
    assert.deepStrictEqual(first.tags, ["待办", "重要"]);

    const restarted = new ConversationMetadataStore(filePath);
    const persisted = await restarted.get("thread-1");
    assert.strictEqual(persisted.note, "下次继续处理构建错误");
    assert.deepStrictEqual(await restarted.tags(), ["待办", "重要"]);

    await restarted.update("thread-2", "/workspace/project-b", { tags: ["跨项目"] });
    assert.deepStrictEqual(await restarted.tags(), ["待办", "重要", "跨项目"]);

    await restarted.remove("thread-1");
    const snapshot = await restarted.snapshot();
    assert.strictEqual(snapshot.conversations["thread-1"], undefined);
    assert.deepStrictEqual(snapshot.globalTags, ["待办", "重要", "跨项目"]);

    const legacyPath = path.join(root, "legacy-metadata.json");
    await fs.writeFile(legacyPath, JSON.stringify({
      version: 1,
      conversations: {},
      projectTags: {
        "/workspace/project-a": ["旧标签", "共享"],
        "/workspace/project-b": ["共享", "另一个"]
      }
    }));
    const migrated = new ConversationMetadataStore(legacyPath);
    assert.deepStrictEqual(await migrated.tags(), ["旧标签", "共享", "另一个"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("metadata tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
