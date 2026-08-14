const vscode = acquireVsCodeApi();

const state = {
  filter: "active",
  query: "",
  conversations: [],
  pendingDeleteId: null
};

const listEl = document.getElementById("list");
const searchEl = document.getElementById("search");
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

function visibleConversations() {
  const query = state.query.trim().toLowerCase();
  return state.conversations.filter((item) => {
    if (state.filter === "active" && item.archived) {
      return false;
    }
    if (state.filter === "archived" && !item.archived) {
      return false;
    }
    if (!query) {
      return true;
    }
    return `${item.title} ${item.preview || ""}`.toLowerCase().includes(query);
  });
}

function render() {
  const items = visibleConversations();
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty">没有符合条件的对话</div>`;
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      const badge = item.archived ? `<span class="badge">已归档</span>` : "";
      const archiveAction = item.archived
        ? `<button class="archive-btn" data-unarchive="${item.id}" title="取消归档" aria-label="取消归档">↩</button>`
        : `<button class="archive-btn" data-archive="${item.id}" title="归档" aria-label="归档">⬇</button>`;
      return `
        <div class="item" data-id="${item.id}" tabindex="0" role="button">
          <div class="main">
            <span class="title" title="${escapeAttr(item.title)}">${escapeHtml(item.title)}</span>
            ${badge}
            <span class="time">${relativeTime(item.updatedAt)}</span>
          </div>
          <div class="row-actions">
            ${archiveAction}
            <button class="delete" data-delete="${item.id}" title="删除对话" aria-label="删除对话">✕</button>
          </div>
        </div>`;
    })
    .join("");
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

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  vscode.setState({ filter: state.filter, query: state.query });
  render();
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

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "conversations") {
    state.conversations = message.conversations || [];
    render();
  }
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});

document.getElementById("refresh").addEventListener("click", () => {
  vscode.postMessage({ type: "refresh" });
});

searchEl.addEventListener("input", () => {
  state.query = searchEl.value;
  vscode.setState({ filter: state.filter, query: state.query });
  render();
});

listEl.addEventListener("click", (event) => {
  const deleteBtn = event.target.closest("[data-delete]");
  if (deleteBtn) {
    event.stopPropagation();
    openDeleteModal(deleteBtn.dataset.delete);
    return;
  }
  const unarchiveBtn = event.target.closest("[data-unarchive]");
  if (unarchiveBtn) {
    event.stopPropagation();
    vscode.postMessage({ type: "unarchive", id: unarchiveBtn.dataset.unarchive });
    return;
  }
  const archiveBtn = event.target.closest("[data-archive]");
  if (archiveBtn) {
    event.stopPropagation();
    vscode.postMessage({ type: "archive", id: archiveBtn.dataset.archive });
    return;
  }
  const item = event.target.closest(".item");
  if (item) {
    vscode.postMessage({ type: "open", id: item.dataset.id });
  }
});

listEl.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  const item = event.target.closest(".item");
  if (item) {
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

vscode.postMessage({ type: "ready" });
