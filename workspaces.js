/**
 * Workspaces Grid Component JavaScript
 * Host on GitHub and load via jsDelivr CDN
 * 
 * Dependencies (load before this script):
 * - dayjs + relativeTime plugin
 * - Lucide icons
 * - Sonner notifications (optional)
 */

(function () {
  // Guard dayjs/plugin presence to avoid runtime errors if CDN fails
  if (window.dayjs && window.dayjs_plugin_relativeTime) {
    dayjs.extend(window.dayjs_plugin_relativeTime);
  }

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

  // DOM Helper
  const el = (tag, attrs = {}, ...children) => {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.substring(2).toLowerCase(), value);
      } else if (key === "dataset") {
        Object.entries(value).forEach(([dKey, dVal]) => element.dataset[dKey] = dVal);
      } else if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
      } else if (value !== false && value !== null && value !== undefined) {
        element.setAttribute(key === "className" ? "class" : key, value);
      }
    });

    children.flat().forEach(child => {
      if (child === null || child === undefined || child === false) return;
      if (child instanceof Node) element.appendChild(child);
      else element.appendChild(document.createTextNode(String(child)));
    });
    return element;
  };

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

  // --- Render Functions (Refactored) ---

  const Icons = {
    // Lucide icons as SVG strings for direct usage without runtime dependency
    plus: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    trash: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
    more: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>',
    userPlus: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" x2="20" y1="8" y2="14"/><line x1="23" x2="17" y1="11" y2="11"/></svg>',
    users: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6.712"/><path d="M6 21v-2a4 4 0 0 1 4-4 2 2 0 0 1 2 2v2"/><path d="M16 11a4 4 0 1 0-8 0"/><path d="M16 7a4 4 0 1 0 0 8"/></svg>'
  };

  const createIcon = (name, className = "") => {
    const span = document.createElement("span");
    // Only use innerHTML for SVGs
    if (Icons[name]) span.innerHTML = Icons[name];
    else if (window.lucide) { 
        const i = document.createElement('i');
        i.setAttribute('data-lucide', name);
        span.appendChild(i);
    }
    if (className) span.className = className;
    return span.firstElementChild || span;
  };

  function renderSharingIndicator(ws) {
    const members = getWorkspaceMembers(ws);
    if (!members.length) return null;
    
    // ... logic for shared vs private ...
    const collaborators = members.filter((member) => !member.isOwner);

    if (collaborators.length > 0) {
      // Simplified with el() helper
      // Stack logic remains same but cleaner implementation
      const ordered = [...members].sort((a, b) => {
        if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
        if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

      const maxVisible = Math.min(ordered.length, 3);
      const visibleMembers = ordered.slice(0, maxVisible);
      
      return el("div", { class: "wfws-share-indicator is-shared", "aria-label": `${members.length} members` },
        el("div", { class: "wfws-avatar-stack" },
          visibleMembers.map(m => el("span", {
            class: `wfws-avatar ${m.isYou ? "is-you" : ""}`,
            title: m.displayName
          }, m.initials))
        ),
        ordered.length > maxVisible && el("span", { class: "wfws-share-more" }, `+${ordered.length - maxVisible}`)
      );
    }

    return el("div", { class: "wfws-share-indicator is-private", "aria-label": "Private" },
      el("div", { class: "wfws-private-label" },
        el("span", { class: "wfws-private-copy" }, 
            el("span", { class: "wfws-private-main" }, "Private"),
            " • Only you"
        )
      )
    );
  }


  const API = root.getAttribute("data-api") || "";
  const USER_ID = getMemberId();
  const grid = root.querySelector(".wfws-grid");
  const modal = root.querySelector(".wfws-modal");
  const modalContent = modal.querySelector(".wfws-modal-content");
  
  // Consolidate Modal Logic
  const Modal = {
     current: null,
     untrap: null,
     
     open(workspace, sourceEl) {
        this.current = workspace;
        // Populate specific modal content using existing helpers
        // ... (existing population logic to be refactored if needed, currently reusing DOM refs)
        // Example simplification for setting text content

        modal.querySelector(".wfws-modal-title").textContent = workspace.name || "Untitled Workspace";
        modal.querySelector(".wfws-modal-date").textContent = workspace.created_at ? `Created ${relativeTime(workspace.created_at)}` : "";

        
        // Status & Members logic remains similar but could use `el()` or be moved to separate renderers
        renderModalContent(workspace); // We'd move the massive block from original openModal here

        // Animation Origin
        if (sourceEl) {
            const rect = sourceEl.getBoundingClientRect();
            const x = ((rect.left + rect.width / 2) / window.innerWidth) * 100;
            const y = ((rect.top + rect.height / 2) / window.innerHeight) * 100;
            modalContent.style.transformOrigin = `${x}% ${y}%`;
        }

        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        disableScroll();
        if (this.untrap) this.untrap();
        this.untrap = trapFocus(modal);
        modal.querySelector(".wfws-modal-close")?.focus();
     },

     close() {
        if (!this.current) return;
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        if (this.untrap) { this.untrap(); this.untrap = null; }
        // enableScroll only if no other modals are open (simplified here)
        enableScroll();
        this.current = null;
     }
  };
  
  // Event Delegation for Grid Interactions
  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".wfws-card");
    if (!card) return;

    // Handle Menu Button
    const menuBtn = e.target.closest(".wfws-menu-btn");
    if (menuBtn) {
        e.preventDefault();
        e.stopPropagation();
        const dropdown = card.querySelector(".wfws-dropdown");
        
        // Close others
        root.querySelectorAll(".wfws-dropdown.open").forEach(d => d !== dropdown && d.classList.remove("open"));
        
        const isOpen = dropdown.classList.toggle("open");
        menuBtn.setAttribute("aria-expanded", String(isOpen));
        return;
    }

    // Handle Delete Action in Dropdown
    const deleteBtn = e.target.closest(".wfws-dropdown-item.danger");
    if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        card.querySelector(".wfws-dropdown")?.classList.remove("open");
        openDeleteModal(getWorkspaceFromCard(card)); // Helper needed or attach data to card
        return;
    }

    // Handle Card Click (open text/files)
    if (e.target.closest(".wfws-link") || !e.target.closest("button, a")) {
         e.preventDefault();
         const wsData = JSON.parse(card.dataset.ws || "{}"); // We need to attach data to card now
         Modal.open(wsData, card);
    }
  });

  // Global closure for dropdowns
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".wfws-menu-wrap")) {
        root.querySelectorAll(".wfws-dropdown.open").forEach(d => d.classList.remove("open"));
    }
  });

  // Global Escape
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (Modal.current) Modal.close();
    if (pendingDeleteWorkspace) closeDeleteModal();
  });


  // Delete modal elements
  const DELETE_API_URL = root.getAttribute("data-delete-api") || "";
  const deleteModal = root.querySelector("#wfws-delete-modal");
  const deleteModalBackdrop = deleteModal.querySelector(".wfws-modal-backdrop");
  const deleteAffectedSection = deleteModal.querySelector("#wfws-delete-affected");
  const deleteAffectedList = deleteModal.querySelector("#wfws-delete-affected-list");
  const deleteCancelBtn = deleteModal.querySelector("#wfws-delete-cancel");
  const deleteConfirmBtn = deleteModal.querySelector("#wfws-delete-confirm");
  let pendingDeleteWorkspace = null;
  let isDeleting = false;

  // Close any open dropdown when clicking outside
  document.addEventListener("click", (e) => {
    const openDropdowns = root.querySelectorAll(".wfws-dropdown.open");
    openDropdowns.forEach((dropdown) => {
      if (!dropdown.contains(e.target) && !dropdown.previousElementSibling?.contains(e.target)) {
        dropdown.classList.remove("open");
      }
    });
  });

  // Delete modal functions
  function openDeleteModal(workspace) {
    pendingDeleteWorkspace = workspace;
    
    // Update subtitle with workspace name
    const subtitle = deleteModal.querySelector(".wfws-delete-subtitle");
    if (subtitle) {
      subtitle.textContent = `This action cannot be undone. "${workspace.name || 'Untitled'}" and all its files will be permanently removed.`;
    }

    // Show affected members if shared
    const members = workspace.members || [];
    const otherMembers = members.filter(m => !m.isYou);
    
    if (otherMembers.length > 0) {
      deleteAffectedSection.style.display = "block";
      deleteAffectedList.innerHTML = "";
      
      otherMembers.forEach((member) => {
        const userEl = document.createElement("div");
        userEl.className = "wfws-delete-affected-user";
        
        const avatar = document.createElement("span");
        avatar.className = "wfws-delete-affected-avatar";
        avatar.textContent = getMemberInitials(member.displayName || member.email || "?");
        
        const name = document.createElement("span");
        name.textContent = member.displayName || member.email || "Member";
        
        userEl.appendChild(avatar);
        userEl.appendChild(name);
        deleteAffectedList.appendChild(userEl);
      });
    } else {
      deleteAffectedSection.style.display = "none";
    }

    // Reset button state
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
    
    // Open modal
    deleteModal.classList.add("open");
    deleteModal.setAttribute("aria-hidden", "false");
    disableScroll();
    
    // Re-initialize lucide icons
    if (window.lucide) lucide.createIcons();
    
    // Focus cancel button
    setTimeout(() => deleteCancelBtn.focus(), 100);
  }

  function closeDeleteModal() {
    deleteModal.classList.remove("open");
    deleteModal.setAttribute("aria-hidden", "true");
    pendingDeleteWorkspace = null;
    enableScroll();
  }

  async function performDelete() {
    if (!pendingDeleteWorkspace || isDeleting) return;
    
    isDeleting = true;
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.innerHTML = `<svg class="wfws-spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg>Deleting...`;
    
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
        throw new Error(errorData.message || "Failed to delete workspace");
      }
      
      pushToast("success", "Workspace deleted", `"${pendingDeleteWorkspace.name || 'Untitled'}" has been removed.`);
      closeDeleteModal();
      requestImmediateRefresh("workspace-deleted");
      
    } catch (error) {
      console.error("[Workspaces] Delete error:", error);
      pushToast("error", "Delete failed", error.message || "Could not delete workspace. Please try again.");
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
      if (window.lucide) lucide.createIcons();
    } finally {
      isDeleting = false;
    }
  }


  // Move renderModalContent extraction here for clarity
  function renderModalContent(workspace) {
    const wsStatus = getWorkspaceStatusInfo(workspace);
    const modalMeta = modal.querySelector(".wfws-modal-meta");
    
    // Status Badge
    modalMeta.innerHTML = ""; // Clear existing
    modalMeta.appendChild(el('span', { class: 'wfws-modal-date' }, workspace.created_at ? `Created ${relativeTime(workspace.created_at)}` : ""));
    modalMeta.appendChild(el('span', { class: 'wfws-modal-count' }, wsStatus.summary));

    const statusBadge = wrapStatusWithSpinner(
        createStatusBadge(wsStatus.label, wsStatus.tone), 
        wsStatus.tone
    );
    statusBadge.classList.add("wfws-modal-status");
    modalMeta.prepend(statusBadge);

    if (wsStatus.errorCount > 0) {
        modalMeta.appendChild(wrapStatusWithSpinner(
            createStatusBadge(`${wsStatus.errorCount} failed`, "error", "sm"),
            "error", { size: "sm", spin: false }
        ));
    }

    // Members Logic (simplified)
    let modalMembers = modal.querySelector(".wfws-modal-members");
    if (!modalMembers) {
        modalMembers = el('div', { class: 'wfws-modal-members' },
            el('h3', { class: 'wfws-modal-section-title' }, 'Members'),
            el('div', { class: 'wfws-member-list' }),
            el('div', { class: 'wfws-member-actions', hidden: true },
                el('button', { type: 'button', class: 'wfws-btn wfws-btn-primary wfws-member-invite', onclick: () => window.dispatchEvent(new CustomEvent("wfws:invite-members", { detail: { workspace: Modal.current } })) }, createIcon('userPlus'), el('span', {}, 'Invite collaborators')),
                el('button', { type: 'button', class: 'wfws-btn wfws-btn-secondary wfws-member-manage', onclick: () => window.dispatchEvent(new CustomEvent("wfws:manage-members", { detail: { workspace: Modal.current } })) }, createIcon('users'), el('span', {}, 'Manage access'))
            )
        );
        modal.querySelector(".wfws-modal-body").appendChild(modalMembers);
    }
    
    const members = getWorkspaceMembers(workspace);
    const membersList = modalMembers.querySelector(".wfws-member-list");
    membersList.innerHTML = "";
    
    // ... render members loop using el() ...
    if(members.length === 0) {
        // ...
    } else {
        members.forEach(m => {
             membersList.appendChild(el('div', { class: 'wfws-member-item' },
                el('div', { class: 'wfws-member-main' },
                    el('div', { class: `wfws-member-avatar ${m.isYou ? 'is-you' : ''}`, title: m.displayName }, m.initials),
                    el('div', { class: 'wfws-member-info' },
                        el('div', { class: 'wfws-member-name' }, 
                            el('span', {}, m.displayName),
                            m.isYou && el('span', { class: 'wfws-member-tag' }, '(You)')
                        ),
                        (m.email && m.email !== m.displayName) && el('div', { class: 'wfws-member-meta' }, m.email)
                    )
                )
             ));
        });
    }

    // Files
    const modalFilesList = modal.querySelector(".wfws-files-list");
    modalFilesList.innerHTML = "";
    if (workspace.files?.length > 0) {
        workspace.files.forEach(file => {
            const fileStatus = getFileStatusInfo(file);
            modalFilesList.appendChild(el('div', { class: 'wfws-file-item' },
                el('div', { class: 'wfws-file-icon' }, 
                    el('img', { style: { width: '24px', height: '24px' }, src: safeUrl(file?.iconUrl) || '', alt: file?.fileType || 'file' })
                ),
                el('div', { class: 'wfws-file-info' },
                    el('div', { class: 'wfws-file-name' }, file?.fileName || 'Untitled'),
                    el('div', { class: 'wfws-file-type' }, file?.fileType || 'file')
                ),
                wrapStatusWithSpinner(createStatusBadge(fileStatus.label, fileStatus.tone, 'sm'), fileStatus.tone, { size: 'sm' })
            ));
        });
    } else {
        modalFilesList.appendChild(el('div', { style: 'color:var(--muted);text-align:center;padding:32px;font-size:14px' }, 'No files in this workspace'));
    }
  }

  // Delete modal event listeners
  deleteCancelBtn.addEventListener("click", closeDeleteModal);
  deleteModalBackdrop.addEventListener("click", closeDeleteModal);
  deleteConfirmBtn.addEventListener("click", performDelete);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pendingDeleteWorkspace) closeDeleteModal();
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
  // (Old separate openModal/closeModal functions removed in favor of Modal object)
  modal.querySelector(".wfws-modal-close").addEventListener("click", () => Modal.close());
  modal.querySelector(".wfws-modal-backdrop").addEventListener("click", () => Modal.close());


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
    const statusInfo = getWorkspaceStatusInfo(ws);
    const errorCount = Number(ws?.errorFileCount || ws?.fileStatusCounts?.error || 0);

    // Helper for thumbnails
    const renderFiles = () => {
      if (!ws.files || ws.files.length === 0) return el("div", { class: "wfws-thumb-empty" }, "No files yet");
      
      const MAX_FILES = 5;
      const files = ws.files.slice(0, MAX_FILES).map(file => {
         const fileStatus = getFileStatusInfo(file);
         return el("div", { class: "wfws-thumb-file" },
            el("div", { class: "wfws-thumb-file-icon" }, 
               el("img", { style: { width: '16px', height: '16px' }, src: safeUrl(file?.iconUrl) || '', alt: file?.fileType || 'file' })
            ),
            el("div", { class: "wfws-thumb-file-info" },
                el("div", { class: "wfws-thumb-file-name" }, file?.fileName || "Untitled"),
                el("div", { class: "wfws-thumb-file-type" }, file?.fileType || "file")
            ),
            wrapStatusWithSpinner(createStatusBadge(fileStatus.label, fileStatus.tone, "sm"), fileStatus.tone, { size: "sm" })
         );
      });

      if (ws.files.length > MAX_FILES) {
        files.push(el("div", { class: "wfws-thumb-file", style: { justifyContent: "center", color: "var(--text-muted)" } }, 
            `+${ws.files.length - MAX_FILES} more file${ws.files.length - MAX_FILES === 1 ? '' : 's'}`
        ));
      }
      return files;
    };

    const li = el("li", { 
        class: `wfws-card ${statusInfo.tone === "pending" ? "wfws-card-pending" : ""}`,
        role: "article",
        "data-ws": JSON.stringify(ws) // For event delegation
    },
      el("a", { class: "wfws-link", href: "#", "aria-label": ws.name },
         el("div", { class: "wfws-thumb" },
            el("div", { class: "wfws-thumb-files" }, renderFiles()),
            errorCount > 0 && el("span", { class: "wfws-status-badge wfws-status-error wfws-status-sm wfws-error-pill" }, `${errorCount} failed`),
            statusInfo.tone !== "ready" && createWorkspaceProgressOverlay(statusInfo)
         )
      ),
      el("div", { class: "wfws-meta" },
         el("a", { class: "wfws-link wfws-text", href: "#", "aria-label": ws.name },
            el("div", { class: "wfws-title" }, ws.name || "Untitled"),
            el("div", { class: "wfws-time" }, [
                statusInfo.summary || (statusInfo.total > 0 ? `${statusInfo.ready}/${statusInfo.total} ready` : "Awaiting files"),
                ws.created_at ? relativeTime(ws.created_at) : ""
            ].filter(Boolean).join(" • ")),
            renderSharingIndicator(ws)
         ),
         el("div", { class: "wfws-menu-wrap" },
            el("button", { class: "wfws-menu-btn", "aria-label": "Options" }, createIcon("more")),
            el("div", { class: "wfws-dropdown", role: "menu" },
                el("button", { class: "wfws-dropdown-item danger", role: "menuitem" }, 
                    createIcon("trash"), 
                    el("span", {}, "Delete")
                )
            )
         ),
         el("div", { class: "wfws-meta-badges" },
            wrapStatusWithSpinner(createStatusBadge(statusInfo.label, statusInfo.tone), statusInfo.tone),
            errorCount > 0 && wrapStatusWithSpinner(createStatusBadge(`${errorCount} failed`, "error", "sm"), "error", { size: "sm", spin: false })
         )
      )
    );
    
    return li;
  }

  function createAddCard() {
    return el("li", { 
        class: "wfws-card wfws-add-card",
        role: "button",
        tabindex: "0",
        onclick: (e) => { e.preventDefault?.(); openAddModal(); },
        onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault(); openAddModal();
            }
        }
    }, 
      el("div", { class: "wfws-link wfws-add-link", role: "button", "aria-label": "Create New Workspace" },
        el("div", { class: "wfws-thumb wfws-add-thumb" },
            el("div", { class: "wfws-add-content" },
                el("div", { class: "wfws-add-icon" }, createIcon("plus")),
                el("div", { class: "wfws-add-text" }, "Create New Workspace")
            )
        )
      ),
      el("div", { class: "wfws-meta" },
        el("div", { class: "wfws-text" },
            el("div", { class: "wfws-title" }, "Add Workspace"),
            el("div", { class: "wfws-time" }, "Click to create")
        )
      )
    );
  }

  function createEmptyStateCard() {
    return el("li", { class: "wfws-card" },
        el("div", { style: { padding: "28px 22px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" } }, 
           "No workspaces yet. Create one to get started."
        )
    );
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

    // Lucide check only needed for non-SVG paths if any remain
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
