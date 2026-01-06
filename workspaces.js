/**
 * Workspace Assets Module
 * Optimized version with cleaner code structure and enhanced UX
 * @version 2.0.0
 */

// Initialize dayjs plugin
if (window.dayjs && window.dayjs_plugin_relativeTime) {
  dayjs.extend(window.dayjs_plugin_relativeTime);
}

(function () {

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  const CONFIG = {
    FETCH_TIMEOUT: 30000,
    POLL_DELAY_ACTIVE: 2500,
    POLL_DELAY_ERROR: 8000,
    POLL_DELAY_STABLE: [25000, 60000, 120000, 300000],
    MAX_POLLS: 20,
    STABLE_TIMEOUT: 300000,
  };

  const STATUS = {
    READY: "ready",
    PENDING: "pending",
    PROCESSING: "processing",
    UPLOADED: "uploaded",
    ERROR: "error",
    CREATED: "created",
  };

  const LABELS = {
    file: {
      ready: "Ready",
      processing: "Processing",
      uploaded: "Uploaded",
      error: "Failed",
    },
    workspace: {
      ready: "Ready",
      readyWithIssues: "Ready with issues",
      processing: "Processing",
      preparing: "Preparing",
    },
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create element with optional properties and children
   * @param {string} tag - HTML tag name
   * @param {Object} props - Properties to set (className, textContent, etc.)
   * @param {Array<Node|string>} children - Child elements or text
   * @returns {HTMLElement}
   */
  const el = (tag, props = {}, children = []) => {
    const element = document.createElement(tag);
    
    Object.entries(props).forEach(([key, value]) => {
      if (key === "className") element.className = value;
      else if (key === "textContent") element.textContent = value;
      else if (key === "innerHTML") element.innerHTML = value;
      else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (key.startsWith("data-")) {
        element.setAttribute(key, value);
      } else if (key.startsWith("aria-") || key === "role" || key === "tabindex") {
        element.setAttribute(key, value);
      } else {
        element[key] = value;
      }
    });

    children.forEach((child) => {
      if (child) {
        element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
    });

    return element;
  };

  /** Query helper */
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  const root = document.getElementById("wf-workspaces");
  if (!root || root.dataset.init === "1") return;
  root.dataset.init = "1";

  // State
  const state = {
    pollTimerId: null,
    fetchController: null,
    hasPending: false,
    renderedOnce: false,
    loggedAnonymous: false,
    snapshots: new Map(),
    fetchFailed: false,
    pollCount: 0,
    backoffIndex: 0,
    stableTime: null,
    currentWorkspace: null,
    deleteTarget: null,
    isDeleting: false,
  };

  // Cache DOM references
  const dom = {
    grid: $(".wfws-grid", root),
    modal: $(".wfws-modal", root),
    deleteModal: $("#wfws-delete-modal", root),
  };

  // API configuration
  const api = {
    fetch: root.dataset.api || "",
    upload: root.dataset.uploadApi || root.dataset.createApi || "",
    create: root.dataset.createApi || "",
    delete: root.dataset.deleteApi || "",
  };

  const USER_ID = getUserId();

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  function getUserId() {
    try {
      const data = JSON.parse(localStorage.getItem("_ms-mem") || "{}");
      return data?.id || data?.member_id || null;
    } catch {
      return null;
    }
  }

  function normalize(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function relativeTime(iso) {
    if (!iso) return "";
    try {
      return window.dayjs ? dayjs(iso).fromNow() : new Date(iso).toLocaleString();
    } catch {
      return "";
    }
  }

  function pluralize(count, singular, plural = `${singular}s`) {
    return count === 1 ? singular : plural;
  }

  function safeUrl(value, protocols = ["http:", "https:"]) {
    try {
      const url = new URL(String(value), location.origin);
      return protocols.includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCROLL & FOCUS MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  function lockScroll() {
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.classList.add("wfws-modal-open");
  }

  function unlockScroll() {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
    document.body.classList.remove("wfws-modal-open");
  }

  function trapFocus(container) {
    const focusable = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';
    const elements = $$(focusable, container).filter((el) => el.offsetParent !== null);
    if (!elements.length) return () => {};

    const [first, last] = [elements[0], elements.at(-1)];

    const handler = (e) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  function toast(type, title, description) {
    const sonner = window.sonnerJS;
    if (typeof sonner !== "function") return;
    const fn = sonner[type] || sonner;
    return typeof fn === "function" ? fn(title, description ? { description } : undefined) : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function getFileStatus(file) {
    const status = normalize(file?.status);
    return {
      status,
      label: LABELS.file[status] || "Processing",
      tone: { ready: STATUS.READY, processing: STATUS.PENDING, uploaded: STATUS.UPLOADED, error: STATUS.ERROR }[status] || STATUS.PENDING,
    };
  }

  function getWorkspaceStatus(ws) {
    const status = normalize(ws?.status);
    const total = Number(ws?.fileCount || 0);
    const ready = Number(ws?.fileStatusCounts?.ready || 0);
    const errors = Number(ws?.fileStatusCounts?.error || ws?.errorFileCount || 0);
    const actionable = Math.max(total - errors, 0);
    const pending = Math.max(actionable - ready, 0);

    let tone = STATUS.PENDING;
    let label = LABELS.workspace.processing;

    if (status === STATUS.READY && (pending === 0 || actionable === 0)) {
      tone = STATUS.READY;
      label = errors > 0 && ready > 0 ? LABELS.workspace.readyWithIssues : LABELS.workspace.ready;
    } else if (status === STATUS.CREATED) {
      label = LABELS.workspace.preparing;
    } else if (!status) {
      const isReady = pending === 0 && actionable > 0;
      tone = isReady ? STATUS.READY : STATUS.PENDING;
      label = isReady
        ? errors > 0 ? LABELS.workspace.readyWithIssues : LABELS.workspace.ready
        : total > 0 ? LABELS.workspace.processing : LABELS.workspace.preparing;
    }

    // Build summary text
    let summary = "";
    if (total === 0) {
      summary = tone === STATUS.READY ? "No files yet" : "Awaiting uploads";
    } else if (tone === STATUS.READY) {
      summary = errors > 0 ? `${ready}/${total} ready • ${errors} failed` : `All ${total} ${pluralize(total, "file")} ready`;
    } else if (pending > 0) {
      summary = `${pending} ${pluralize(pending, "file")} processing`;
      if (errors > 0) summary += ` • ${errors} failed`;
    } else {
      summary = `${ready}/${total} files ready`;
      if (errors > 0) summary += ` • ${errors} failed`;
    }

    const percent = actionable > 0 ? Math.round((ready / actionable) * 100) : (tone === STATUS.READY && ready > 0 ? 100 : 0);

    return { status, tone, label, summary, ready, total, pending, percent, errors, actionable };
  }

  function hasPendingWork(workspaces) {
    return workspaces?.some((ws) => {
      const wsStatus = normalize(ws?.status);
      if (wsStatus && wsStatus !== STATUS.READY) return true;
      return ws?.files?.some((f) => {
        const s = normalize(f?.status);
        return s && s !== STATUS.READY && s !== STATUS.ERROR;
      });
    }) ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMBERS HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function getInitials(value) {
    const str = String(value || "").trim();
    if (!str) return "?";
    const name = str.includes("@") ? str.split("@")[0] : str;
    return (name.match(/[\p{L}\p{N}]/u)?.[0] || name.charAt(0)).toUpperCase();
  }

  function getDisplayName(member) {
    return member?.displayName || member?.name || member?.email || "Member";
  }

  function getMembers(ws) {
    let members = Array.isArray(ws?.members) ? [...ws.members] : [];

    if (!members.length) {
      const ownerId = ws?.ownerUserId || ws?.userId;
      if (ownerId) {
        members.push({
          userId: ownerId,
          email: ws?.ownerEmail || null,
          role: "owner",
          isOwner: true,
          isYou: USER_ID ? String(ownerId) === String(USER_ID) : false,
        });
      }
      (ws?.sharedUsers || []).forEach((email) => {
        members.push({ userId: null, email, role: "member", isOwner: false, isYou: false });
      });
    }

    return members.map((m) => ({
      userId: m.userId ?? null,
      email: m.email ?? null,
      role: m.role === "owner" ? "owner" : "member",
      isOwner: Boolean(m.isOwner || m.role === "owner"),
      isYou: Boolean(m.isYou),
      displayName: getDisplayName(m),
      initials: getInitials(getDisplayName(m)),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UI COMPONENT BUILDERS
  // ═══════════════════════════════════════════════════════════════════════════

  function createBadge(label, tone = STATUS.PENDING, size = "md") {
    return el("span", {
      className: `wfws-status-badge wfws-status-${tone}${size === "sm" ? " wfws-status-sm" : ""}`,
      textContent: label,
    });
  }

  function createSpinner(size = "md") {
    const sizeClass = { sm: " wfws-spinner-sm", lg: " wfws-spinner-lg" }[size] || "";
    return el("span", { className: `wfws-spinner${sizeClass}` });
  }

  function createBadgeWithSpinner(label, tone, options = {}) {
    const { size = "md", spin } = options;
    const badge = createBadge(label, tone, size);
    const wrap = el("div", { className: "wfws-status-wrap" }, [badge]);
    
    const shouldSpin = typeof spin === "boolean" ? spin : (tone !== STATUS.READY && tone !== STATUS.ERROR);
    if (shouldSpin) wrap.appendChild(createSpinner(size));
    
    return wrap;
  }

  function createProgressOverlay(info) {
    const percent = Math.min(100, Math.max(0, info.percent || 0));
    
    const subText = info.total === 0
      ? "Awaiting uploads"
      : info.actionable > 0
        ? `${info.ready} of ${info.actionable} ready (${info.percent}%)${info.errors > 0 ? ` • ${info.errors} failed` : ""}`
        : `${info.ready} ready`;

    return el("div", { className: "wfws-progress-overlay" }, [
      el("div", { className: "wfws-progress-top" }, [
        createSpinner("lg"),
        el("div", { className: "wfws-progress-text" }, [
          el("div", { className: "wfws-progress-label", textContent: info.label || "Processing" }),
          el("div", { className: "wfws-progress-subtext", textContent: subText }),
        ]),
      ]),
      el("div", { className: "wfws-progress-meter" }, [
        el("div", { className: "wfws-progress-bar" }, [
          el("div", { className: "wfws-progress-fill", style: { width: `${percent}%` } }),
        ]),
      ]),
    ]);
  }

  function createSharingIndicator(ws) {
    const members = getMembers(ws);
    if (!members.length) return null;

    const collaborators = members.filter((m) => !m.isOwner);
    const indicator = el("div", { className: "wfws-share-indicator" });

    if (collaborators.length > 0) {
      indicator.classList.add("is-shared");
      
      const sorted = [...members].sort((a, b) => {
        if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
        return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
      });

      const maxVisible = sorted.length > 3 ? 1 : sorted.length;
      const stack = el("div", { className: "wfws-avatar-stack" });

      sorted.slice(0, maxVisible).forEach((m) => {
        const tags = [m.isOwner ? "Owner" : "Member", m.isYou ? "You" : ""].filter(Boolean).join(" • ");
        const avatar = el("span", {
          className: `wfws-avatar${m.isYou ? " is-you" : ""}`,
          textContent: m.initials,
          title: `${tags} — ${m.displayName}`,
          "aria-label": `${tags} — ${m.displayName}`,
        });
        stack.appendChild(avatar);
      });

      indicator.appendChild(stack);

      const remaining = sorted.length - maxVisible;
      if (remaining > 0) {
        indicator.appendChild(el("span", { className: "wfws-share-more", textContent: `+${remaining} more` }));
      }

      indicator.setAttribute("aria-label", `${sorted.length} workspace ${pluralize(sorted.length, "member")}`);
    } else {
      indicator.classList.add("is-private");
      indicator.appendChild(
        el("div", { className: "wfws-private-label" }, [
          el("span", { className: "wfws-private-copy" }, [
            el("span", { className: "wfws-private-main", textContent: "Private" }),
            el("span", { textContent: "•", "aria-hidden": "true" }),
            el("span", { className: "wfws-private-sub", textContent: "Only you" }),
          ]),
        ])
      );
      indicator.setAttribute("aria-label", "Private workspace. Only you.");
    }

    return indicator;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSPACE CARD RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function renderCard(ws) {
    const info = getWorkspaceStatus(ws);
    const errors = Number(ws?.errorFileCount || ws?.fileStatusCounts?.error || 0);
    const files = ws?.files || [];
    const isOwner = ws.userId && String(ws.userId) === String(USER_ID);

    const card = el("li", {
      className: `wfws-card${info.tone !== STATUS.READY ? " wfws-card-pending" : ""}`,
      role: "article",
      tabindex: "-1",
      "data-status": info.status,
    });

    // Thumbnail area
    const thumb = el("div", { className: "wfws-thumb" });
    const filesWrap = el("div", { className: "wfws-thumb-files" });

    if (files.length > 0) {
      files.slice(0, 5).forEach((file) => {
        const fileEl = el("div", { className: "wfws-thumb-file" }, [
          el("div", { className: "wfws-thumb-file-icon" }, [el("i", { "data-lucide": "file-text" })]),
          el("div", { className: "wfws-thumb-file-info" }, [
            el("div", { className: "wfws-thumb-file-name", textContent: file.fileName || "Untitled" }),
            el("div", { className: "wfws-thumb-file-type", textContent: (file.fileType || "file").toUpperCase() }),
          ]),
        ]);
        filesWrap.appendChild(fileEl);
      });
      if (files.length > 5) {
        filesWrap.appendChild(
          el("div", { className: "wfws-thumb-more", textContent: `+${files.length - 5} more files` })
        );
      }
    } else {
      filesWrap.appendChild(el("div", { className: "wfws-thumb-empty", textContent: "No files yet" }));
    }

    thumb.appendChild(filesWrap);

    if (errors > 0) {
      const errorPill = createBadge(`${errors} failed`, STATUS.ERROR, "sm");
      errorPill.classList.add("wfws-error-pill");
      errorPill.setAttribute("aria-label", `${errors} ${pluralize(errors, "file")} failed`);
      thumb.appendChild(errorPill);
    }

    if (info.tone !== STATUS.READY) {
      thumb.appendChild(createProgressOverlay(info));
    }

    const thumbLink = el("a", { className: "wfws-link", href: "#", "aria-label": ws.name || "Workspace" });
    thumbLink.appendChild(thumb);
    thumbLink.addEventListener("click", (e) => {
      e.preventDefault();
      openWorkspaceModal(ws, card);
    });
    card.appendChild(thumbLink);

    // Meta row
    const meta = el("div", { className: "wfws-meta" });

    const textWrap = el("a", { className: "wfws-link wfws-text", href: "#", "aria-label": ws.name });
    textWrap.addEventListener("click", (e) => {
      e.preventDefault();
      openWorkspaceModal(ws, card);
    });

    const metaParts = [info.summary, ws.created_at ? relativeTime(ws.created_at) : ""].filter(Boolean);
    textWrap.appendChild(el("div", { className: "wfws-title", textContent: ws.name || "Untitled" }));
    textWrap.appendChild(el("div", { className: "wfws-time", textContent: metaParts.join(" • ") }));

    const shareIndicator = createSharingIndicator(ws);
    if (shareIndicator) textWrap.appendChild(shareIndicator);

    meta.appendChild(textWrap);

    // Three-dot menu (owner only)
    if (isOwner) {
      const menuWrap = el("div", { className: "wfws-menu-wrap" });
      const menuBtn = el("button", {
        className: "wfws-menu-btn",
        "aria-label": "Workspace options",
        "aria-haspopup": "true",
        "aria-expanded": "false",
        innerHTML: '<i data-lucide="more-horizontal"></i>',
      });
      const dropdown = el("div", { className: "wfws-dropdown", role: "menu" });
      const deleteBtn = el("button", {
        className: "wfws-dropdown-item danger",
        role: "menuitem",
        innerHTML: '<i data-lucide="trash-2"></i><span>Delete</span>',
      });

      deleteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllDropdowns();
        openDeleteModal(ws);
      });

      menuBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllDropdowns(dropdown);
        const isOpen = dropdown.classList.toggle("open");
        menuBtn.setAttribute("aria-expanded", String(isOpen));
        if (window.lucide) lucide.createIcons();
      });

      dropdown.appendChild(deleteBtn);
      menuWrap.appendChild(menuBtn);
      menuWrap.appendChild(dropdown);
      meta.appendChild(menuWrap);
    }

    // Status badges
    const badges = el("div", { className: "wfws-meta-badges" });
    badges.appendChild(createBadgeWithSpinner(info.label, info.tone));
    
    if (errors > 0) {
      const errorBadge = createBadge(`${errors} failed`, STATUS.ERROR, "sm");
      errorBadge.setAttribute("aria-label", `${errors} ${pluralize(errors, "file")} failed`);
      badges.appendChild(createBadgeWithSpinner(`${errors} failed`, STATUS.ERROR, { size: "sm", spin: false }));
    }

    meta.appendChild(badges);
    card.appendChild(meta);

    return card;
  }

  function renderAddCard() {
    const card = el("li", { className: "wfws-card wfws-add-card", role: "button", tabindex: "0" });
    card.innerHTML = `
      <div class="wfws-link wfws-add-link" role="button" aria-label="Create New Workspace">
        <div class="wfws-thumb wfws-add-thumb">
          <div class="wfws-add-content">
            <div class="wfws-add-icon"><i data-lucide="plus"></i></div>
            <div class="wfws-add-text">Create New Workspace</div>
          </div>
        </div>
      </div>
      <div class="wfws-meta">
        <div class="wfws-text">
          <div class="wfws-title">Add Workspace</div>
          <div class="wfws-time">Click to create</div>
        </div>
      </div>
    `;

    const openAdd = () => {
      if (window.WFWSAddWorkspace?.open) {
        window.WFWSAddWorkspace.open({
          uploadApi: api.upload,
          createApi: api.create,
          userId: USER_ID,
          onSuccess: () => refreshNow("add-success"),
        });
      }
    };

    card.addEventListener("click", openAdd);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openAdd();
      }
    });

    return card;
  }

  function renderEmptyState() {
    return el("li", { className: "wfws-card" }, [
      el("div", {
        style: { padding: "28px 22px", textAlign: "center", color: "var(--muted)", fontSize: "14px" },
        textContent: "No workspaces yet. Create one to get started.",
      }),
    ]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GRID RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  function clearSkeletons() {
    $$(".wfws-card.is-skeleton", dom.grid).forEach((el) => el.remove());
  }

  function renderGrid(workspaces) {
    clearSkeletons();
    dom.grid.innerHTML = "";

    const fragment = document.createDocumentFragment();

    if (workspaces?.length > 0) {
      workspaces.forEach((ws) => fragment.appendChild(renderCard(ws)));
    } else {
      fragment.appendChild(renderEmptyState());
    }

    fragment.appendChild(renderAddCard());
    dom.grid.appendChild(fragment);

    if (window.lucide?.createIcons) lucide.createIcons();
    state.renderedOnce = true;
  }

  function renderError(message) {
    clearSkeletons();
    dom.grid.innerHTML = "";
    dom.grid.appendChild(
      el("li", { className: "wfws-card" }, [
        el("div", {
          style: { padding: "22px", fontSize: "14px", color: "rgb(239,68,68)" },
          textContent: message,
        }),
      ])
    );
    dom.grid.appendChild(renderAddCard());
    if (window.lucide?.createIcons) lucide.createIcons();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSPACE DETAILS MODAL
  // ═══════════════════════════════════════════════════════════════════════════

  let focusTrap = null;

  function openWorkspaceModal(ws, clickedEl) {
    state.currentWorkspace = ws;

    const modal = dom.modal;
    const title = $(".wfws-modal-title", modal);
    const date = $(".wfws-modal-date", modal);
    const count = $(".wfws-modal-count", modal);
    const filesList = $(".wfws-files-list", modal);

    title.textContent = ws.name || "Untitled";
    date.textContent = ws.created_at ? relativeTime(ws.created_at) : "";
    count.textContent = `${ws.fileCount || 0} ${pluralize(ws.fileCount || 0, "file")}`;

    filesList.innerHTML = "";
    const files = ws.files || [];

    if (files.length > 0) {
      files.forEach((file) => {
        const fileStatus = getFileStatus(file);
        const item = el("div", { className: "wfws-file-item" }, [
          el("div", { className: "wfws-file-icon" }, [el("i", { "data-lucide": "file-text" })]),
          el("div", { className: "wfws-file-info" }, [
            el("div", { className: "wfws-file-name", textContent: file.fileName || "Untitled" }),
            el("div", { className: "wfws-file-type", textContent: file.fileType || "file" }),
          ]),
          createBadgeWithSpinner(fileStatus.label, fileStatus.tone, { size: "sm" }),
        ]);
        filesList.appendChild(item);
      });
    } else {
      filesList.innerHTML = '<div style="color:var(--muted);text-align:center;padding:32px;font-size:14px">No files</div>';
    }

    // Animate from clicked element
    if (clickedEl) {
      const rect = clickedEl.getBoundingClientRect();
      const content = $(".wfws-modal-content", modal);
      content.style.transformOrigin = `${((rect.left + rect.width / 2) / innerWidth) * 100}% ${((rect.top + rect.height / 2) / innerHeight) * 100}%`;
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    lockScroll();
    
    if (focusTrap) focusTrap();
    focusTrap = trapFocus(modal);
    $(".wfws-modal-close", modal)?.focus();

    if (window.lucide?.createIcons) lucide.createIcons();
  }

  function closeWorkspaceModal() {
    if (!state.currentWorkspace) return;
    dom.modal.classList.remove("open");
    dom.modal.setAttribute("aria-hidden", "true");
    if (focusTrap) {
      focusTrap();
      focusTrap = null;
    }
    unlockScroll();
    state.currentWorkspace = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DELETE MODAL
  // ═══════════════════════════════════════════════════════════════════════════

  function openDeleteModal(ws) {
    if (!dom.deleteModal) return;
    state.deleteTarget = ws;

    const subtitle = $(".wfws-delete-subtitle", dom.deleteModal);
    const affected = $("#wfws-delete-affected", dom.deleteModal);
    const affectedList = $("#wfws-delete-affected-list", dom.deleteModal);
    const confirmBtn = $("#wfws-delete-confirm", dom.deleteModal);

    if (subtitle) {
      subtitle.textContent = `"${ws.name || "Untitled"}" and all its files will be permanently removed.`;
    }

    const members = getMembers(ws).filter((m) => !m.isYou && !m.isOwner);

    if (members.length > 0 && affectedList) {
      affected.style.display = "block";
      affectedList.innerHTML = "";
      members.forEach((m) => {
        affectedList.appendChild(
          el("div", { className: "wfws-delete-affected-user" }, [
            el("span", { className: "wfws-delete-affected-avatar", textContent: m.initials }),
            el("span", { textContent: m.displayName }),
          ])
        );
      });
    } else if (affected) {
      affected.style.display = "none";
    }

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
    }

    dom.deleteModal.classList.add("open");
    dom.deleteModal.setAttribute("aria-hidden", "false");
    lockScroll();

    if (window.lucide) lucide.createIcons();
    setTimeout(() => $("#wfws-delete-cancel", dom.deleteModal)?.focus(), 100);
  }

  function closeDeleteModal() {
    if (!dom.deleteModal) return;
    dom.deleteModal.classList.remove("open");
    dom.deleteModal.setAttribute("aria-hidden", "true");
    state.deleteTarget = null;
    unlockScroll();
  }

  async function performDelete() {
    if (!state.deleteTarget || state.isDeleting || !api.delete) {
      if (!api.delete) toast("error", "Configuration error", "Delete API not configured.");
      return;
    }

    state.isDeleting = true;
    const confirmBtn = $("#wfws-delete-confirm", dom.deleteModal);

    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span class="wfws-spinner wfws-spinner-sm"></span>Deleting...';
    }

    try {
      const res = await fetch(api.delete, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: state.deleteTarget.workspaceId, userId: USER_ID }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || "Failed to delete");
      }

      toast("success", "Workspace deleted", `"${state.deleteTarget.name || "Untitled"}" has been removed.`);
      closeDeleteModal();
      refreshNow("workspace-deleted");
    } catch (err) {
      console.error("[Workspaces] Delete error:", err);
      toast("error", "Delete failed", err.message || "Could not delete workspace.");
      
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
      }
      if (window.lucide) lucide.createIcons();
    } finally {
      state.isDeleting = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DROPDOWN MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  function closeAllDropdowns(except = null) {
    $$(".wfws-dropdown.open", root).forEach((d) => {
      if (d !== except) {
        d.classList.remove("open");
        d.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA FETCHING & POLLING
  // ═══════════════════════════════════════════════════════════════════════════

  function setBusy(busy) {
    $(".wfws-inner", root)?.setAttribute("aria-busy", String(busy));
  }

  async function fetchWorkspaces(signal) {
    if (!api.fetch) throw new Error("No API configured");

    let url = api.fetch;
    if (USER_ID) url += `?userId=${encodeURIComponent(USER_ID)}`;

    const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return data?.workspaces || [];
  }

  function scheduleNextPoll(delay) {
    if (state.pollTimerId) clearTimeout(state.pollTimerId);

    let nextDelay = delay;

    if (!nextDelay) {
      if (state.hasPending) {
        nextDelay = CONFIG.POLL_DELAY_ACTIVE;
      } else if (state.stableTime && Date.now() - state.stableTime > CONFIG.STABLE_TIMEOUT) {
        return; // Stop polling
      } else {
        nextDelay = CONFIG.POLL_DELAY_STABLE[Math.min(state.backoffIndex++, CONFIG.POLL_DELAY_STABLE.length - 1)];
      }
    }

    if (state.pollCount >= CONFIG.MAX_POLLS && !state.hasPending) return;

    state.pollTimerId = setTimeout(() => {
      if (!document.hidden) pollOnce();
    }, nextDelay);
  }

  function refreshNow(reason) {
    state.backoffIndex = 0;
    if (state.pollTimerId) clearTimeout(state.pollTimerId);
    if (state.fetchController) state.fetchController.abort();
    pollOnce();
  }

  async function pollOnce() {
    if (state.fetchController) state.fetchController.abort();
    
    const controller = new AbortController();
    state.fetchController = controller;

    const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);
    setBusy(true);

    try {
      const workspaces = await fetchWorkspaces(controller.signal);
      clearTimeout(timeout);

      if (controller.signal.aborted) return;

      renderGrid(workspaces);

      const hadPending = state.hasPending;
      state.hasPending = hasPendingWork(workspaces);
      state.fetchFailed = false;

      if (!state.hasPending && hadPending) {
        state.stableTime = Date.now();
      } else if (!state.hasPending && !state.stableTime) {
        state.stableTime = Date.now();
      } else if (state.hasPending) {
        state.stableTime = null;
      }

      state.pollCount++;
      scheduleNextPoll(state.hasPending ? CONFIG.POLL_DELAY_ACTIVE : undefined);
    } catch (err) {
      if (controller.signal.aborted) return;

      console.error("[Workspaces] Fetch failed:", err);
      renderError("Failed to load workspaces.");

      if (!state.fetchFailed) {
        toast("error", "Unable to refresh", err.message || "Check connection.");
      }

      state.fetchFailed = true;
      state.hasPending = true;
      state.pollCount++;
      scheduleNextPoll(CONFIG.POLL_DELAY_ERROR);
    } finally {
      clearTimeout(timeout);
      setBusy(false);
      if (state.fetchController === controller) state.fetchController = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════════════════

  // Modal close handlers
  $(".wfws-modal-close", dom.modal)?.addEventListener("click", closeWorkspaceModal);
  $(".wfws-modal-backdrop", dom.modal)?.addEventListener("click", closeWorkspaceModal);

  // Delete modal handlers
  if (dom.deleteModal) {
    $("#wfws-delete-cancel", dom.deleteModal)?.addEventListener("click", closeDeleteModal);
    $(".wfws-modal-backdrop", dom.deleteModal)?.addEventListener("click", closeDeleteModal);
    $("#wfws-delete-confirm", dom.deleteModal)?.addEventListener("click", performDelete);
  }

  // Keyboard handler
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.deleteTarget) closeDeleteModal();
      else if (state.currentWorkspace) closeWorkspaceModal();
    }
  });

  // Close dropdowns on outside click
  document.addEventListener("click", closeAllDropdowns);

  // Visibility & focus refresh
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshNow("visibility");
  });

  window.addEventListener("focus", () => {
    if (!document.hidden) refreshNow("focus");
  });

  // Custom workspace created event
  window.addEventListener("wfws:workspace-created", (e) => {
    const name = e.detail?.workspaceName || "Workspace";
    const shared = e.detail?.sharedEmails?.length || 0;
    const shareNote = shared > 0 ? ` Shared with ${shared} ${pluralize(shared, "collaborator")}.` : "";
    toast("success", "Workspace uploaded", `${name} was created.${shareNote}`);
    refreshNow("workspace-created");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZE
  // ═══════════════════════════════════════════════════════════════════════════

  refreshNow("initial-load");
})();
