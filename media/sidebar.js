const vscode = acquireVsCodeApi();

const state = {
  filter: "active",
  query: "",
  conversations: [],
  searchResults: [],
  searchQuery: "",
  pendingDeleteId: null,
  collapsed: {},
  searchTimer: null,
  activeHit: null
};

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const menuEl = document.getElementById("menu");
const modalEl = document.getElementById("modal");
const modalTextEl = document.getElementById("modal-text");

function relativeTime(iso) {
  if (!iso) {
    return "";
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diff = Date.now() - then;
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) {
    return "刚刚";
  }
  if (minutes < 60) {
    return `${minutes} 分`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return "昨天";
  }
  if (days < 7) {
    return `${days} 天`;
  }
  const date = new Date(then);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function matchesFilter(item) {
  if (state.filter === "active" && item.archived) {
    return false;
  }
  if (state.filter === "archived" && !item.archived) {
    return false;
  }
  return true;
}

function visibleConversations() {
  return state.conversations.filter(matchesFilter);
}

function visibleSearchResults() {
  return state.searchResults.filter(matchesFilter);
}

function projectKey(item) {
  return item.cwd || item.project || "未分类";
}

function groupedConversations() {
  const groups = new Map();
  for (const item of visibleConversations()) {
    const key = projectKey(item);
    const group = groups.get(key) ?? {
      key,
      label: item.project || "未分类",
      cwd: item.cwd || "",
      items: [],
      latest: 0
    };
    group.items.push(item);
    const stamp = item.updatedAt ? Date.parse(item.updatedAt) : 0;
    if (stamp > group.latest) {
      group.latest = stamp;
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.latest - a.latest);
}

function renderItem(item) {
  const archivedBadge = item.archived && state.filter === "all" ? `<span class="badge">已归档</span>` : "";
  const runningBadge = item.running ? `<span class="running"><span class="running-dot"></span>进行中</span>` : "";
  return `
    <div class="item" data-id="${item.id}" data-archived="${item.archived ? "1" : "0"}" tabindex="0" role="button">
      <span class="title" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</span>
      ${runningBadge}
      ${archivedBadge}
      <span class="time">${item.running ? "" : relativeTime(item.updatedAt)}</span>
    </div>`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, query) {
  const escaped = escapeHtml(text);
  const needle = escapeHtml(query);
  if (!needle) {
    return escaped;
  }
  return escaped.replace(new RegExp(escapeRegExp(needle), "gi"), (match) => `<mark>${match}</mark>`);
}

function renderHit(result, hit) {
  const current = state.activeHit && state.activeHit.id === result.id && state.activeHit.occurrence === hit.occurrence ? " current" : "";
  return `
    <button class="hit${current}" data-open="${result.id}" data-occurrence="${hit.occurrence}" title="${escapeAttr(hit.text)}">
      <span class="hit-text">${highlight(hit.text, state.query.trim())}</span>
    </button>`;
}

function renderSearch() {
  const query = state.query.trim();
  if (state.searchQuery !== query) {
    listEl.innerHTML = `<div class="empty">正在搜索…</div>`;
    return;
  }

  const results = visibleSearchResults();
  const totalHits = results.reduce((sum, item) => sum + item.hits.length, 0);
  if (results.length === 0) {
    listEl.innerHTML = `<div class="empty">没有找到匹配的对话内容</div>`;
    return;
  }

  const summary = `<div class="search-summary">${totalHits} 个结果，来自 ${results.length} 个对话</div>`;
  const groups = results
    .map((result) => {
      const key = `search:${result.id}`;
      const collapsed = Boolean(state.collapsed[key]);
      return `
        <section class="project search-group${collapsed ? " collapsed" : ""}" data-project="${escapeAttr(key)}">
          <button class="project-header" data-toggle-project="${escapeAttr(key)}" data-id="${result.id}" aria-expanded="${!collapsed}">
            <span class="chevron" aria-hidden="true"></span>
            <span class="project-name" title="${escapeAttr(result.title)}">${highlight(result.title, query)}</span>
            ${result.running ? `<span class="running"><span class="running-dot"></span></span>` : ""}
            <span class="hit-count">${result.hits.length}</span>
          </button>
          <div class="project-items">
            ${result.hits.map((hit) => renderHit(result, hit)).join("")}
          </div>
        </section>`;
    })
    .join("");
  listEl.innerHTML = summary + groups;
}

function closeMenu() {
  menuEl.hidden = true;
  menuEl.dataset.id = "";
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  persistState();
  render();
}

function openMenu(id, x, y) {
  const item = state.conversations.find((conversation) => conversation.id === id);
  menuEl.dataset.id = id;
  const archiveBtn = menuEl.querySelector("[data-menu='archive']");
  const unarchiveBtn = menuEl.querySelector("[data-menu='unarchive']");
  if (archiveBtn && unarchiveBtn) {
    archiveBtn.hidden = Boolean(item?.archived);
    unarchiveBtn.hidden = !item?.archived;
  }
  menuEl.hidden = false;
  const pad = 8;
  const width = menuEl.offsetWidth;
  const height = menuEl.offsetHeight;
  const left = Math.min(x, window.innerWidth - width - pad);
  const top = Math.min(y, window.innerHeight - height - pad);
  menuEl.style.left = `${Math.max(pad, left)}px`;
  menuEl.style.top = `${Math.max(pad, top)}px`;
}

function render() {
  closeMenu();
  if (state.query.trim()) {
    renderSearch();
    return;
  }

  const groups = groupedConversations();
  if (groups.length === 0) {
    listEl.innerHTML = `<div class="empty">没有符合条件的对话</div>`;
    return;
  }

  listEl.innerHTML = groups
    .map((group) => {
      const collapsed = Boolean(state.collapsed[group.key]);
      return `
        <section class="project${collapsed ? " collapsed" : ""}" data-project="${escapeAttr(group.key)}">
          <button class="project-header" data-toggle-project="${escapeAttr(group.key)}" aria-expanded="${!collapsed}">
            <span class="chevron" aria-hidden="true"></span>
            <span class="project-name" title="${escapeAttr(group.cwd || group.label)}">${escapeHtml(group.label)}</span>
            <span class="project-count">${group.items.length}</span>
          </button>
          <div class="project-items">
            ${group.items.map(renderItem).join("")}
          </div>
        </section>`;
    })
    .join("");
}

function persistState() {
  vscode.setState({ filter: state.filter, query: state.query, collapsed: state.collapsed });
}

function toggleProject(key) {
  if (state.collapsed[key]) {
    delete state.collapsed[key];
  } else {
    state.collapsed[key] = true;
  }
  persistState();
  render();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function openDeleteModal(id) {
  const item = state.conversations.find((conversation) => conversation.id === id);
  if (!item) {
    return;
  }
  state.pendingDeleteId = id;
  modalTextEl.textContent = `确定删除「${item.title}」吗？删除后无法恢复。`;
  modalEl.classList.add("open");
}

function closeDeleteModal() {
  state.pendingDeleteId = null;
  modalEl.classList.remove("open");
}

function requestContentSearch() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
  }
  const query = state.query.trim();
  if (!query) {
    state.searchResults = [];
    state.searchQuery = "";
    state.activeHit = null;
    render();
    return;
  }
  state.searchTimer = setTimeout(() => {
    vscode.postMessage({ type: "search", query });
  }, 280);
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "conversations") {
    state.conversations = message.conversations || [];
    render();
    if (state.query.trim()) {
      requestContentSearch();
    }
    return;
  }
  if (message?.type === "searchResults" && message.query === state.query.trim()) {
    state.searchQuery = message.query;
    state.searchResults = message.results || [];
    render();
  }
});

document.getElementById("refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});

searchEl.addEventListener("input", () => {
  state.query = searchEl.value;
  persistState();
  render();
  requestContentSearch();
});

listEl.addEventListener("click", (event) => {
  closeMenu();
  const toggleBtn = event.target.closest("[data-toggle-project]");
  if (toggleBtn) {
    event.stopPropagation();
    toggleProject(toggleBtn.dataset.toggleProject);
    return;
  }
  const hit = event.target.closest("[data-open]");
  if (hit) {
    const occurrence = Number(hit.dataset.occurrence);
    state.activeHit = { id: hit.dataset.open, occurrence };
    render();
    vscode.postMessage({
      type: "open",
      id: hit.dataset.open,
      query: state.query.trim(),
      occurrence: Number.isFinite(occurrence) ? occurrence : -1
    });
    return;
  }
  const item = event.target.closest(".item");
  if (item) {
    vscode.postMessage({ type: "open", id: item.dataset.id, query: state.query.trim() });
  }
});

listEl.addEventListener("contextmenu", (event) => {
  const target = event.target.closest(".item, [data-open], .search-group .project-header");
  const id = target?.dataset.id || target?.dataset.open;
  if (!id) {
    closeMenu();
    return;
  }
  event.preventDefault();
  openMenu(id, event.clientX, event.clientY);
});

menuEl.addEventListener("click", (event) => {
  const action = event.target.closest("[data-menu]");
  const id = menuEl.dataset.id;
  if (!action || !id) {
    return;
  }
  closeMenu();
  if (action.dataset.menu === "rename") {
    vscode.postMessage({ type: "rename", id });
    return;
  }
  if (action.dataset.menu === "archive") {
    vscode.postMessage({ type: "archive", id });
    return;
  }
  if (action.dataset.menu === "unarchive") {
    vscode.postMessage({ type: "unarchive", id });
    return;
  }
  if (action.dataset.menu === "delete") {
    openDeleteModal(id);
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#menu")) {
    closeMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeMenu();
  }
});

listEl.addEventListener("keydown", (event) => {
  const item = event.target.closest(".item");
  if (!item) {
    return;
  }
  if (event.key === "F2") {
    event.preventDefault();
    vscode.postMessage({ type: "rename", id: item.dataset.id });
    return;
  }
  if (event.key === "Enter") {
    vscode.postMessage({ type: "open", id: item.dataset.id });
  }
});

document.getElementById("cancel-delete").addEventListener("click", closeDeleteModal);
document.getElementById("confirm-delete").addEventListener("click", () => {
  if (!state.pendingDeleteId) {
    return;
  }
  vscode.postMessage({ type: "delete", id: state.pendingDeleteId });
  closeDeleteModal();
});

modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) {
    closeDeleteModal();
  }
});

const restored = vscode.getState();
if (restored?.filter) {
  state.filter = restored.filter;
  setFilter(state.filter);
}
if (restored?.query) {
  state.query = restored.query;
  searchEl.value = restored.query;
}
if (restored?.collapsed && typeof restored.collapsed === "object") {
  state.collapsed = restored.collapsed;
}

vscode.postMessage({ type: "ready" });
