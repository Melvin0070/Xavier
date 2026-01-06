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
    const hasFiles = ws.files && ws.files.length > 0;
    
    return `
      <li class="group relative bg-white rounded-2xl border border-gray-100 hover:border-gray-200 hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-all duration-300 hover:-translate-y-1 cursor-pointer overflow-hidden flex flex-col h-full opacity-0 animate-in fade-in slide-in-from-bottom-4 fill-mode-forwards" style="animation-duration: 500ms" data-ws='${JSON.stringify(ws).replace(/'/g, "&#39;")}'>
        <!-- Card Header / Preview -->
        <div class="relative h-64 bg-gray-50/50 p-6 border-b border-gray-100 flex flex-col">
          ${info.tone === "pending" ? `
            <div class="absolute inset-0 bg-white/60 backdrop-blur-[1px] flex flex-col items-center justify-center z-10 transition-opacity">
              <div class="flex items-center gap-2 text-amber-600 bg-amber-50 px-3 py-1.5 rounded-full border border-amber-100 shadow-sm">
                <div class="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
                <span class="text-xs font-semibold">Processing...</span>
              </div>
            </div>
          ` : ""}
          
          <div class="flex-1 space-y-3 overflow-hidden">
            ${(ws.files || []).slice(0, 3).map(f => {
              const fs = getFileStatus(f);
              return `
                <div class="flex items-center gap-4 group/file p-2 rounded-lg hover:bg-white transition-colors">
                  <div class="w-10 h-10 rounded-lg bg-white border border-gray-200 flex items-center justify-center text-gray-400 shrink-0 shadow-sm transition-transform group-hover/file:scale-105">
                    <img src="${f.iconUrl || ""}" class="w-5 h-5 object-contain opacity-75 group-hover/file:opacity-100 transition-opacity" alt="">
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="font-medium text-gray-700 truncate text-sm leading-tight mb-0.5">${f.fileName || "Untitled"}</div>
                    <div class="text-xs text-gray-400 flex items-center gap-1.5 leading-none">
                      <span class="w-1.5 h-1.5 rounded-full ${fs.tone === 'ready' ? 'bg-emerald-400' : fs.tone === 'error' ? 'bg-red-400' : 'bg-amber-400'}"></span>
                      ${fs.label}
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
            
            ${!hasFiles ? `
              <div class="h-full flex flex-col items-center justify-center text-gray-300 space-y-2">
                <div class="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center">
                  <i data-lucide="folder-open" class="w-6 h-6 opacity-40"></i>
                </div>
                <span class="text-xs font-medium uppercase tracking-wide opacity-60">No files</span>
              </div>
            ` : ""}
          </div>
          
          ${hasFiles && ws.files.length > 3 ? `
            <div class="mt-auto pt-3 text-xs font-medium text-gray-400 flex items-center gap-2">
              <div class="flex -space-x-1">
                <div class="w-2 h-2 rounded-full bg-gray-300 ring-2 ring-gray-50"></div>
                <div class="w-2 h-2 rounded-full bg-gray-300 ring-2 ring-gray-50"></div>
                <div class="w-2 h-2 rounded-full bg-gray-300 ring-2 ring-gray-50"></div>
              </div>
              <span>+${ws.files.length - 3} more files</span>
            </div>
          ` : ""}
        </div>

        <!-- Card Body -->
        <div class="p-6 flex flex-col gap-4 flex-1">
          <div>
            <div class="flex items-start justify-between gap-4 mb-2">
               <h3 class="text-lg font-bold text-gray-900 truncate tracking-tight group-hover:text-blue-600 transition-colors">${ws.name || "Untitled"}</h3>
               ${badge(info.label, info.tone)}
            </div>
            <div class="flex items-center gap-4 text-sm text-gray-500">
               <span class="flex items-center gap-1.5">
                  <i data-lucide="calendar" class="w-3.5 h-3.5 text-gray-400"></i>
                  ${ws.created_at ? relTime(ws.created_at) : "Recently"}
               </span>
               <span class="w-1 h-1 rounded-full bg-gray-300"></span>
               <span>${ws.files?.length || 0} files</span>
            </div>
          </div>

          <div class="pt-4 border-t border-gray-100 flex items-center justify-between gap-4 mt-auto">
            <!-- Members Stack -->
            <div class="flex items-center">
            ${others.length ? `
              <div class="flex items-center -space-x-2 pl-1">
                ${members.slice(0, 4).map(m => `
                  <div class="relative group/avatar transition-transform hover:z-10 hover:scale-110" title="${m.displayName || "Member"}">
                    <div class="w-8 h-8 rounded-full bg-white border-2 border-white flex items-center justify-center ring-1 ring-gray-100 overflow-hidden text-[10px] font-bold text-gray-600 ${m.isYou ? "bg-blue-50 text-blue-600 ring-blue-100" : "bg-gray-50"}">
                      ${m.initials}
                    </div>
                  </div>
                `).join("")}
                ${members.length > 4 ? `
                  <div class="w-8 h-8 rounded-full bg-gray-50 border-2 border-white flex items-center justify-center ring-1 ring-gray-100 text-[10px] font-medium text-gray-500 z-10">
                    +${members.length - 4}
                  </div>
                ` : ""}
              </div>
            ` : `
              <div class="flex items-center gap-2 text-xs font-medium text-gray-400 bg-gray-50 px-2.5 py-1.5 rounded-md border border-gray-100">
                <i data-lucide="lock" class="w-3.5 h-3.5"></i>
                Private Workspace
              </div>
            `}
            </div>

            <!-- Actions Menu -->
            <div class="relative">
              <button class="menu-btn p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all focus:outline-none opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 duration-200" aria-label="Menu">
                <i data-lucide="more-horizontal" class="w-5 h-5"></i>
              </button>
              <div class="menu hidden absolute right-0 bottom-full mb-2 w-40 bg-white rounded-xl shadow-[0_10px_40px_-10px_rgba(0,0,0,0.1)] border border-gray-100 py-1.5 z-30 transform origin-bottom-right animate-in fade-in zoom-in-95 duration-100">
                <button class="delete-btn w-full px-3 py-2 text-left text-sm font-medium text-red-600 hover:bg-red-50 flex items-center gap-2.5 transition-colors">
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
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
    <li class="group bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200 hover:border-blue-400 hover:bg-blue-50/50 transition-all duration-300 cursor-pointer flex flex-col items-center justify-center min-h-[400px]" id="add-card">
      <div class="w-16 h-16 rounded-2xl bg-white shadow-sm border border-gray-100 group-hover:border-blue-200 group-hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] flex items-center justify-center mb-4 transition-all duration-300 transform group-hover:scale-110 group-hover:-translate-y-1">
        <i data-lucide="plus" class="w-8 h-8 text-gray-400 group-hover:text-blue-500 transition-colors"></i>
      </div>
      <h3 class="font-bold text-lg text-gray-900 group-hover:text-blue-600 transition-colors">Create Workspace</h3>
      <p class="text-sm text-gray-500 mt-2 text-center max-w-[200px]">Start a new project to organize your files and collaborate.</p>
    </li>
  `;

  const renderEmpty = () => `
    <li class="col-span-full flex flex-col items-center justify-center py-24 text-gray-500 border-2 rounded-2xl border-dashed border-gray-200 bg-gray-50/30">
      <div class="w-20 h-20 bg-white rounded-full flex items-center justify-center mb-6 shadow-sm border border-gray-100">
        <i data-lucide="layout" class="w-10 h-10 text-gray-300"></i>
      </div>
      <h3 class="text-xl font-bold text-gray-900 mb-2">No workspaces yet</h3>
      <p class="text-base text-gray-500 max-w-md text-center">Create your first workspace above to start organizing your files and collaborating with your team.</p>
    </li>
  `;

  const renderError = (msg) => `
    <li class="col-span-full text-center py-16 text-red-600 bg-red-50 rounded-2xl border border-red-100 flex flex-col items-center justify-center">
      <div class="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mb-3">
        <i data-lucide="alert-circle" class="w-6 h-6"></i>
      </div>
      <p class="font-medium text-lg">Unable to load workspaces</p>
      <p class="text-sm text-red-500 mt-1 opacity-80">${msg}</p>
    </li>
  `;

  const renderSkeleton = () => `
    <li class="bg-white rounded-2xl border border-gray-200 overflow-hidden flex flex-col animate-pulse">
      <div class="h-64 bg-gray-100 border-b border-gray-100"></div>
      <div class="p-6 flex-1 space-y-4">
        <div class="space-y-3">
          <div class="h-6 bg-gray-100 rounded w-3/4"></div>
          <div class="h-4 bg-gray-50 rounded w-1/2"></div>
        </div>
        <div class="pt-6 mt-auto border-t border-gray-50 flex items-center justify-between">
          <div class="w-24 h-8 bg-gray-100 rounded-full"></div>
          <div class="w-8 h-8 bg-gray-100 rounded"></div>
        </div>
      </div>
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
    const members = getMembers(ws);
    
    $("#modal-title").textContent = ws.name || "Untitled";
    $("#modal-date").textContent = ws.created_at ? `Created ${relTime(ws.created_at)}` : "";
    $("#modal-status").innerHTML = badge(info.label, info.tone);
    
    // Render Members
    const membersList = $("#modal-members");
    if (membersList) {
        membersList.innerHTML = members.map(m => `
            <div class="flex items-start gap-3 p-3 rounded-xl border border-gray-100 bg-gray-50/50">
                <div class="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold border border-white shadow-sm ring-1 ring-gray-100 ${m.isYou ? "bg-blue-50 text-blue-600 ring-blue-100" : "bg-white text-gray-600"}">
                    ${m.initials}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-bold text-gray-900 flex items-center flex-wrap gap-2">
                        ${m.displayName || m.email || "Unknown"}
                        <div class="flex gap-1">
                          ${m.isYou ? '<span class="text-[10px] uppercase tracking-wide bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100 font-bold">You</span>' : ''}
                          ${m.isOwner ? '<span class="text-[10px] uppercase tracking-wide bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded border border-amber-100 font-bold">Owner</span>' : ''}
                        </div>
                    </div>
                    <div class="text-xs text-gray-500 truncate mt-0.5">${m.email || ""}</div>
                </div>
            </div>
        `).join("");
    }
    
    // Render Files
    const filesList = $("#modal-files");
    filesList.innerHTML = (ws.files || []).map(f => {
      const fs = getFileStatus(f);
      return `
        <div class="flex items-center gap-4 p-3 rounded-xl border border-gray-100 bg-white hover:border-gray-200 hover:shadow-sm transition-all group">
          <div class="w-10 h-10 rounded-lg bg-gray-50 border border-gray-100 flex items-center justify-center shrink-0">
            <img src="${f.iconUrl || ""}" class="w-5 h-5 object-contain opacity-75 group-hover:opacity-100 transition-opacity" alt="">
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-gray-900 truncate">${f.fileName || "Untitled"}</div>
            <div class="text-xs text-gray-400 uppercase tracking-wide mt-0.5 font-semibold">${f.fileType || "FILE"}</div>
          </div>
          ${badge(fs.label, fs.tone)}
        </div>
      `;
    }).join("") || '<div class="flex flex-col items-center justify-center py-12 text-gray-400 border-2 border-dashed border-gray-100 rounded-xl bg-gray-50/20"><i data-lucide="file-x" class="w-10 h-10 mb-3 opacity-20"></i><span class="text-sm font-medium">No files uploaded yet</span></div>';
    
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
          <span class="w-6 h-6 rounded-full bg-gray-100 border border-gray-200 text-[10px] font-bold flex items-center justify-center text-gray-600">${m.initials || "?"}</span>
          <span class="text-sm text-gray-700 font-medium">${m.displayName || m.email || "Member"}</span>
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
