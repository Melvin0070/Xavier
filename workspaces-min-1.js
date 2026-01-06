/**
 * Workspaces Grid - Shadcn UI Version
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

  // Badge component (Shadcn style)
  const badge = (label, tone) => {
    const styles = {
      ready: "bg-emerald-50 text-emerald-700 border-emerald-200",
      pending: "bg-amber-50 text-amber-700 border-amber-200",
      error: "bg-red-50 text-red-700 border-red-200"
    };
    return `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-full border ${styles[tone] || styles.pending} transition-colors">
      ${tone === "pending" ? '<span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>' : '<span class="w-1.5 h-1.5 rounded-full bg-current"></span>'}
      ${label}
    </span>`;
  };

  // Render card
  const renderCard = (ws) => {
    const info = getStatus(ws);
    const members = getMembers(ws);
    const others = members.filter(m => !m.isOwner);
    
    return `
      <li class="group bg-white rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-md transition-all duration-200 cursor-pointer overflow-hidden flex flex-col h-full" data-ws='${JSON.stringify(ws).replace(/'/g, "&#39;")}'>
        <!-- Card Header / Preview -->
        <div class="relative h-32 bg-slate-50 border-b border-slate-100 p-4">
          ${info.tone === "pending" ? `
            <div class="absolute inset-0 bg-white/60 backdrop-blur-[1px] flex flex-col items-center justify-center z-10 transition-opacity">
              <div class="flex items-center gap-2 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full border border-amber-100 shadow-sm">
                <div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                <span class="text-xs font-semibold">Processing...</span>
              </div>
            </div>
          ` : ""}
          <div class="space-y-2.5">
            ${(ws.files || []).slice(0, 3).map(f => {
              const fs = getFileStatus(f);
              return `
                <div class="flex items-center gap-3 text-sm group/file">
                  <div class="w-7 h-7 rounded-md bg-white border border-slate-200 flex items-center justify-center text-slate-400 shrink-0 shadow-sm">
                    <img src="${f.iconUrl || ""}" class="w-3.5 h-3.5 object-contain opacity-75 group-hover/file:opacity-100 transition-opacity" alt="">
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-slate-700 truncate text-xs leading-none mb-1">${f.fileName || "Untitled"}</div>
                    <div class="text-[10px] text-slate-400 flex items-center gap-1.5 leading-none">
                      <span class="w-1 h-1 rounded-full ${fs.tone === 'ready' ? 'bg-emerald-400' : fs.tone === 'error' ? 'bg-red-400' : 'bg-amber-400'}"></span>
                      ${fs.label}
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
            ${!ws.files?.length ? `
              <div class="h-full flex flex-col items-center justify-center text-slate-400 space-y-1 mt-4">
                <i data-lucide="folder-open" class="w-6 h-6 opacity-20"></i>
                <span class="text-[10px] font-medium uppercase tracking-wide opacity-50">Empty</span>
              </div>
            ` : (ws.files.length > 3 ? `<div class="text-[10px] text-slate-400 font-medium pl-1">+${ws.files.length - 3} more files</div>` : "")}
          </div>
        </div>

        <!-- Card Body -->
        <div class="p-4 flex flex-col gap-3 flex-1 justify-between">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <h3 class="font-semibold text-slate-900 truncate text-sm leading-tight group-hover:text-blue-600 transition-colors">${ws.name || "Untitled"}</h3>
              <p class="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1.5">
                <i data-lucide="calendar" class="w-3 h-3 text-slate-400"></i>
                ${ws.created_at ? relTime(ws.created_at) : "Recently"}
              </p>
            </div>
            ${badge(info.label, info.tone)}
          </div>

          <div class="pt-3 border-t border-slate-100 flex items-center justify-between gap-4 mt-auto">
            <!-- Members Stack -->
            ${others.length ? `
              <div class="flex items-center -space-x-2 hover:space-x-0.5 transition-all duration-300 pl-1">
                ${members.slice(0, 4).map(m => `
                  <div class="relative group/avatar" title="${m.displayName || "Member"}">
                    <div class="w-6 h-6 rounded-full bg-white border-2 border-white flex items-center justify-center ring-1 ring-slate-200 overflow-hidden text-[9px] font-bold text-slate-600 ${m.isYou ? "bg-blue-50 text-blue-600 ring-blue-100" : "bg-slate-50"}">
                      ${m.initials}
                    </div>
                  </div>
                `).join("")}
                ${members.length > 4 ? `
                  <div class="w-6 h-6 rounded-full bg-slate-50 border-2 border-white flex items-center justify-center ring-1 ring-slate-200 text-[9px] font-medium text-slate-500 z-10">
                    +${members.length - 4}
                  </div>
                ` : ""}
              </div>
            ` : `
              <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-medium text-slate-400 bg-slate-50 px-2 py-1 rounded border border-slate-100">
                <i data-lucide="lock" class="w-3 h-3"></i>
                Private
              </div>
            `}

            <!-- Actions Menu -->
            <div class="relative ml-auto">
              <button class="menu-btn p-1.5 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-200 opacity-0 group-hover:opacity-100 transition-opacity" aria-label="Menu">
                <i data-lucide="more-horizontal" class="w-4 h-4"></i>
              </button>
              <div class="menu hidden absolute right-0 bottom-full mb-1 w-32 bg-white rounded-lg shadow-xl ring-1 ring-slate-200 py-1 z-30 transform origin-bottom-right">
                <button class="delete-btn w-full px-3 py-1.5 text-left text-xs font-medium text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </li>
    `;
  };

  const renderAddCard = () => `
    <li class="group bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 hover:border-blue-400 hover:bg-blue-50/30 transition-all duration-200 cursor-pointer flex flex-col items-center justify-center min-h-[220px]" id="add-card">
      <div class="w-12 h-12 rounded-xl bg-white shadow-sm border border-slate-100 group-hover:border-blue-200 group-hover:shadow-md flex items-center justify-center mb-3 transition-all duration-300 transform group-hover:-translate-y-1">
        <i data-lucide="plus" class="w-6 h-6 text-slate-400 group-hover:text-blue-500 transition-colors"></i>
      </div>
      <span class="font-medium text-sm text-slate-600 group-hover:text-blue-600 transition-colors">Create Workspace</span>
      <span class="text-xs text-slate-400 mt-1">Click to get started</span>
    </li>
  `;

  const renderEmpty = () => `
    <li class="col-span-full flex flex-col items-center justify-center py-16 text-slate-500 border rounded-xl border-dashed border-slate-200 bg-slate-50/50">
      <div class="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-4 shadow-sm border border-slate-100">
        <i data-lucide="layout" class="w-8 h-8 text-slate-300"></i>
      </div>
      <h3 class="text-lg font-medium text-slate-900">No workspaces yet</h3>
      <p class="text-sm text-slate-500 mt-1 max-w-xs text-center">Create your first workspace to start organizing your files and collaborating.</p>
    </li>
  `;

  const renderError = (msg) => `
    <li class="col-span-full text-center py-12 text-red-500 bg-red-50 rounded-xl border border-red-100">
      <i data-lucide="alert-circle" class="w-8 h-8 mx-auto mb-2 opacity-50"></i>
      <p class="font-medium">${msg}</p>
    </li>
  `;

  const renderSkeleton = () => `
    <li class="bg-white rounded-xl border border-slate-200 overflow-hidden h-[240px] flex flex-col">
      <div class="h-32 bg-slate-100 animate-pulse border-b border-slate-100"></div>
      <div class="p-4 flex-1 space-y-4">
        <div class="space-y-2">
          <div class="h-4 bg-slate-100 rounded w-2/3 animate-pulse"></div>
          <div class="h-3 bg-slate-50 rounded w-1/3 animate-pulse"></div>
        </div>
        <div class="pt-4 mt-auto border-t border-slate-50 flex items-center justify-between">
          <div class="w-20 h-6 bg-slate-100 rounded-full animate-pulse"></div>
          <div class="w-6 h-6 bg-slate-100 rounded animate-pulse"></div>
        </div>
      </div>
    </li>
  `.repeat(4);

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
    const members = getMembers(ws);
    
    $("#modal-title").textContent = ws.name || "Untitled";
    $("#modal-date").textContent = ws.created_at ? `Created ${relTime(ws.created_at)}` : "";
    $("#modal-status").innerHTML = badge(info.label, info.tone);
    
    // Render Members
    const membersList = $("#modal-members");
    if (membersList) {
        membersList.innerHTML = members.map(m => `
            <div class="flex items-start gap-3 p-3 rounded-lg border border-slate-100 bg-slate-50/50">
                <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border border-white shadow-sm ring-1 ring-slate-100 ${m.isYou ? "bg-blue-100 text-blue-700" : "bg-white text-slate-600"}">
                    ${m.initials}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-slate-900 flex items-center flex-wrap gap-2">
                        ${m.displayName || m.email || "Unknown"}
                        <div class="flex gap-1">
                          ${m.isYou ? '<span class="text-[9px] uppercase tracking-wide bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100 font-semibold">You</span>' : ''}
                          ${m.isOwner ? '<span class="text-[9px] uppercase tracking-wide bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded border border-amber-100 font-semibold">Owner</span>' : ''}
                        </div>
                    </div>
                    <div class="text-xs text-slate-500 truncate mt-0.5">${m.email || ""}</div>
                </div>
            </div>
        `).join("");
    }
    
    // Render Files
    const filesList = $("#modal-files");
    filesList.innerHTML = (ws.files || []).map(f => {
      const fs = getFileStatus(f);
      return `
        <div class="flex items-center gap-4 p-3 rounded-lg border border-slate-100 bg-white hover:border-slate-200 hover:shadow-sm transition-all group">
          <div class="w-10 h-10 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
            <img src="${f.iconUrl || ""}" class="w-5 h-5 object-contain opacity-75 group-hover:opacity-100 transition-opacity" alt="">
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-900 truncate">${f.fileName || "Untitled"}</div>
            <div class="text-xs text-slate-500 uppercase tracking-wide mt-0.5 font-medium">${f.fileType || "FILE"}</div>
          </div>
          ${badge(fs.label, fs.tone)}
        </div>
      `;
    }).join("") || '<div class="flex flex-col items-center justify-center py-10 text-slate-400 border-2 border-dashed border-slate-100 rounded-xl bg-slate-50/30"><i data-lucide="file-x" class="w-8 h-8 mb-2 opacity-30"></i><span class="text-sm">No files uploaded yet</span></div>';
    
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
          <span class="w-5 h-5 rounded-full bg-slate-100 border border-slate-200 text-[10px] font-medium flex items-center justify-center text-slate-600">${m.initials || "?"}</span>
          <span class="text-sm text-slate-700">${m.displayName || m.email || "Member"}</span>
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
