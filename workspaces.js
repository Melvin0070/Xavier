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
  "use strict";

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

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

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
  // Guard dayjs/plugin presence to avoid runtime errors if CDN fails
  if (window.dayjs && window.dayjs_plugin_relativeTime) {
    dayjs.extend(window.dayjs_plugin_relativeTime);
  }

  (function () {
    const root = document.getElementById("wf-workspaces");
    if (!root || root.dataset.init === "1") return;
    root.dataset.init = "1";

    const prefersReducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const FETCH_TIMEOUT_MS = 30000;
    const ACTIVE_POLL_DELAY = 2500;
    const ERROR_POLL_DELAY = 8000;
    const BACKOFF_INTERVALS = [25000, 60000, 120000, 300000];
    const MAX_POLLS = 20;
    const STABLE_TIMEOUT = 300000;

    let pollTimerId = null;
    let activeFetchController = null;
    let lastHasPending = false;
    let hasRenderedOnce = false;
    let loggedAnonymousFallback = false;
    let prevWorkspaceSnapshot = new Map();
    let lastFetchFailed = false;
    let pollCount = 0;
    let backoffIndex = 0;
    let lastStableTime = null;

    // Simple focus trap util
    function trapFocus(container) {
      const selectors =
        "a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex='-1'])";
      const nodes = Array.from(container.querySelectorAll(selectors)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (!nodes.length) return () => {};

      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      function onKeyDown(e) {
        if (e.key !== "Tab") return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      container.addEventListener("keydown", onKeyDown);
      return () => container.removeEventListener("keydown", onKeyDown);
    }

    function disableScroll() {
      document.documentElement.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      document.body.classList.add("wfws-modal-open");
    }

    function enableScroll() {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      document.body.classList.remove("wfws-modal-open");
    }

    // Basic URL sanitizer
    function safeUrl(value, allowed = ["http:", "https:"]) {
      try {
        const u = new URL(String(value), window.location.origin);
        return allowed.includes(u.protocol) ? u.href : null;
      } catch {
        return null;
      }
    }

    function getMemberId() {
      try {
        const raw = localStorage.getItem("_ms-mem");
        if (!raw) return null;
        const mem = JSON.parse(raw);
        return mem?.id || mem?.member_id || null;
      } catch {
        return null;
      }
    }

    function normalizeStatus(value) {
      return typeof value === "string" ? value.trim().toLowerCase() : "";
    }

    function createStatusBadge(label, tone = "pending", size = "md") {
      const span = document.createElement("span");
      span.className = `wfws-status-badge wfws-status-${tone}${
        size === "sm" ? " wfws-status-sm" : ""
      }`;
      span.textContent = label;
      return span;
    }

    const FILE_STATUS_LABELS = {
      ready: "Ready",
      processing: "Processing",
      uploaded: "Uploaded",
      error: "Failed",
    };
    const FILE_STATUS_TONES = {
      ready: "ready",
      processing: "pending",
      uploaded: "uploaded",
      error: "error",
    };

    function getFileStatusInfo(file) {
      const status = normalizeStatus(file?.status);
      return {
        status,
        label: FILE_STATUS_LABELS[status] || "Processing",
        tone: FILE_STATUS_TONES[status] || "pending",
      };
    }

    function getWorkspaceStatusInfo(workspace) {
      const status = normalizeStatus(workspace?.status);
      const total = Number(workspace?.fileCount || 0);
      const ready = Number(workspace?.fileStatusCounts?.ready || 0);
      const errorCount = Number(
        workspace?.fileStatusCounts?.error || workspace?.errorFileCount || 0
      );
      const actionableTotal = Math.max(total - errorCount, 0);
      const pendingFiles = Math.max(actionableTotal - ready, 0);

      let tone = "pending",
        label = "Processing";

      if (status === "ready" && (pendingFiles === 0 || actionableTotal === 0)) {
        tone = "ready";
        label = errorCount > 0 && ready > 0 ? "Ready with issues" : "Ready";
      } else if (status === "created") {
        tone = "pending";
        label = "Preparing";
      } else if (!status) {
        const inferredReady = pendingFiles === 0 && actionableTotal > 0;
        tone = inferredReady ? "ready" : "pending";
        label = inferredReady
          ? errorCount > 0
            ? "Ready with issues"
            : "Ready"
          : total > 0
          ? "Processing"
          : "Preparing";
      }

      let summary = "";
      if (total === 0) {
        summary = tone === "ready" ? "No files yet" : "Awaiting uploads";
      } else if (tone === "ready") {
        summary =
          errorCount > 0
            ? `${ready}/${total} ready • ${errorCount} failed`
            : `All ${total} file${total === 1 ? "" : "s"} ready`;
      } else if (pendingFiles > 0) {
        summary = `${pendingFiles} file${
          pendingFiles === 1 ? "" : "s"
        } processing`;
        if (errorCount > 0) summary += ` • ${errorCount} failed`;
      } else {
        summary = `${ready}/${total} files ready`;
        if (errorCount > 0) summary += ` • ${errorCount} failed`;
      }

      const percentReady =
        actionableTotal > 0
          ? Math.round((ready / actionableTotal) * 100)
          : tone === "ready" && ready > 0
          ? 100
          : 0;

      return {
        status,
        tone,
        label,
        summary,
        ready,
        total,
        pendingFiles,
        percentReady,
        errorCount,
        actionableTotal,
      };
    }

    function hasPendingEntities(workspaces) {
      if (!Array.isArray(workspaces)) return false;
      return workspaces.some((ws) => {
        const wsStatus = normalizeStatus(ws?.status);
        if (wsStatus && wsStatus !== "ready") return true;
        if (Array.isArray(ws?.files)) {
          return ws.files.some((file) => {
            const status = normalizeStatus(file?.status);
            return status && status !== "ready" && status !== "error";
          });
        }
        return false;
      });
    }

    function getToastInstance() {
      const fn = typeof window !== "undefined" ? window.sonnerJS : null;
      return typeof fn === "function" ? fn : null;
    }

    function pushToast(type, title, description) {
      const toast = getToastInstance();
      if (!toast) return;
      const payload = description ? { description } : undefined;
      const fn = toast[type] || toast;
      return typeof fn === "function"
        ? fn(title, payload)
        : toast(title, payload);
    }

    function getWorkspaceKey(workspace, index = 0) {
      return (
        workspace?.workspaceId ||
        workspace?.id ||
        `${workspace?.name || "workspace"}-${index}`
      );
    }

    function getFileKey(file, index = 0, workspaceKey = "ws") {
      return (
        file?.fileId || `${workspaceKey}::${file?.fileName || "file"}-${index}`
      );
    }

    function createWorkspaceSnapshot(workspaces) {
      const snapshot = new Map();
      if (!Array.isArray(workspaces)) return snapshot;

      workspaces.forEach((ws, index) => {
        const key = getWorkspaceKey(ws, index);
        const statusInfo = getWorkspaceStatusInfo(ws);
        const filesMap = new Map();

        (ws?.files || []).forEach((file, fileIndex) => {
          filesMap.set(
            getFileKey(file, fileIndex, key),
            normalizeStatus(file?.status)
          );
        });

        snapshot.set(key, {
          name: ws?.name || "Untitled workspace",
          status: statusInfo.status,
          tone: statusInfo.tone,
          ready: statusInfo.ready,
          total: statusInfo.total,
          errors: statusInfo.errorCount,
          files: filesMap,
        });
      });
      return snapshot;
    }

    function handleWorkspaceNotifications(workspaces) {
      if (prevWorkspaceSnapshot.size === 0) {
        prevWorkspaceSnapshot = createWorkspaceSnapshot(workspaces);
        return;
      }

      const nextSnapshot = createWorkspaceSnapshot(workspaces);

      workspaces.forEach((ws, index) => {
        const key = getWorkspaceKey(ws, index);
        const current = nextSnapshot.get(key);
        const previous = prevWorkspaceSnapshot.get(key);
        if (!current) return;

        const safeName = current.name || "Workspace";
        const errorCount = Number(
          ws?.errorFileCount ||
            ws?.fileStatusCounts?.error ||
            current.errors ||
            0
        );

        if (!previous) {
          const msg =
            current.status === "ready"
              ? errorCount > 0
                ? `${safeName} is ready, but ${errorCount} file${
                    errorCount === 1 ? " has" : "s have"
                  } failed.`
                : `${safeName} is ready to use.`
              : `${safeName} was added. We'll keep processing files.`;
          pushToast("info", "Workspace added", msg);
          return;
        }

        if (previous.status !== current.status) {
          if (current.status === "ready") {
            setTimeout(
              () => {
                const msg =
                  errorCount > 0
                    ? `${safeName} is ready. ${errorCount} file${
                        errorCount === 1 ? "" : "s"
                      } failed.`
                    : `${safeName} is ready to use.`;
                pushToast("success", "Workspace ready", msg);
              },
              prefersReducedMotion ? 0 : 800
            );

            if (errorCount > 0) {
              setTimeout(
                () => {
                  pushToast(
                    "warning",
                    "Some files failed",
                    `Retry or replace ${errorCount} file${
                      errorCount === 1 ? "" : "s"
                    } in ${safeName}.`
                  );
                },
                prefersReducedMotion ? 0 : 1200
              );
            }
          } else if (
            previous.status === "ready" &&
            current.status !== "ready"
          ) {
            pushToast(
              "warning",
              "Workspace updating",
              `${safeName} went back to processing.`
            );
          }
        }

        (ws?.files || []).forEach((file, fileIndex) => {
          const fileKey = getFileKey(file, fileIndex, key);
          const currentStatus = current.files.get(fileKey);
          const previousStatus = previous.files.get(fileKey);
          const fileName = file?.fileName || "Untitled file";

          if (previousStatus === undefined) {
            pushToast(
              "info",
              "File uploaded",
              `'${fileName}' added to ${safeName}.`
            );
          } else if (previousStatus !== currentStatus) {
            if (currentStatus === "ready") {
              pushToast(
                "success",
                "File ready",
                `'${fileName}' is ready in ${safeName}.`
              );
            } else if (currentStatus === "error") {
              pushToast(
                "error",
                "File failed",
                `'${fileName}' could not be processed in ${safeName}.`
              );
            }
          }
        });

        previous.files.forEach((status, fileKey) => {
          if (!current.files.has(fileKey)) {
            pushToast(
              "warning",
              "File removed",
              `A file was removed from ${safeName}.`
            );
          }
        });
      });

      prevWorkspaceSnapshot.forEach((prevState, key) => {
        if (!nextSnapshot.has(key)) {
          pushToast(
            "warning",
            "Workspace removed",
            `${prevState.name || "A workspace"} is no longer available.`
          );
        }
      });

      prevWorkspaceSnapshot = nextSnapshot;
    }

    function createSpinner(size = "md") {
      const spinner = document.createElement("span");
      spinner.className = `wfws-spinner${
        size === "sm"
          ? " wfws-spinner-sm"
          : size === "lg"
          ? " wfws-spinner-lg"
          : ""
      }`;
      return spinner;
    }

    function wrapStatusWithSpinner(badgeEl, tone, options = {}) {
      const { size = "md", block = false, spin } = options;
      const wrap = document.createElement("div");
      wrap.className = `wfws-status-wrap${block ? " is-block" : ""}`;
      wrap.appendChild(badgeEl);

      const shouldSpin =
        typeof spin === "boolean" ? spin : tone !== "ready" && tone !== "error";
      if (shouldSpin) wrap.appendChild(createSpinner(size));
      return wrap;
    }

    function createWorkspaceProgressOverlay(info) {
      const overlay = document.createElement("div");
      overlay.className = "wfws-progress-overlay";

      const topRow = document.createElement("div");
      topRow.className = "wfws-progress-top";
      const spinner = createSpinner("lg");
      topRow.appendChild(spinner);

      const textGroup = document.createElement("div");
      textGroup.className = "wfws-progress-text";
      const label = document.createElement("div");
      label.className = "wfws-progress-label";
      label.textContent = info.label || "Processing";
      textGroup.appendChild(label);

      const sub = document.createElement("div");
      sub.className = "wfws-progress-subtext";
      if (info.total === 0) {
        sub.textContent = "Awaiting uploads";
      } else {
        const baseText =
          info.actionableTotal > 0
            ? `${info.ready} of ${info.actionableTotal} ready (${info.percentReady}%)`
            : `${info.ready} ready`;
        sub.textContent =
          info.errorCount > 0
            ? `${baseText} • ${info.errorCount} failed`
            : baseText;
      }
      textGroup.appendChild(sub);

      topRow.appendChild(textGroup);
      overlay.appendChild(topRow);

      const meter = document.createElement("div");
      meter.className = "wfws-progress-meter";
      const bar = document.createElement("div");
      bar.className = "wfws-progress-bar";
      const fill = document.createElement("div");
      fill.className = "wfws-progress-fill";
      fill.style.width = `${Math.min(
        100,
        Math.max(0, info.percentReady || 0)
      )}%`;
      bar.appendChild(fill);
      meter.appendChild(bar);
      overlay.appendChild(meter);

      return overlay;
    }

    function getMemberDisplayName(member) {
      if (!member || typeof member !== "object") return "Collaborator";
      return member.displayName || member.name || member.email || "Member";
    }

    function getMemberInitials(value) {
      const raw = String(value || "").trim();
      if (!raw) return "?";
      const handle = raw.includes("@") ? raw.split("@")[0] : raw;
      const match = handle.match(/[\p{L}\p{N}]/u);
      return match?.[0]?.toUpperCase() || handle.charAt(0).toUpperCase();
    }

    function getWorkspaceMembers(ws) {
      const baseMembers = Array.isArray(ws?.members) ? ws.members : [];
      let normalized = baseMembers.map((member) => ({ ...member }));

      if (!normalized.length) {
        const ownerId = ws?.ownerUserId || ws?.userId || null;
        if (ownerId !== null) {
          normalized.push({
            userId: ownerId,
            email: ws?.ownerEmail || null,
            role: "owner",
            isOwner: true,
            isYou: USER_ID ? String(ownerId) === String(USER_ID) : false,
          });
        }
        const legacyShared = Array.isArray(ws?.sharedUsers)
          ? ws.sharedUsers
          : [];
        legacyShared.forEach((value) => {
          normalized.push({
            userId: null,
            email: value,
            role: "member",
            isOwner: false,
            isYou: false,
          });
        });
      }

      return normalized.map((member) => {
        const role = member.role === "owner" ? "owner" : "member";
        const displayName = getMemberDisplayName(member);
        const initials = getMemberInitials(displayName);
        return {
          userId: member.userId ?? null,
          email: member.email ?? null,
          role,
          isOwner: Boolean(member.isOwner || role === "owner"),
          isYou: Boolean(member.isYou),
          displayName,
          initials,
        };
      });
    }

    function renderSharingIndicator(ws) {
      const members = getWorkspaceMembers(ws);
      if (!members.length) return null;
      const collaborators = members.filter((member) => !member.isOwner);
      const indicator = document.createElement("div");
      indicator.className = "wfws-share-indicator";

      if (collaborators.length > 0) {
        indicator.classList.add("is-shared");
        const stack = document.createElement("div");
        stack.className = "wfws-avatar-stack";

        const ordered = [...members].sort((a, b) => {
          if (a.isYou && !b.isYou) return -1;
          if (b.isYou && !a.isYou) return 1;
          if (a.isOwner && !b.isOwner) return -1;
          if (b.isOwner && !a.isOwner) return 1;
          return a.displayName.localeCompare(b.displayName, undefined, {
            sensitivity: "base",
          });
        });

        const totalMembers = ordered.length;
        const maxVisible = totalMembers > 3 ? 1 : totalMembers;
        const visibleMembers = ordered.slice(0, maxVisible);
        visibleMembers.forEach((member) => {
          const avatar = document.createElement("span");
          avatar.className = "wfws-avatar";
          if (member.isYou) avatar.classList.add("is-you");
          avatar.textContent = member.initials;
          const titleSegments = [];
          if (member.isOwner) titleSegments.push("Owner");
          if (!member.isOwner) titleSegments.push("Member");
          if (member.isYou) titleSegments.push("You");
          const titlePrefix = titleSegments.length
            ? `${titleSegments.join(" • ")} — `
            : "";
          avatar.title = `${titlePrefix}${member.displayName}`;
          avatar.setAttribute("aria-label", avatar.title);
          stack.appendChild(avatar);
        });

        indicator.appendChild(stack);

        if (totalMembers > maxVisible) {
          const remaining = totalMembers - maxVisible;
          if (remaining > 0) {
            const moreLabel = document.createElement("span");
            moreLabel.className = "wfws-share-more";
            moreLabel.textContent = `+${remaining} more`;
            indicator.appendChild(moreLabel);
          }
        }

        indicator.setAttribute(
          "aria-label",
          `${totalMembers} workspace member${totalMembers === 1 ? "" : "s"}`
        );
        return indicator;
      }

      const badge = document.createElement("div");
      badge.className = "wfws-private-label";
      const copy = document.createElement("span");
      copy.className = "wfws-private-copy";
      const main = document.createElement("span");
      main.className = "wfws-private-main";
      main.textContent = "Private";
      const bullet = document.createElement("span");
      bullet.setAttribute("aria-hidden", "true");
      bullet.textContent = "•";
      const sub = document.createElement("span");
      sub.className = "wfws-private-sub";
      sub.textContent = "Only you";

      copy.appendChild(main);
      copy.appendChild(bullet);
      copy.appendChild(sub);
      badge.appendChild(copy);
      indicator.appendChild(badge);
      indicator.classList.add("is-private");
      indicator.setAttribute("aria-label", "Private workspace. Only you.");

      return indicator;
    }

    const API = root.getAttribute("data-api") || "";
    const USER_ID = getMemberId();
    const grid = root.querySelector(".wfws-grid");
    const modal = root.querySelector(".wfws-modal");
    const modalContent = modal.querySelector(".wfws-modal-content");
    const modalBackdrop = modal.querySelector(".wfws-modal-backdrop");
    const modalTitle = modal.querySelector(".wfws-modal-title");
    const modalDate = modal.querySelector(".wfws-modal-date");
    const modalCount = modal.querySelector(".wfws-modal-count");
    const modalFilesList = modal.querySelector(".wfws-files-list");
    const modalClose = modal.querySelector(".wfws-modal-close");
    const modalFilesSection = modal.querySelector(".wfws-modal-files");

    // Delete modal elements
    const DELETE_API_URL = root.getAttribute("data-delete-api") || "";
    const deleteModal = root.querySelector("#wfws-delete-modal");
    const deleteModalBackdrop = deleteModal?.querySelector(".wfws-modal-backdrop");
    const deleteSubtitle = deleteModal?.querySelector(".wfws-delete-subtitle");
    const deleteAffectedSection = deleteModal?.querySelector("#wfws-delete-affected");
    const deleteAffectedList = deleteModal?.querySelector("#wfws-delete-affected-list");
    const deleteCancelBtn = deleteModal?.querySelector("#wfws-delete-cancel");
    const deleteConfirmBtn = deleteModal?.querySelector("#wfws-delete-confirm");
    let pendingDeleteWorkspace = null;
    let isDeleting = false;

    // Delete modal functions
    function openDeleteModal(workspace) {
      if (!deleteModal) return;
      pendingDeleteWorkspace = workspace;
      
      // Update subtitle with workspace name
      if (deleteSubtitle) {
        deleteSubtitle.textContent = `"${workspace.name || 'Untitled'}" and all its files will be permanently removed.`;
      }

      // Show affected members if shared
      const members = getWorkspaceMembers(workspace);
      const otherMembers = members.filter(m => !m.isYou && !m.isOwner);
      
      if (otherMembers.length > 0 && deleteAffectedSection && deleteAffectedList) {
        deleteAffectedSection.style.display = "block";
        deleteAffectedList.innerHTML = "";
        
        otherMembers.forEach((member) => {
          const userEl = document.createElement("div");
          userEl.className = "wfws-delete-affected-user";
          
          const avatar = document.createElement("span");
          avatar.className = "wfws-delete-affected-avatar";
          avatar.textContent = member.initials || "?";
          
          const name = document.createElement("span");
          name.textContent = member.displayName || member.email || "Member";
          
          userEl.appendChild(avatar);
          userEl.appendChild(name);
          deleteAffectedList.appendChild(userEl);
        });
      } else if (deleteAffectedSection) {
        deleteAffectedSection.style.display = "none";
      }

      // Reset button state
      if (deleteConfirmBtn) {
        deleteConfirmBtn.disabled = false;
        deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
      }
      
      // Open modal
      deleteModal.classList.add("open");
      deleteModal.setAttribute("aria-hidden", "false");
      disableScroll();
      
      // Re-initialize lucide icons
      if (window.lucide) lucide.createIcons();
      
      // Focus cancel button
      setTimeout(() => deleteCancelBtn?.focus(), 100);
    }

    function closeDeleteModal() {
      if (!deleteModal) return;
      deleteModal.classList.remove("open");
      deleteModal.setAttribute("aria-hidden", "true");
      pendingDeleteWorkspace = null;
      enableScroll();
    }

    async function performDelete() {
      if (!pendingDeleteWorkspace || isDeleting || !DELETE_API_URL) {
        if (!DELETE_API_URL) {
          pushToast("error", "Configuration error", "Delete API endpoint not configured.");
        }
        return;
      }
      
      isDeleting = true;
      if (deleteConfirmBtn) {
        deleteConfirmBtn.disabled = true;
        deleteConfirmBtn.innerHTML = '<span class="wfws-spinner wfws-spinner-sm"></span>Deleting...';
      }
      
      try {
        const response = await fetch(DELETE_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: pendingDeleteWorkspace.workspaceId,
            userId: USER_ID
          })
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || errorData.error || "Failed to delete workspace");
        }
        
        pushToast("success", "Workspace deleted", `"${pendingDeleteWorkspace.name || 'Untitled'}" has been removed.`);
        closeDeleteModal();
        requestImmediateRefresh("workspace-deleted");
        
      } catch (error) {
        console.error("[Workspaces] Delete error:", error);
        pushToast("error", "Delete failed", error.message || "Could not delete workspace. Please try again.");
        if (deleteConfirmBtn) {
          deleteConfirmBtn.disabled = false;
          deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
        }
        if (window.lucide) lucide.createIcons();
      } finally {
        isDeleting = false;
      }
    }

    // Delete modal event listeners
    if (deleteCancelBtn) deleteCancelBtn.addEventListener("click", closeDeleteModal);
    if (deleteModalBackdrop) deleteModalBackdrop.addEventListener("click", closeDeleteModal);
    if (deleteConfirmBtn) deleteConfirmBtn.addEventListener("click", performDelete);
    
    // Close dropdown when clicking outside
    document.addEventListener("click", (e) => {
      const openDropdowns = root.querySelectorAll(".wfws-dropdown.open");
      openDropdowns.forEach((dropdown) => {
        if (!dropdown.contains(e.target) && !dropdown.previousElementSibling?.contains(e.target)) {
          dropdown.classList.remove("open");
        }
      });
    });

    const CREATE_API_URL = root.getAttribute("data-create-api") || "";
    const UPLOAD_API_URL =
      root.getAttribute("data-upload-api") || CREATE_API_URL;
    function openAddModal() {
      if (window.WFWSAddWorkspace?.open) {
        window.WFWSAddWorkspace.open({
          uploadApi: UPLOAD_API_URL,
          createApi: CREATE_API_URL,
          userId: USER_ID,
          onSuccess: () => requestImmediateRefresh("add-success"),
        });
      } else {
        console.warn("[Workspaces] Add modal embed not found.");
      }
    }

    let currentWorkspaceData = null;

    function relativeTime(iso) {
      if (!iso) return "";
      if (window.dayjs) {
        try {
          return dayjs(iso).fromNow();
        } catch {}
      }
      try {
        return new Date(iso).toLocaleString();
      } catch {
        return "";
      }
    }

    // Modal functions
    let untrapDetailsFocus = null;

    function openModal(workspace, clickedElement) {
      currentWorkspaceData = workspace;
      const wsStatus = getWorkspaceStatusInfo(workspace);

      modalTitle.textContent = workspace.name || "Untitled Workspace";
      modalDate.textContent = workspace.created_at
        ? `Created ${relativeTime(workspace.created_at)}`
        : "";
      modalCount.textContent = wsStatus.summary;

      const modalMeta = modal.querySelector(".wfws-modal-meta");
      if (modalMeta) {
        const existingBadge = modalMeta.querySelector(".wfws-modal-status");
        if (existingBadge) existingBadge.remove();
        const modalBadge = createStatusBadge(wsStatus.label, wsStatus.tone);
        const modalBadgeWrap = wrapStatusWithSpinner(modalBadge, wsStatus.tone);
        modalBadgeWrap.classList.add("wfws-modal-status");
        modalMeta.insertBefore(modalBadgeWrap, modalMeta.firstChild);
        const priorErrorBadge = modalMeta.querySelector(".wfws-modal-error");
        if (priorErrorBadge) priorErrorBadge.remove();
        if (wsStatus.errorCount > 0) {
          const errorBadge = createStatusBadge(
            `${wsStatus.errorCount} failed`,
            "error",
            "sm"
          );
          const errorWrap = wrapStatusWithSpinner(errorBadge, "error", {
            size: "sm",
            spin: false,
          });
          errorWrap.classList.add("wfws-modal-error");
          modalMeta.appendChild(errorWrap);
        }
      }

      const members = getWorkspaceMembers(workspace);
      const collaborators = members.filter((member) => !member.isOwner);
      let modalMembers = modal.querySelector(".wfws-modal-members");
      if (!modalMembers) {
        modalMembers = document.createElement("div");
        modalMembers.className = "wfws-modal-members";
        const membersTitle = document.createElement("h3");
        membersTitle.className = "wfws-modal-section-title";
        membersTitle.textContent = "Members";
        const list = document.createElement("div");
        list.className = "wfws-member-list";
        const actions = document.createElement("div");
        actions.className = "wfws-member-actions";

        const inviteBtn = document.createElement("button");
        inviteBtn.type = "button";
        inviteBtn.className = "wfws-btn wfws-btn-primary wfws-member-invite";
        inviteBtn.innerHTML =
          '<i data-lucide="user-plus"></i><span>Invite collaborators</span>';
        inviteBtn.addEventListener("click", () => {
          if (currentWorkspaceData) {
            window.dispatchEvent(
              new CustomEvent("wfws:invite-members", {
                detail: { workspace: currentWorkspaceData },
              })
            );
          }
        });

        const manageBtn = document.createElement("button");
        manageBtn.type = "button";
        manageBtn.className = "wfws-btn wfws-btn-secondary wfws-member-manage";
        manageBtn.innerHTML =
          '<i data-lucide="users"></i><span>Manage access</span>';
        manageBtn.addEventListener("click", () => {
          if (currentWorkspaceData) {
            window.dispatchEvent(
              new CustomEvent("wfws:manage-members", {
                detail: { workspace: currentWorkspaceData },
              })
            );
          }
        });

        actions.appendChild(inviteBtn);
        actions.appendChild(manageBtn);
        actions.hidden = true;
        modalMembers.appendChild(membersTitle);
        modalMembers.appendChild(list);
        modalMembers.appendChild(actions);

        if (modalFilesSection && modalFilesSection.parentNode) {
          modalFilesSection.parentNode.insertBefore(
            modalMembers,
            modalFilesSection
          );
        } else {
          modal.querySelector(".wfws-modal-body")?.appendChild(modalMembers);
        }
      }

      const membersList = modalMembers.querySelector(".wfws-member-list");
      const actionsRow = modalMembers.querySelector(".wfws-member-actions");
      if (actionsRow) actionsRow.hidden = true;
      const inviteBtn = modalMembers.querySelector(".wfws-member-invite");
      const manageBtn = modalMembers.querySelector(".wfws-member-manage");
      const prevEmptyState = modalMembers.querySelector(".wfws-member-empty");
      if (prevEmptyState) prevEmptyState.remove();

      if (membersList) {
        membersList.innerHTML = "";
        members.forEach((member) => {
          const item = document.createElement("div");
          item.className = "wfws-member-item";

          const main = document.createElement("div");
          main.className = "wfws-member-main";
          const avatar = document.createElement("div");
          avatar.className = "wfws-member-avatar";
          if (member.isYou) avatar.classList.add("is-you");
          avatar.textContent = member.initials;
          avatar.title = member.displayName;
          avatar.setAttribute("aria-label", member.displayName);
          main.appendChild(avatar);

          const info = document.createElement("div");
          info.className = "wfws-member-info";
          const nameRow = document.createElement("div");
          nameRow.className = "wfws-member-name";
          const nameText = document.createElement("span");
          nameText.textContent = member.displayName;
          nameRow.appendChild(nameText);
          if (member.isYou) {
            const youTag = document.createElement("span");
            youTag.className = "wfws-member-tag";
            youTag.textContent = "(You)";
            nameRow.appendChild(youTag);
          }
          info.appendChild(nameRow);

          const secondaryText =
            member.email && member.email !== member.displayName
              ? member.email
              : "";
          if (secondaryText) {
            const meta = document.createElement("div");
            meta.className = "wfws-member-meta";
            meta.textContent = secondaryText;
            info.appendChild(meta);
          }

          main.appendChild(info);
          item.appendChild(main);

          const roleBadge = document.createElement("span");
          roleBadge.className = `wfws-member-role ${
            member.isOwner ? "owner" : "member"
          }`;
          roleBadge.textContent = member.isOwner ? "Owner" : "Member";
          roleBadge.hidden = true;
          item.appendChild(roleBadge);

          membersList.appendChild(item);
        });
      }

      if (manageBtn) {
        manageBtn.disabled = collaborators.length === 0;
      }
      if (inviteBtn) {
        inviteBtn.disabled = false;
      }

      if (collaborators.length === 0) {
        const emptyState = document.createElement("div");
        emptyState.className = "wfws-member-empty";
        emptyState.textContent = "This workspace is private to you.";
        if (actionsRow) {
          modalMembers.insertBefore(emptyState, actionsRow);
        } else {
          modalMembers.appendChild(emptyState);
        }
      }

      // Render files
      modalFilesList.innerHTML = "";
      if (workspace.files?.length > 0) {
        workspace.files.forEach((file) => {
          const fileItem = document.createElement("div");
          fileItem.className = "wfws-file-item";

          const iconWrap = document.createElement("div");
          iconWrap.className = "wfws-file-icon";
          const img = document.createElement("img");
          img.style.cssText = "width:24px;height:24px";
          const src = safeUrl(file?.iconUrl, ["http:", "https:", "data:"]);
          if (src) img.src = src;
          img.alt = file?.fileType || "file";
          iconWrap.appendChild(img);

          const info = document.createElement("div");
          info.className = "wfws-file-info";
          const name = document.createElement("div");
          name.className = "wfws-file-name";
          name.textContent = file?.fileName || "Untitled";
          const type = document.createElement("div");
          type.className = "wfws-file-type";
          type.textContent = file?.fileType || "file";
          info.appendChild(name);
          info.appendChild(type);

          fileItem.appendChild(iconWrap);
          fileItem.appendChild(info);

          const fileStatus = getFileStatusInfo(file);
          const badge = createStatusBadge(
            fileStatus.label,
            fileStatus.tone,
            "sm"
          );
          fileItem.appendChild(
            wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" })
          );

          modalFilesList.appendChild(fileItem);
        });
      } else {
        modalFilesList.innerHTML =
          '<div style="color:var(--muted);text-align:center;padding:32px;font-size:14px">No files in this workspace</div>';
      }

      // Get position of clicked element for animation
      const rect = clickedElement.getBoundingClientRect();
      const originX =
        ((rect.left + rect.width / 2) / window.innerWidth) * 100 + "%";
      const originY =
        ((rect.top + rect.height / 2) / window.innerHeight) * 100 + "%";

      modalContent.style.transformOrigin = `${originX} ${originY}`;
      modal.classList.add("open");

      if (window.lucide?.createIcons) window.lucide.createIcons();

      modal.setAttribute("aria-hidden", "false");
      disableScroll();
      if (untrapDetailsFocus) untrapDetailsFocus();
      untrapDetailsFocus = trapFocus(modal);
      modalClose.focus();
    }

    function closeModal() {
      if (!currentWorkspaceData) return;
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      if (untrapDetailsFocus) {
        untrapDetailsFocus();
        untrapDetailsFocus = null;
      }
      enableScroll();
      currentWorkspaceData = null;
    }

    // Event listeners
    modalClose.addEventListener("click", closeModal);
    modalBackdrop.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (pendingDeleteWorkspace) closeDeleteModal();
        else if (currentWorkspaceData) closeModal();
      }
    });

    window.addEventListener("wfws:workspace-created", (event) => {
      const name = event?.detail?.workspaceName || "Workspace";
      const sharedEmails = event?.detail?.sharedEmails || [];
      const shareNote =
        sharedEmails.length > 0
          ? ` Shared with ${
              sharedEmails.length === 1
                ? "1 collaborator"
                : `${sharedEmails.length} collaborators`
            }.`
          : "";
      pushToast(
        "success",
        "Workspace uploaded",
        `${name} was created. We'll let you know when ready.${shareNote}`
      );
      requestImmediateRefresh("workspace-created");
    });

    // Render a workspace card
    function renderCard(ws) {
      const li = document.createElement("li");
      li.className = "wfws-card";
      li.setAttribute("role", "article");
      li.setAttribute("tabindex", "-1");

      const statusInfo = getWorkspaceStatusInfo(ws);
      const errorCount = Number(
        ws?.errorFileCount || ws?.fileStatusCounts?.error || 0
      );
      if (statusInfo.status) {
        li.dataset.status = statusInfo.status;
      }
      if (statusInfo.tone === "pending") {
        li.classList.add("wfws-card-pending");
      } else {
        li.classList.remove("wfws-card-pending");
      }

      // Clickable thumbnail
      const aThumb = document.createElement("a");
      aThumb.className = "wfws-link";
      aThumb.href = "#";
      aThumb.setAttribute("aria-label", ws.name);

      // Add click handler for modal
      aThumb.addEventListener("click", (e) => {
        e.preventDefault();
        openModal(ws, li);
      });

      // Thumbnail with files list
      const thumb = document.createElement("div");
      thumb.className = "wfws-thumb";

      // Files list inside thumbnail
      const filesWrap = document.createElement("div");
      filesWrap.className = "wfws-thumb-files";

      if (ws.files && ws.files.length > 0) {
        // Show up to 5 files in thumbnail
        ws.files.slice(0, 5).forEach((file) => {
          const fileItem = document.createElement("div");
          fileItem.className = "wfws-thumb-file";

          const iconWrap = document.createElement("div");
          iconWrap.className = "wfws-thumb-file-icon";
          const img = document.createElement("img");
          img.style.width = "16px";
          img.style.height = "16px";
          if (file && typeof file.iconUrl === "string") {
            const src = safeUrl(file.iconUrl, ["http:", "https:", "data:"]);
            if (src) img.src = src;
          }
          img.alt = file && file.fileType ? String(file.fileType) : "file";
          iconWrap.appendChild(img);

          const info = document.createElement("div");
          info.className = "wfws-thumb-file-info";
          const name = document.createElement("div");
          name.className = "wfws-thumb-file-name";
          name.textContent =
            file && file.fileName ? String(file.fileName) : "Untitled";
          const type = document.createElement("div");
          type.className = "wfws-thumb-file-type";
          type.textContent =
            file && file.fileType ? String(file.fileType) : "file";
          info.appendChild(name);
          info.appendChild(type);

          fileItem.appendChild(iconWrap);
          fileItem.appendChild(info);
          const fileStatus = getFileStatusInfo(file);
          const badge = createStatusBadge(
            fileStatus.label,
            fileStatus.tone,
            "sm"
          );
          fileItem.appendChild(
            wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" })
          );

          filesWrap.appendChild(fileItem);
        });

        // Show "and X more" if there are more files
        if (ws.files.length > 5) {
          const moreItem = document.createElement("div");
          moreItem.className = "wfws-thumb-file";
          moreItem.style.justifyContent = "center";
          moreItem.style.fontWeight = "500";
          moreItem.style.color = "var(--muted)";
          moreItem.textContent = `+${ws.files.length - 5} more file${
            ws.files.length - 5 === 1 ? "" : "s"
          }`;
          filesWrap.appendChild(moreItem);
        }
      } else {
        const emptyState = document.createElement("div");
        emptyState.className = "wfws-thumb-empty";
        emptyState.textContent = "No files yet";
        filesWrap.appendChild(emptyState);
      }

      thumb.appendChild(filesWrap);
      if (errorCount > 0) {
        const errorBadge = createStatusBadge(
          `${errorCount} failed`,
          "error",
          "sm"
        );
        errorBadge.setAttribute(
          "aria-label",
          `${errorCount} file${errorCount === 1 ? "" : "s"} failed to process`
        );
        errorBadge.classList.add("wfws-error-pill");
        thumb.appendChild(errorBadge);
      }
      if (statusInfo.tone !== "ready") {
        thumb.appendChild(createWorkspaceProgressOverlay(statusInfo));
      }
      aThumb.appendChild(thumb);
      li.appendChild(aThumb);

      // Meta row: left-aligned text (title + time)
      const meta = document.createElement("div");
      meta.className = "wfws-meta";

      const textWrap = document.createElement("a");
      textWrap.className = "wfws-link wfws-text";
      textWrap.href = "#";
      textWrap.setAttribute("aria-label", ws.name);

      // Add click handler for modal
      textWrap.addEventListener("click", (e) => {
        e.preventDefault();
        openModal(ws, li);
      });
      const titleEl = document.createElement("div");
      titleEl.className = "wfws-title";
      titleEl.textContent = ws.name || "Untitled";
      const timeEl = document.createElement("div");
      timeEl.className = "wfws-time";
      const metaChunks = [];
      const summaryChunk =
        statusInfo.summary ||
        (statusInfo.total > 0
          ? `${statusInfo.ready}/${statusInfo.total} ready`
          : "Awaiting files");
      if (summaryChunk) {
        metaChunks.push(summaryChunk);
      }
      if (ws.created_at) {
        metaChunks.push(relativeTime(ws.created_at));
      }
      timeEl.textContent = metaChunks.filter(Boolean).join(" • ");

      textWrap.appendChild(titleEl);
      textWrap.appendChild(timeEl);
      const shareIndicator = renderSharingIndicator(ws);
      if (shareIndicator) {
        textWrap.appendChild(shareIndicator);
      }
      // Text on the left
      meta.appendChild(textWrap);
      
      // Three-dot menu (only for owner)
      const isOwner = ws.userId && String(ws.userId) === String(USER_ID);
      if (isOwner) {
        const menuWrap = document.createElement("div");
        menuWrap.className = "wfws-menu-wrap";
        
        const menuBtn = document.createElement("button");
        menuBtn.className = "wfws-menu-btn";
        menuBtn.setAttribute("aria-label", "Workspace options");
        menuBtn.setAttribute("aria-haspopup", "true");
        menuBtn.setAttribute("aria-expanded", "false");
        menuBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
        
        const dropdown = document.createElement("div");
        dropdown.className = "wfws-dropdown";
        dropdown.setAttribute("role", "menu");
        
        const deleteItem = document.createElement("button");
        deleteItem.className = "wfws-dropdown-item danger";
        deleteItem.setAttribute("role", "menuitem");
        deleteItem.innerHTML = '<i data-lucide="trash-2"></i><span>Delete</span>';
        
        deleteItem.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropdown.classList.remove("open");
          menuBtn.setAttribute("aria-expanded", "false");
          openDeleteModal(ws);
        });
        
        dropdown.appendChild(deleteItem);
        menuWrap.appendChild(menuBtn);
        menuWrap.appendChild(dropdown);
        
        menuBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          // Close other open dropdowns
          root.querySelectorAll(".wfws-dropdown.open").forEach((d) => {
            if (d !== dropdown) {
              d.classList.remove("open");
              d.previousElementSibling?.setAttribute("aria-expanded", "false");
            }
          });
          
          const isOpen = dropdown.classList.toggle("open");
          menuBtn.setAttribute("aria-expanded", String(isOpen));
          
          // Re-initialize lucide icons in the dropdown
          if (window.lucide) lucide.createIcons();
        });
        
        meta.appendChild(menuWrap);
      }
      
      const badgeColumn = document.createElement("div");
      badgeColumn.className = "wfws-meta-badges";

      const statusBadge = createStatusBadge(statusInfo.label, statusInfo.tone);
      statusBadge.setAttribute(
        "aria-label",
        `Workspace status: ${statusInfo.label}`
      );
      badgeColumn.appendChild(
        wrapStatusWithSpinner(statusBadge, statusInfo.tone)
      );

      if (errorCount > 0) {
        const errorBadgeMeta = createStatusBadge(
          `${errorCount} failed`,
          "error",
          "sm"
        );
        errorBadgeMeta.setAttribute(
          "aria-label",
          `${errorCount} file${errorCount === 1 ? "" : "s"} failed`
        );
        badgeColumn.appendChild(
          wrapStatusWithSpinner(errorBadgeMeta, "error", {
            size: "sm",
            spin: false,
          })
        );
      }

      meta.appendChild(badgeColumn);
      li.appendChild(meta);
      return li;
    }

    function createAddCard() {
      const addCard = document.createElement("li");
      addCard.className = "wfws-card wfws-add-card";
      addCard.setAttribute("role", "button");
      addCard.setAttribute("tabindex", "0");
      addCard.innerHTML = `
        <div class="wfws-link wfws-add-link" role="button" aria-label="Create New Workspace">
          <div class="wfws-thumb wfws-add-thumb">
            <div class="wfws-add-content">
              <div class="wfws-add-icon">
                <i data-lucide="plus"></i>
              </div>
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

      addCard.addEventListener("click", (e) => {
        e.preventDefault?.();
        openAddModal();
      });
      addCard.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openAddModal();
        }
      });

      return addCard;
    }

    function createEmptyStateCard() {
      const empty = document.createElement("li");
      empty.className = "wfws-card";
      const inner = document.createElement("div");
      inner.style.padding = "28px 22px";
      inner.style.textAlign = "center";
      inner.style.color = "var(--muted)";
      inner.style.fontSize = "14px";
      inner.innerHTML = "No workspaces yet. Create one to get started.";
      empty.appendChild(inner);
      return empty;
    }

    function renderWorkspacesList(workspaces) {
      clearSkeletons();
      grid.innerHTML = "";

      const fragment = document.createDocumentFragment();
      if (workspaces?.length > 0) {
        workspaces.forEach((ws) => fragment.appendChild(renderCard(ws)));
      } else {
        fragment.appendChild(createEmptyStateCard());
      }

      fragment.appendChild(createAddCard());
      grid.appendChild(fragment);

      if (window.lucide?.createIcons) window.lucide.createIcons();
    }

    function renderErrorState(message) {
      clearSkeletons();
      grid.innerHTML = "";
      const err = document.createElement("li");
      err.className = "wfws-card";
      const inner = document.createElement("div");
      inner.style.cssText = "padding:22px;font-size:14px;color:rgb(239,68,68)";
      inner.textContent = message;
      err.appendChild(inner);
      grid.appendChild(err);
      grid.appendChild(createAddCard());
      if (window.lucide?.createIcons) window.lucide.createIcons();
    }

    function renderConfigError() {
      renderErrorState("Configuration error: API URL not set.");
      pushToast(
        "error",
        "Configuration issue",
        "Workspace API endpoint is missing."
      );
    }

    function setBusyState(isBusy) {
      root
        .querySelector(".wfws-inner")
        ?.setAttribute("aria-busy", isBusy ? "true" : "false");
    }

    function clearSkeletons() {
      grid.querySelectorAll(".is-skeleton").forEach((n) => n.remove());
    }

    function scheduleNextPoll(delay) {
      if (pollTimerId) {
        clearTimeout(pollTimerId);
      }

      // Check if we should stop polling
      if (pollCount >= MAX_POLLS) {
        console.info(
          "[Workspaces] Max polls reached, stopping automatic updates"
        );
        return;
      }

      // Check if everything has been stable for too long
      if (!lastHasPending && lastStableTime) {
        const stableDuration = Date.now() - lastStableTime;
        if (stableDuration >= STABLE_TIMEOUT) {
          console.info(
            "[Workspaces] All workspaces stable for 5+ minutes, stopping polls"
          );
          return;
        }
      }

      let nextDelay;
      if (document.hidden) {
        // When tab is hidden, use longer interval
        nextDelay =
          BACKOFF_INTERVALS[
            Math.min(backoffIndex, BACKOFF_INTERVALS.length - 1)
          ];
      } else if (typeof delay === "number") {
        nextDelay = delay;
      } else if (lastHasPending) {
        // Active processing: use short delay and reset backoff
        nextDelay = ACTIVE_POLL_DELAY;
        backoffIndex = 0;
      } else {
        // Idle: use exponential backoff
        nextDelay =
          BACKOFF_INTERVALS[
            Math.min(backoffIndex, BACKOFF_INTERVALS.length - 1)
          ];
        backoffIndex++;
      }

      pollTimerId = window.setTimeout(() => {
        runWorkspaceFetch("poll").catch(() => {});
      }, nextDelay);
    }

    function requestImmediateRefresh(reason = "manual") {
      // Reset polling counters when user manually refreshes
      if (
        pollCount >= MAX_POLLS ||
        (lastStableTime && Date.now() - lastStableTime >= STABLE_TIMEOUT)
      ) {
        console.info("[Workspaces] Resuming polling due to user interaction");
        pollCount = 0;
        backoffIndex = 0;
        lastStableTime = null;
      }
      runWorkspaceFetch(reason).catch(() => {});
    }

    async function loadWorkspaces({ signal } = {}) {
      const effectiveUserId = USER_ID || "public";
      if (!USER_ID && !loggedAnonymousFallback) {
        console.info('[Workspaces] No member ID found, using "public".');
        loggedAnonymousFallback = true;
      }

      const controller = new AbortController();
      if (signal?.aborted) {
        controller.abort();
      } else if (signal) {
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }

      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(
          `${API}?userId=${encodeURIComponent(effectiveUserId)}`,
          {
            signal: controller.signal,
            headers: { Accept: "application/json" },
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const payload =
          typeof data.body === "string" ? JSON.parse(data.body) : data;
        return { workspaces: payload?.workspaces || [], payload };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function runWorkspaceFetch(reason = "refresh") {
      if (!API) {
        console.warn("[Workspaces] Missing API endpoint.");
        renderConfigError();
        return;
      }

      if (pollTimerId) {
        clearTimeout(pollTimerId);
        pollTimerId = null;
      }

      if (activeFetchController) {
        activeFetchController.abort();
        activeFetchController = null;
      }

      // Reset counters on user interaction
      if (["initial", "visibility", "focus", "manual"].includes(reason)) {
        pollCount = 0;
        backoffIndex = 0;
        lastStableTime = null;
      }

      const controller = new AbortController();
      activeFetchController = controller;

      if (!hasRenderedOnce) setBusyState(true);

      try {
        const { workspaces } = await loadWorkspaces({
          signal: controller.signal,
        });
        renderWorkspacesList(workspaces);
        handleWorkspaceNotifications(workspaces);

        if (lastFetchFailed) {
          pushToast(
            "success",
            "Connection restored",
            "Workspace list is up to date."
          );
          lastFetchFailed = false;
        }
        hasRenderedOnce = true;

        const hadPendingBefore = lastHasPending;
        lastHasPending = hasPendingEntities(workspaces);

        // Track stability
        if (!lastHasPending && hadPendingBefore) {
          lastStableTime = Date.now();
          console.info("[Workspaces] All stable");
        } else if (!lastHasPending && !lastStableTime) {
          lastStableTime = Date.now();
        } else if (lastHasPending) {
          lastStableTime = null;
        }

        pollCount++;
        scheduleNextPoll(lastHasPending ? ACTIVE_POLL_DELAY : undefined);
      } catch (error) {
        if (controller.signal.aborted) return;

        console.error("[Workspaces] Fetch failed", error);
        renderErrorState("Failed to load workspaces.");

        if (!lastFetchFailed) {
          pushToast(
            "error",
            "Unable to refresh",
            error?.message || "Check connection."
          );
        }
        lastFetchFailed = true;
        lastHasPending = true;
        pollCount++;
        scheduleNextPoll(ERROR_POLL_DELAY);
      } finally {
        setBusyState(false);
        if (activeFetchController === controller) activeFetchController = null;
      }
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        requestImmediateRefresh("visibilitychange");
      }
    });

    window.addEventListener("focus", () => {
      if (!document.hidden) {
        requestImmediateRefresh("window-focus");
      }
    });

    requestImmediateRefresh("initial-load");
  })();
