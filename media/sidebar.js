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
  activeHit: null,
  searchRequestId: 0,
  activeSearchRequestId: 0,
  searchStatus: null,
  searchError: "",
  searchTerms: [],
  searchFilters: {},
  globalTags: []
};

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
const menuEl = document.getElementById("menu");
const modalEl = document.getElementById("modal");
const modalTextEl = document.getElementById("modal-text");
const tagMenuItemsEl = document.getElementById("tag-menu-items");
const tagSubmenuEl = document.getElementById("tag-submenu");
const tagSubmenuPanelEl = document.getElementById("tag-submenu-panel");
const TAG_SUBMENU_CLOSE_DELAY_MS = 400;
const SINGLE_CLICK_DELAY_MS = 350;
let tagSubmenuCloseTimer = null;
let pendingConversationClickTimer = null;

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
  if (state.filter === "favorite" && !item.favorite) {
    return false;
  }
  return true;
}

function visibleConversations() {
  return state.conversations.filter(matchesFilter);
}

function visibleSearchResults() {
  return state.searchResults.filter((item) => {
    if (state.filter === "favorite") {
      return Boolean(item.favorite);
    }
    if (typeof state.searchFilters.archived === "boolean") {
      return true;
    }
    return matchesFilter(item);
  });
}

function projectKey(item) {
  return item.projectKey || item.cwd || item.project || "未分类";
}

function timestamp(item) {
  const value = item.updatedAt ? Date.parse(item.updatedAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function compareItems(left, right) {
  if (Boolean(left.favorite) !== Boolean(right.favorite)) {
    return left.favorite ? -1 : 1;
  }
  return timestamp(right) - timestamp(left) || String(left.title).localeCompare(String(right.title), "zh-CN");
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
      latest: 0,
      pinned: false
    };
    group.items.push(item);
    group.latest = Math.max(group.latest, timestamp(item));
    group.pinned ||= Boolean(item.pinned);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return right.latest - left.latest;
  });
}

function groupProjectItems(items) {
  const pinned = items.filter((item) => item.pinned).sort(compareItems);
  const normal = items.filter((item) => !item.pinned);
  const tagGroups = new Map();
  const untagged = [];
  for (const item of normal) {
    const primaryTag = item.tags?.[0];
    if (!primaryTag) {
      untagged.push(item);
      continue;
    }
    const group = tagGroups.get(primaryTag) ?? [];
    group.push(item);
    tagGroups.set(primaryTag, group);
  }

  const sections = [];
  if (pinned.length > 0) {
    sections.push({ key: "pinned", label: "置顶", icon: "⌖", items: pinned });
  }
  for (const [tag, values] of [...tagGroups.entries()].sort(([left], [right]) => left.localeCompare(right, "zh-CN"))) {
    sections.push({ key: `tag:${tag}`, label: tag, icon: "#", items: values.sort(compareItems) });
  }
  if (untagged.length > 0) {
    sections.push({ key: "untagged", label: "无标签", icon: "", items: untagged.sort(compareItems) });
  }
  return sections;
}

function renderNote(item) {
  if (!item.note) {
    return "";
  }
  return `<div class="item-metadata"><span class="note-preview" title="${escapeAttr(item.note)}">📝 ${escapeHtml(item.note)}</span></div>`;
}

function renderItem(item) {
  const archivedBadge = item.archived && state.filter !== "archived" ? `<span class="badge">已归档</span>` : "";
  const runningBadge = item.running ? `<span class="running"><span class="running-dot"></span>进行中</span>` : "";
  const favorite = item.favorite
    ? `<span class="favorite-toggle active" data-favorite="${item.id}" role="button" tabindex="-1" title="取消收藏">★</span>`
    : "";
  const pin = item.pinned ? `<span class="pin-icon" title="已置顶">⌖</span>` : "";
  const tags = (item.tags || []).map((tag) => `<span class="tag-chip" title="标签：${escapeAttr(tag)}">${escapeHtml(tag)}</span>`).join("");
  const inlineTags = tags ? `<span class="item-tags">${tags}</span>` : "";
  const tooltip = item.note ? `${item.title}\n备注：${item.note}` : item.title;
  return `
    <div class="item${item.pinned ? " pinned" : ""}" data-id="${item.id}" data-archived="${item.archived ? "1" : "0"}" tabindex="0" role="button" title="${escapeAttr(tooltip)}">
      <div class="item-main">
        ${favorite}
        ${pin}
        <span class="title">${escapeHtml(item.title)}</span>
        ${runningBadge}
        ${archivedBadge}
        ${inlineTags}
        <span class="time">${item.running ? "" : relativeTime(item.updatedAt)}</span>
      </div>
      ${renderNote(item)}
    </div>`;
}

function renderProjectSections(group) {
  return groupProjectItems(group.items)
    .map((section) => `
      <div class="label-section" data-label="${escapeAttr(section.key)}">
        <div class="label-header">
          <span class="label-icon">${section.icon}</span>
          <span class="label-name">${escapeHtml(section.label)}</span>
          <span class="label-count">${section.items.length}</span>
        </div>
        ${section.items.map(renderItem).join("")}
      </div>`)
    .join("");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMany(text, terms) {
  const values = (terms || []).filter(Boolean).sort((left, right) => right.length - left.length);
  if (values.length === 0) {
    return escapeHtml(text);
  }
  const pattern = values.map((term) => escapeRegExp(escapeHtml(term))).join("|");
  return escapeHtml(text).replace(new RegExp(pattern, "gi"), (match) => `<mark>${match}</mark>`);
}

function renderHit(result, hit) {
  const current = state.activeHit && state.activeHit.id === result.id && state.activeHit.occurrence === hit.occurrence && state.activeHit.query === hit.query ? " current" : "";
  return `
    <button class="hit${current}" data-open="${result.id}" data-occurrence="${hit.occurrence}" data-query="${escapeAttr(hit.query || "")}" title="${escapeAttr(hit.text)}">
      <span class="hit-role">${hit.role === "user" ? "用户" : hit.role === "assistant" ? "助手" : "标题"}</span>
      <span class="hit-text">${highlightMany(hit.text, hit.query ? [hit.query] : state.searchTerms)}</span>
    </button>`;
}

function renderSearchMetadata(result) {
  const icons = `${result.favorite ? '<span class="search-meta-icon favorite">★</span>' : ""}${result.pinned ? '<span class="search-meta-icon">⌖</span>' : ""}`;
  const tags = (result.tags || []).map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("");
  if (!icons && !tags && !result.note) {
    return "";
  }
  return `<div class="search-result-meta">${icons}${tags}${result.note ? `<span class="note-preview" title="${escapeAttr(result.note)}">📝 ${escapeHtml(result.note)}</span>` : ""}</div>`;
}

function renderSearch() {
  const query = state.query.trim();
  if (state.searchError) {
    listEl.innerHTML = `<div class="empty search-error">搜索失败：${escapeHtml(state.searchError)}</div>`;
    return;
  }
  if (state.searchQuery !== query) {
    const progress = state.searchStatus;
    const total = progress?.total || 0;
    const completed = progress?.completed || 0;
    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    const phase = progress?.phase === "searching" ? "正在搜索索引" : progress ? "正在更新索引" : "等待输入停止";
    const detail = progress
      ? `${completed}/${total} · 新建 ${progress.indexed || 0} · 缓存 ${progress.reused || 0}`
      : "250ms 后开始搜索";
    listEl.innerHTML = `
      <div class="search-progress" role="status">
        <div class="search-progress-label"><span>${phase}</span><span>${escapeHtml(detail)}</span></div>
        <div class="search-progress-track"><span style="width:${percent}%"></span></div>
      </div>`;
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
    .sort((left, right) => Boolean(right.pinned) - Boolean(left.pinned))
    .map((result) => {
      const key = `search:${result.id}`;
      const collapsed = Boolean(state.collapsed[key]);
      return `
        <section class="project search-group${collapsed ? " collapsed" : ""}" data-project="${escapeAttr(key)}">
          <button class="project-header" data-toggle-project="${escapeAttr(key)}" data-id="${result.id}" aria-expanded="${!collapsed}" title="双击在 Codex 中继续">
            <span class="chevron" aria-hidden="true"></span>
            ${result.favorite ? '<span class="search-meta-icon favorite">★</span>' : ""}
            ${result.pinned ? '<span class="search-meta-icon">⌖</span>' : ""}
            <span class="project-name" title="${escapeAttr(result.title)}">${highlightMany(result.title, state.searchTerms)}</span>
            ${result.running ? `<span class="running"><span class="running-dot"></span></span>` : ""}
            <span class="hit-count">${result.hits.length}</span>
          </button>
          ${renderSearchMetadata(result)}
          <div class="project-items">
            ${result.hits.map((hit) => renderHit(result, hit)).join("")}
          </div>
        </section>`;
    })
    .join("");
  listEl.innerHTML = summary + groups;
}

function cancelTagSubmenuClose() {
  if (tagSubmenuCloseTimer) {
    clearTimeout(tagSubmenuCloseTimer);
    tagSubmenuCloseTimer = null;
  }
}

function cancelPendingConversationClick() {
  if (pendingConversationClickTimer) {
    clearTimeout(pendingConversationClickTimer);
    pendingConversationClickTimer = null;
  }
}

function scheduleSingleConversationClick(event, action) {
  cancelPendingConversationClick();
  if (event.detail > 1) {
    return;
  }
  pendingConversationClickTimer = setTimeout(() => {
    pendingConversationClickTimer = null;
    action();
  }, SINGLE_CLICK_DELAY_MS);
}

function closeMenu() {
  cancelTagSubmenuClose();
  tagSubmenuEl.classList.remove("submenu-open");
  menuEl.hidden = true;
  menuEl.dataset.id = "";
  menuEl.classList.remove("submenu-left");
  tagSubmenuPanelEl.style.top = "";
  tagSubmenuPanelEl.style.left = "";
  tagSubmenuPanelEl.style.right = "";
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  persistState();
  render();
}

function findConversation(id) {
  return state.conversations.find((conversation) => conversation.id === id)
    || state.searchResults.find((conversation) => conversation.id === id);
}

function setMenuLabel(action, text) {
  const button = menuEl.querySelector(`[data-menu='${action}']`);
  if (button) {
    button.textContent = text;
  }
}

function openMenu(id, x, y) {
  const item = findConversation(id);
  menuEl.dataset.id = id;
  const archiveBtn = menuEl.querySelector("[data-menu='archive']");
  const unarchiveBtn = menuEl.querySelector("[data-menu='unarchive']");
  if (archiveBtn && unarchiveBtn) {
    archiveBtn.hidden = Boolean(item?.archived);
    unarchiveBtn.hidden = !item?.archived;
  }
  setMenuLabel("favorite", item?.favorite ? "取消收藏" : "收藏");
  setMenuLabel("pin", item?.pinned ? "取消置顶" : "置顶");
  setMenuLabel("note", item?.note ? "编辑备注…" : "添加备注…");
  const selectedTags = new Set((item?.tags || []).map((tag) => tag.toLocaleLowerCase()));
  const availableTags = state.globalTags || [];
  tagMenuItemsEl.innerHTML = availableTags.length > 0
    ? availableTags.map((tag) => `
        <button type="button" class="tag-menu-item${selectedTags.has(tag.toLocaleLowerCase()) ? " selected" : ""}" data-menu="toggleTag" data-tag="${escapeAttr(tag)}">
          <span class="tag-menu-check">${selectedTags.has(tag.toLocaleLowerCase()) ? "✓" : ""}</span>
          <span class="tag-menu-name">${escapeHtml(tag)}</span>
        </button>`).join("")
    : '<div class="menu-empty">暂无已有标签</div>';
  menuEl.hidden = false;
  const pad = 8;
  const width = menuEl.offsetWidth;
  const height = menuEl.offsetHeight;
  const left = Math.min(x, window.innerWidth - width - pad);
  const top = Math.min(y, window.innerHeight - height - pad);
  menuEl.style.left = `${Math.max(pad, left)}px`;
  menuEl.style.top = `${Math.max(pad, top)}px`;

  menuEl.classList.remove("submenu-left");
  tagSubmenuPanelEl.style.top = "-5px";
  tagSubmenuPanelEl.style.left = "";
  tagSubmenuPanelEl.style.right = "auto";
  const menuRect = menuEl.getBoundingClientRect();
  const triggerRect = tagSubmenuEl.getBoundingClientRect();
  const panelWidth = tagSubmenuPanelEl.offsetWidth;
  const maximumPanelLeft = Math.max(pad, window.innerWidth - pad - panelWidth);
  const rightPanelLeft = menuRect.right - 1;
  const leftPanelLeft = menuRect.left - panelWidth + 1;
  const rightFits = rightPanelLeft <= maximumPanelLeft;
  const leftFits = leftPanelLeft >= pad;
  let panelLeft;
  if (rightFits) {
    panelLeft = rightPanelLeft;
  } else if (leftFits) {
    panelLeft = leftPanelLeft;
  } else {
    const rightSpace = window.innerWidth - menuRect.right;
    const leftSpace = menuRect.left;
    const preferredLeft = rightSpace >= leftSpace ? rightPanelLeft : leftPanelLeft;
    panelLeft = Math.max(pad, Math.min(preferredLeft, maximumPanelLeft));
  }
  tagSubmenuPanelEl.style.left = `${panelLeft - triggerRect.left}px`;
  menuEl.classList.toggle("submenu-left", panelLeft < menuRect.left);

  const panelHeight = tagSubmenuPanelEl.offsetHeight;
  const defaultPanelTop = -5;
  const minimumTop = pad - triggerRect.top;
  const maximumTop = window.innerHeight - pad - triggerRect.top - panelHeight;
  tagSubmenuPanelEl.style.top = `${Math.max(minimumTop, Math.min(defaultPanelTop, maximumTop))}px`;
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
            ${renderProjectSections(group)}
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
  return escapeHtml(text).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

function openDeleteModal(id) {
  const item = findConversation(id);
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
    state.searchTimer = null;
  }
  vscode.postMessage({ type: "cancelSearch" });
  const query = state.query.trim();
  state.searchQuery = "";
  state.searchStatus = null;
  state.searchError = "";
  if (!query) {
    state.searchResults = [];
    state.searchTerms = [];
    state.searchFilters = {};
    state.activeHit = null;
    render();
    return;
  }
  render();
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    const requestId = state.searchRequestId + 1;
    state.searchRequestId = requestId;
    state.activeSearchRequestId = requestId;
    state.searchStatus = { phase: "indexing", completed: 0, total: 0, indexed: 0, reused: 0 };
    render();
    vscode.postMessage({ type: "search", query, requestId });
  }, 250);
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "conversations") {
    state.conversations = message.conversations || [];
    state.globalTags = message.globalTags || [];
    render();
    if (state.query.trim() && !state.searchStatus && !state.searchTimer) {
      requestContentSearch();
    }
    return;
  }
  if (message?.requestId !== state.activeSearchRequestId || message.query !== state.query.trim()) {
    return;
  }
  if (message?.type === "searchProgress") {
    state.searchStatus = message.progress || null;
    render();
    return;
  }
  if (message?.type === "searchResults") {
    state.searchQuery = message.query;
    state.searchResults = message.results || [];
    state.searchTerms = message.terms || [];
    state.searchFilters = message.filters || {};
    state.globalTags = message.globalTags || state.globalTags;
    state.searchStatus = null;
    state.searchError = "";
    render();
    return;
  }
  if (message?.type === "searchError") {
    state.searchError = message.error || "未知错误";
    state.searchStatus = null;
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
  const favorite = event.target.closest("[data-favorite]");
  if (favorite) {
    event.stopPropagation();
    vscode.postMessage({ type: "favorite", id: favorite.dataset.favorite });
    return;
  }
  const toggleBtn = event.target.closest("[data-toggle-project]");
  if (toggleBtn) {
    event.stopPropagation();
    if (toggleBtn.dataset.id) {
      const key = toggleBtn.dataset.toggleProject;
      scheduleSingleConversationClick(event, () => toggleProject(key));
    } else {
      cancelPendingConversationClick();
      toggleProject(toggleBtn.dataset.toggleProject);
    }
    return;
  }
  const hit = event.target.closest("[data-open]");
  if (hit) {
    const id = hit.dataset.open;
    const occurrence = Number(hit.dataset.occurrence);
    const matchedQuery = hit.dataset.query || "";
    scheduleSingleConversationClick(event, () => {
      state.activeHit = { id, occurrence, query: matchedQuery };
      render();
      vscode.postMessage({
        type: "open",
        id,
        query: matchedQuery,
        occurrence: Number.isFinite(occurrence) ? occurrence : -1
      });
    });
    return;
  }
  const item = event.target.closest(".item");
  if (item) {
    const id = item.dataset.id;
    const query = state.query.trim();
    scheduleSingleConversationClick(event, () => {
      vscode.postMessage({ type: "open", id, query });
    });
  }
});

listEl.addEventListener("dblclick", (event) => {
  cancelPendingConversationClick();
  if (event.target.closest("[data-favorite]")) {
    return;
  }
  const target = event.target.closest(".item, [data-open], .search-group .project-header");
  const id = target?.dataset.id || target?.dataset.open;
  if (id) {
    event.preventDefault();
    event.stopPropagation();
    vscode.postMessage({ type: "continue", id });
  }
});

listEl.addEventListener("contextmenu", (event) => {
  cancelPendingConversationClick();
  const target = event.target.closest(".item, [data-open], .search-group .project-header");
  const id = target?.dataset.id || target?.dataset.open;
  if (!id) {
    closeMenu();
    return;
  }
  event.preventDefault();
  openMenu(id, event.clientX, event.clientY);
});

tagSubmenuEl.addEventListener("pointerenter", () => {
  cancelTagSubmenuClose();
  tagSubmenuEl.classList.add("submenu-open");
});

tagSubmenuEl.addEventListener("pointerleave", () => {
  cancelTagSubmenuClose();
  tagSubmenuCloseTimer = setTimeout(() => {
    tagSubmenuCloseTimer = null;
    tagSubmenuEl.classList.remove("submenu-open");
  }, TAG_SUBMENU_CLOSE_DELAY_MS);
});

menuEl.addEventListener("click", (event) => {
  const action = event.target.closest("[data-menu]");
  const id = menuEl.dataset.id;
  if (!action || !id) {
    return;
  }
  closeMenu();
  const type = action.dataset.menu;
  if (type === "toggleTag") {
    vscode.postMessage({ type, id, tag: action.dataset.tag });
    return;
  }
  if (["continue", "favorite", "pin", "newTag", "note", "rename", "archive", "unarchive"].includes(type)) {
    vscode.postMessage({ type, id });
    return;
  }
  if (type === "delete") {
    openDeleteModal(id);
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#menu")) {
    closeMenu();
  }
}, true);

document.addEventListener("click", (event) => {
  if (!event.target.closest("#menu")) {
    closeMenu();
  }
});

window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
document.documentElement.addEventListener("mouseleave", closeMenu);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
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
    vscode.postMessage({ type: event.ctrlKey || event.metaKey ? "continue" : "open", id: item.dataset.id });
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
