/**
 * Workspaces Grid - Optimized
 * Dependencies: dayjs + relativeTime, Lucide icons
 */
(function() {
  if (window.dayjs?.extend && window.dayjs_plugin_relativeTime) {
    dayjs.extend(window.dayjs_plugin_relativeTime);
  }

  const root = document.getElementById("wf-workspaces");
  if (!root || root.dataset.init === "1") return;
  root.dataset.init = "1";

  // Config
  const API = root.dataset.api || "";
  const DELETE_API = root.dataset.deleteApi || "";
  const UPLOAD_API = root.dataset.uploadApi || "";
  const TIMEOUT_MS = 30000;
  const POLL_ACTIVE = 3000;
  const POLL_IDLE = 30000;

  // State
  let pollTimer = null;
  let controller = null;
  let currentWs = null;
  let deleteTarget = null;

  // DOM refs
  const grid = root.querySelector(".wfws-grid");
  const modal = root.querySelector("#wfws-modal");
  const deleteModal = root.querySelector("#wfws-delete-modal");

  // Helpers
  const $ = (sel, ctx = root) => ctx.querySelector(sel);
  const $$ = (sel, ctx = root) => ctx.querySelectorAll(sel);
  const relTime = (iso) => window.dayjs ? dayjs(iso).fromNow() : new Date(iso).toLocaleDateString();
  
  const getMemberId = () => {
    try {
      const raw = localStorage.getItem("_ms-mem");
      return raw ? (JSON.parse(raw)?.id || JSON.parse(raw)?.member_id) : null;
    } catch { return null; }
  };

  const USER_ID = getMemberId();

  const getStatus = (ws) => {
    const status = (ws?.status || "").toLowerCase();
    const total = ws?.fileCount || 0;
    const ready = ws?.fileStatusCounts?.ready || 0;
    const errors = ws?.fileStatusCounts?.error || 0;
    const pending = Math.max(total - ready - errors, 0);
    
    if (status === "ready" && pending === 0) {
      return { tone: "ready", label: "Ready", pending: 0, ready, total, errors };
    }
    return { tone: "pending", label: "Processing", pending, ready, total, errors };
  };

  const getFileStatus = (f) => {
    const s = (f?.status || "").toLowerCase();
    if (s === "ready") return { tone: "ready", label: "Ready" };
    if (s === "error") return { tone: "error", label: "Failed" };
    return { tone: "pending", label: "Processing" };
  };

  const getMembers = (ws) => {
    const members = ws?.members || [];
    if (!members.length && ws?.ownerUserId) {
      return [{ userId: ws.ownerUserId, role: "owner", isOwner: true, isYou: String(ws.ownerUserId) === String(USER_ID) }];
    }
    return members.map(m => ({
      ...m,
      isOwner: m.role === "owner",
      isYou: String(m.userId) === String(USER_ID),
      initials: (m.displayName || m.email || "?")[0].toUpperCase()
    }));
  };

  // Badge component
  const badge = (label, tone) => {
    const colors = {
      ready: "bg-emerald-100 text-emerald-700",
      pending: "bg-amber-100 text-amber-700",
      error: "bg-red-100 text-red-700"
    };
    return `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full ${colors[tone] || colors.pending}">
      ${tone === "pending" ? '<span class="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"></span>' : ""}
      ${label}
    </span>`;
  };

  // Render card
  const renderCard = (ws) => {
    const info = getStatus(ws);
    const members = getMembers(ws);
    const others = members.filter(m => !m.isOwner);
    
    return `
      <li class="group bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-gray-300 transition-all cursor-pointer" data-ws='${JSON.stringify(ws).replace(/'/g, "&#39;")}'>
        <div class="p-4 border-b border-gray-100 min-h-[140px] relative ${info.tone === "pending" ? "bg-gray-50" : ""}">
          ${info.tone === "pending" ? `
            <div class="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-2 z-10">
              <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
              <span class="text-sm font-medium text-gray-700">${info.label}</span>
              <span class="text-xs text-gray-500">${info.ready}/${info.total} ready</span>
            </div>
          ` : ""}
          <div class="space-y-2 ${info.tone === "pending" ? "opacity-40" : ""}">
            ${(ws.files || []).slice(0, 4).map(f => {
              const fs = getFileStatus(f);
              return `
                <div class="flex items-center gap-2 text-sm">
                  <img src="${f.iconUrl || ""}" class="w-4 h-4" alt="">
                  <span class="flex-1 truncate text-gray-700">${f.fileName || "Untitled"}</span>
                  ${badge(fs.label, fs.tone)}
                </div>
              `;
            }).join("")}
            ${(ws.files?.length || 0) > 4 ? `<div class="text-xs text-gray-400 text-center">+${ws.files.length - 4} more</div>` : ""}
            ${!ws.files?.length ? '<div class="text-sm text-gray-400 text-center py-6">No files yet</div>' : ""}
          </div>
        </div>
        <div class="p-3 flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            <h3 class="font-medium text-gray-900 truncate">${ws.name || "Untitled"}</h3>
            <p class="text-xs text-gray-500 mt-0.5">${ws.created_at ? relTime(ws.created_at) : ""}</p>
            ${others.length ? `<div class="flex items-center gap-1 mt-1.5">
              <div class="flex -space-x-1.5">${members.slice(0, 3).map(m => `<span class="w-5 h-5 rounded-full bg-gray-200 text-[10px] font-medium flex items-center justify-center border-2 border-white ${m.isYou ? "ring-2 ring-blue-400" : ""}">${m.initials || "?"}</span>`).join("")}</div>
              ${members.length > 3 ? `<span class="text-xs text-gray-400">+${members.length - 3}</span>` : ""}
            </div>` : '<span class="text-xs text-gray-400">Private</span>'}
          </div>
          <div class="relative">
            <button class="menu-btn p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" aria-label="Options">
              <i data-lucide="more-horizontal" class="w-4 h-4"></i>
            </button>
            <div class="menu hidden absolute right-0 top-full mt-1 w-32 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-20">
              <button class="delete-btn w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>Delete
              </button>
            </div>
          </div>
        </div>
      </li>
    `;
  };

  const renderAddCard = () => `
    <li class="bg-white rounded-xl border-2 border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50/50 transition-all cursor-pointer flex flex-col items-center justify-center min-h-[200px] group" id="add-card">
      <div class="w-12 h-12 rounded-full bg-gray-100 group-hover:bg-blue-100 flex items-center justify-center mb-3 transition-colors">
        <i data-lucide="plus" class="w-6 h-6 text-gray-400 group-hover:text-blue-500"></i>
      </div>
      <span class="font-medium text-gray-600 group-hover:text-blue-600">Create Workspace</span>
    </li>
  `;

  const renderEmpty = () => `
    <li class="col-span-full text-center py-12 text-gray-500">
      No workspaces yet. Create one to get started.
    </li>
  `;

  const renderError = (msg) => `
    <li class="col-span-full text-center py-12 text-red-500">
      ${msg}
    </li>
  `;

  const renderSkeleton = () => `
    <li class="bg-white rounded-xl border border-gray-200 overflow-hidden animate-pulse">
      <div class="p-4 border-b border-gray-100 h-[140px] bg-gray-100"></div>
      <div class="p-3"><div class="h-4 bg-gray-200 rounded w-2/3"></div><div class="h-3 bg-gray-100 rounded w-1/3 mt-2"></div></div>
    </li>
  `.repeat(3);

  // Render grid
  const render = (workspaces) => {
    if (!workspaces?.length) {
      grid.innerHTML = renderEmpty() + renderAddCard();
    } else {
      grid.innerHTML = workspaces.map(renderCard).join("") + renderAddCard();
    }
    lucide?.createIcons?.();
    bindEvents();
  };

  const bindEvents = () => {
    // Card click → open modal
    $$(".wfws-grid > li[data-ws]").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".menu-btn, .menu")) return;
        openModal(JSON.parse(card.dataset.ws));
      });
    });

    // Menu toggle
    $$(".menu-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = btn.nextElementSibling;
        $$(".menu").forEach(m => m !== menu && m.classList.add("hidden"));
        menu.classList.toggle("hidden");
      });
    });

    // Delete button
    $$(".delete-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const card = btn.closest("li[data-ws]");
        openDeleteModal(JSON.parse(card.dataset.ws));
      });
    });

    // Add card
    $("#add-card")?.addEventListener("click", () => {
      window.WFWSAddWorkspace?.open?.({ uploadApi: UPLOAD_API, userId: USER_ID, onSuccess: () => refresh() });
    });
  };

  // Close menus on outside click
  document.addEventListener("click", () => $$(".menu").forEach(m => m.classList.add("hidden")));

  // Modal logic
  const openModal = (ws) => {
    currentWs = ws;
    const info = getStatus(ws);
    
    $("#modal-title").textContent = ws.name || "Untitled";
    $("#modal-date").textContent = ws.created_at ? `Created ${relTime(ws.created_at)}` : "";
    $("#modal-status").innerHTML = badge(info.label, info.tone);
    
    const filesList = $("#modal-files");
    filesList.innerHTML = (ws.files || []).map(f => {
      const fs = getFileStatus(f);
      return `
        <div class="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
          <img src="${f.iconUrl || ""}" class="w-5 h-5" alt="">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-gray-900 truncate">${f.fileName || "Untitled"}</div>
            <div class="text-xs text-gray-500">${f.fileType || "file"}</div>
          </div>
          ${badge(fs.label, fs.tone)}
        </div>
      `;
    }).join("") || '<div class="text-gray-400 text-center py-6">No files</div>';
    
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  };

  const closeModal = () => {
    modal?.classList.add("hidden");
    deleteModal?.classList.add("hidden");
    document.body.style.overflow = "";
    currentWs = null;
    deleteTarget = null;
  };

  const openDeleteModal = (ws) => {
    deleteTarget = ws;
    const members = getMembers(ws).filter(m => !m.isYou);
    
    $("#delete-name").textContent = `"${ws.name || "Untitled"}"`;
    const affectedEl = $("#delete-affected");
    const listEl = $("#delete-affected-list");
    
    if (members.length) {
      affectedEl.classList.remove("hidden");
      listEl.innerHTML = members.map(m => `
        <div class="flex items-center gap-2 py-1">
          <span class="w-6 h-6 rounded-full bg-gray-200 text-xs font-medium flex items-center justify-center">${m.initials || "?"}</span>
          <span class="text-sm text-gray-700">${m.displayName || m.email || "Member"}</span>
        </div>
      `).join("");
    } else {
      affectedEl.classList.add("hidden");
    }
    
    $("#delete-confirm").disabled = false;
    $("#delete-confirm").innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>Delete';
    deleteModal.classList.remove("hidden");
    lucide?.createIcons?.();
  };

  const performDelete = async () => {
    if (!deleteTarget || !DELETE_API) return;
    
    const btn = $("#delete-confirm");
    btn.disabled = true;
    btn.innerHTML = '<span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>Deleting...';
    
    try {
      const res = await fetch(DELETE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: deleteTarget.workspaceId, userId: USER_ID })
      });
      if (!res.ok) throw new Error("Delete failed");
      closeModal();
      refresh();
    } catch (err) {
      console.error("Delete error:", err);
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="trash-2" class="w-4 h-4"></i>Retry';
      lucide?.createIcons?.();
    }
  };

  // Bind modal events
  $$("#wfws-modal .close-btn, #wfws-modal .backdrop").forEach(el => el?.addEventListener("click", closeModal));
  $$("#wfws-delete-modal .close-btn, #wfws-delete-modal .backdrop, #delete-cancel").forEach(el => el?.addEventListener("click", closeModal));
  $("#delete-confirm")?.addEventListener("click", performDelete);
  document.addEventListener("keydown", e => e.key === "Escape" && closeModal());

  // Fetch logic
  const fetchWorkspaces = async () => {
    if (controller) controller.abort();
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
      const userId = USER_ID || "public";
      const res = await fetch(`${API}?userId=${encodeURIComponent(userId)}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" }
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const payload = typeof data.body === "string" ? JSON.parse(data.body) : data;
      return payload?.workspaces || [];
    } catch (err) {
      clearTimeout(timeout);
      if (err.name !== "AbortError") throw err;
      return null;
    }
  };

  const refresh = async () => {
    if (pollTimer) clearTimeout(pollTimer);
    
    if (!API) {
      grid.innerHTML = renderError("API not configured") + renderAddCard();
      lucide?.createIcons?.();
      return;
    }
    
    try {
      const workspaces = await fetchWorkspaces();
      if (workspaces !== null) {
        render(workspaces);
        const hasPending = workspaces.some(ws => getStatus(ws).tone === "pending");
        pollTimer = setTimeout(refresh, hasPending ? POLL_ACTIVE : POLL_IDLE);
      }
    } catch (err) {
      console.error("[Workspaces] Fetch failed", err);
      grid.innerHTML = renderError("Failed to load workspaces") + renderAddCard();
      lucide?.createIcons?.();
      pollTimer = setTimeout(refresh, POLL_IDLE);
    }
  };

  // Visibility handling
  document.addEventListener("visibilitychange", () => !document.hidden && refresh());
  window.addEventListener("wfws:workspace-created", refresh);

  // Initial load
  grid.innerHTML = renderSkeleton() + renderAddCard();
  lucide?.createIcons?.();
  refresh();
})();
