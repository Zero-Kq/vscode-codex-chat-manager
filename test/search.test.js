const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { parseSearchQuery, matchesSearchMetadata } = require("../out/search/searchQuery");
const { SessionSearchIndex, isAbortError } = require("../out/search/sessionSearchIndex");

async function testStoreSearch(root) {
  const Module = require("module");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return { workspace: { getConfiguration: () => ({ get: () => "" }) } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let CodexSessionStore;
  try {
    ({ CodexSessionStore } = require("../out/stores/codexSessionStore"));
  } finally {
    Module._load = originalLoad;
  }

  const sessions = path.join(root, "sessions", "2026", "09", "04");
  await fs.mkdir(sessions, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const sourcePath = path.join(sessions, `rollout-2026-09-04T00-00-00-${id}.jsonl`);
  await fs.writeFile(
    sourcePath,
    [
      JSON.stringify({ role: "user", content: "SUPERLIO 编译失败，检查 rosbag" }),
      JSON.stringify({ role: "assistant", content: "已经修复 Docker 配置" })
    ].join("\n") + "\n"
  );
  await fs.writeFile(
    path.join(root, "session_index.jsonl"),
    `${JSON.stringify({ id, thread_name: "SUPERLIO 构建" })}\n`
  );

  const values = {
    codexHome: root,
    sessionsDir: path.join(root, "sessions"),
    indexFile: path.join(root, "session_index.jsonl")
  };
  const store = new CodexSessionStore(
    () => ({ get: (key) => values[key] || "" }),
    path.join(root, "global-storage")
  );

  const userResults = await store.search("role:user 编译失败");
  assert.strictEqual(userResults.length, 1);
  assert.strictEqual(userResults[0].hits[0].role, "user");
  assert.strictEqual(userResults[0].hits[0].query, "编译失败");

  const assistantResults = await store.search("role:assistant Docker");
  assert.strictEqual(assistantResults.length, 1);
  assert.strictEqual(assistantResults[0].hits[0].role, "assistant");

  assert.strictEqual((await store.search("编译失败 Docker")).length, 1);
  assert.strictEqual((await store.search("is:archived Docker")).length, 0);
  assert.strictEqual((await store.search("is:active after:2026-09-01 Docker")).length, 1);
  await assert.rejects(() => store.search("after:2026-02-30 Docker"), /日期格式无效/);
}

async function main() {
  const parsed = parseSearchQuery(
    'project:"SUPER LIO" role:user is:archived after:2026-08-01 "编译 失败" rosbag'
  );
  assert.deepStrictEqual(parsed.projects, ["SUPER LIO"]);
  assert.deepStrictEqual(parsed.roles, ["user"]);
  assert.strictEqual(parsed.archived, true);
  assert.deepStrictEqual(parsed.terms, ["编译 失败", "rosbag"]);
  assert.deepStrictEqual(parsed.errors, []);
  assert.strictEqual(
    matchesSearchMetadata(parsed, {
      archived: true,
      cwd: "/home/yj/ros_env/SUPER LIO",
      updatedAt: new Date("2026-09-01T00:00:00")
    }),
    true
  );
  assert.strictEqual(parseSearchQuery("after:2026-02-30 test").errors.length, 1);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-search-index-"));
  try {
    const cache = path.join(root, "cache");
    const sourcePath = path.join(root, "rollout.jsonl");
    const records = [];
    for (let index = 0; index < 5000; index += 1) {
      records.push(
        JSON.stringify({ role: index % 2 ? "assistant" : "user", content: `message ${index} rosbag` })
      );
    }
    await fs.writeFile(sourcePath, `${records.join("\n")}\n`);
    const summary = { id: "thread-1", title: "SUPERLIO build", sourcePath, archived: false };
    const parser = (record) => ({ role: record.role, content: record.content });

    let progress;
    const first = new SessionSearchIndex(cache);
    const firstEntries = await first.sync([summary], parser, {
      onProgress: (value) => {
        progress = value;
      },
      prune: true
    });
    assert.strictEqual(firstEntries[0].messages.length, 5000);
    assert.strictEqual(progress.indexed, 1);
    assert.strictEqual(progress.reused, 0);

    await first.sync([summary], parser, {
      onProgress: (value) => {
        progress = value;
      },
      prune: true
    });
    assert.strictEqual(progress.indexed, 0);
    assert.strictEqual(progress.reused, 1);

    const restarted = new SessionSearchIndex(cache);
    const persistedEntries = await restarted.sync([summary], parser, {
      onProgress: (value) => {
        progress = value;
      },
      prune: true
    });
    assert.strictEqual(persistedEntries[0].messages.length, 5000);
    assert.strictEqual(progress.indexed, 0);
    assert.strictEqual(progress.reused, 1);

    await fs.appendFile(sourcePath, `${JSON.stringify({ role: "user", content: "changed" })}\n`);
    const changedEntries = await restarted.sync([summary], parser, {
      onProgress: (value) => {
        progress = value;
      },
      prune: true
    });
    assert.strictEqual(changedEntries[0].messages.length, 5001);
    assert.strictEqual(progress.indexed, 1);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => restarted.sync([summary], parser, { signal: controller.signal }),
      isAbortError
    );

    await testStoreSearch(path.join(root, "store"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log("search tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
