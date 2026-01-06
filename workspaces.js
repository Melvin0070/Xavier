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
  // Gracefully enable relative time if available
  if (window.dayjs && window.dayjs_plugin_relativeTime) {
    dayjs.extend(window.dayjs_plugin_relativeTime);
  }

  const root = document.getElementById("wf-workspaces");
  if (!root || root.dataset.init === "1") return;
  root.dataset.init = "1";

  const prefersReducedMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const SETTINGS = {
    FETCH_TIMEOUT_MS: 30000,
    ACTIVE_POLL_DELAY: 2500,
    ERROR_POLL_DELAY: 8000,
    BACKOFF_INTERVALS: [25000, 60000, 120000, 300000],
    MAX_POLLS: 20,
    STABLE_TIMEOUT: 300000,
  };

  const state = {
    pollTimerId: null,
    activeFetchController: null,
    lastHasPending: false,
    hasRenderedOnce: false,
    loggedAnonymousFallback: false,
    prevWorkspaceSnapshot: new Map(),
    lastFetchFailed: false,
    pollCount: 0,
    backoffIndex: 0,
    lastStableTime: null,
    currentWorkspaceData: null,
    untrapDetailsFocus: null,
    isDeleting: false,
    pendingDeleteWorkspace: null,
  };

  // ---------- tiny utilities ----------
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const on = (node, event, handler) => node?.addEventListener(event, handler);

  const safeUrl = (value, allowed = ["http:", "https:"]) => {
    try {
      const u = new URL(String(value), window.location.origin);
      return allowed.includes(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  };

  const normalizeStatus = (value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

  const getMemberId = () => {
    try {
      const raw = localStorage.getItem("_ms-mem");
      const mem = raw ? JSON.parse(raw) : null;
      return mem?.id || mem?.member_id || null;
    } catch {
      return null;
    }
  };

  const trapFocus = (container) => {
    const selectors =
      "a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex='-1'])";
    const nodes = Array.from(container.querySelectorAll(selectors)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (!nodes.length) return () => {};

    const [first, last] = [nodes[0], nodes[nodes.length - 1]];
    const onKeyDown = (e) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  };

  const disableScroll = () => {
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.classList.add("wfws-modal-open");
  };

  const enableScroll = () => {
    document.documentElement.style.overflow = "";
    document.body.style.overflow = "";
    document.body.classList.remove("wfws-modal-open");
  };

  const getToastInstance = () => {
    const fn = typeof window !== "undefined" ? window.sonnerJS : null;
    return typeof fn === "function" ? fn : null;
  };

  const pushToast = (type, title, description) => {
    const toast = getToastInstance();
    if (!toast) return;
    const payload = description ? { description } : undefined;
    const fn = toast[type] || toast;
    return typeof fn === "function" ? fn(title, payload) : toast(title, payload);
  };

  const createStatusBadge = (label, tone = "pending", size = "md") => {
    const span = el(
      "span",
      `wfws-status-badge wfws-status-${tone}${size === "sm" ? " wfws-status-sm" : ""}`,
      label
    );
    return span;
  };

  const createSpinner = (size = "md") =>
    el(
      "span",
      `wfws-spinner${
        size === "sm"
          ? " wfws-spinner-sm"
          : size === "lg"
          ? " wfws-spinner-lg"
          : ""
      }`
    );

  const wrapStatusWithSpinner = (badgeEl, tone, options = {}) => {
    const { size = "md", block = false, spin } = options;
    const wrap = el("div", `wfws-status-wrap${block ? " is-block" : ""}`);
    wrap.appendChild(badgeEl);
    const shouldSpin =
      typeof spin === "boolean" ? spin : tone !== "ready" && tone !== "error";
    if (shouldSpin) wrap.appendChild(createSpinner(size));
    return wrap;
  };

  // ---------- status + summary ----------
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

  const getFileStatusInfo = (file) => {
    const status = normalizeStatus(file?.status);
    return {
      status,
      label: FILE_STATUS_LABELS[status] || "Processing",
      tone: FILE_STATUS_TONES[status] || "pending",
    };
  };

  const getWorkspaceStatusInfo = (workspace) => {
    const status = normalizeStatus(workspace?.status);
    const total = Number(workspace?.fileCount || 0);
    const ready = Number(workspace?.fileStatusCounts?.ready || 0);
    const errorCount = Number(
      workspace?.fileStatusCounts?.error || workspace?.errorFileCount || 0
    );
    const actionableTotal = Math.max(total - errorCount, 0);
    const pendingFiles = Math.max(actionableTotal - ready, 0);

    let tone = "pending";
    let label = "Processing";
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
      summary = `${pendingFiles} file${pendingFiles === 1 ? "" : "s"} processing`;
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
  };

  const hasPendingEntities = (workspaces) =>
    Array.isArray(workspaces) &&
    workspaces.some((ws) => {
      const wsStatus = normalizeStatus(ws?.status);
      if (wsStatus && wsStatus !== "ready") return true;
      return Array.isArray(ws?.files)
        ? ws.files.some((file) => {
            const status = normalizeStatus(file?.status);
            return status && status !== "ready" && status !== "error";
          })
        : false;
    });

  // ---------- member helpers ----------
  const getMemberDisplayName = (member) =>
    member && typeof member === "object"
      ? member.displayName || member.name || member.email || "Member"
      : "Collaborator";

  const getMemberInitials = (value) => {
    const raw = String(value || "").trim();
    if (!raw) return "?";
    const handle = raw.includes("@") ? raw.split("@")[0] : raw;
    const match = handle.match(/[\p{L}\p{N}]/u);
    return match?.[0]?.toUpperCase() || handle.charAt(0).toUpperCase();
  };

  const USER_ID = getMemberId();

  const getWorkspaceMembers = (ws) => {
    const baseMembers = Array.isArray(ws?.members) ? ws.members : [];
    const normalized = baseMembers.length
      ? baseMembers.map((member) => ({ ...member }))
      : (() => {
          const ownerId = ws?.ownerUserId || ws?.userId || null;
          const fallback = [];
          if (ownerId !== null) {
            fallback.push({
              userId: ownerId,
              email: ws?.ownerEmail || null,
              role: "owner",
              isOwner: true,
              isYou: USER_ID ? String(ownerId) === String(USER_ID) : false,
            });
          }
          (Array.isArray(ws?.sharedUsers) ? ws.sharedUsers : []).forEach((value) =>
            fallback.push({ userId: null, email: value, role: "member" })
          );
          return fallback;
        })();

    return normalized.map((member) => {
      const role = member.role === "owner" ? "owner" : "member";
      const displayName = getMemberDisplayName(member);
      return {
        userId: member.userId ?? null,
        email: member.email ?? null,
        role,
        isOwner: Boolean(member.isOwner || role === "owner"),
        isYou: Boolean(member.isYou),
        displayName,
        initials: getMemberInitials(displayName),
      };
    });
  };

  const renderSharingIndicator = (ws) => {
    const members = getWorkspaceMembers(ws);
    if (!members.length) return null;

    const collaborators = members.filter((member) => !member.isOwner);
    const indicator = el("div", "wfws-share-indicator");
    if (collaborators.length === 0) {
      const badge = el("div", "wfws-private-label");
      const copy = el("span", "wfws-private-copy");
      copy.appendChild(el("span", "wfws-private-main", "Private"));
      const bullet = el("span");
      bullet.textContent = "•";
      bullet.setAttribute("aria-hidden", "true");
      copy.appendChild(bullet);
      copy.appendChild(el("span", "wfws-private-sub", "Only you"));
      badge.appendChild(copy);
      indicator.appendChild(badge);
      indicator.classList.add("is-private");
      indicator.setAttribute("aria-label", "Private workspace. Only you.");
      return indicator;
    }

    indicator.classList.add("is-shared");
    const stack = el("div", "wfws-avatar-stack");
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
    ordered.slice(0, maxVisible).forEach((member) => {
      const avatar = el("span", "wfws-avatar", member.initials);
      if (member.isYou) avatar.classList.add("is-you");
      const segments = [];
      if (member.isOwner) segments.push("Owner");
      if (!member.isOwner) segments.push("Member");
      if (member.isYou) segments.push("You");
      const prefix = segments.length ? `${segments.join(" • ")} — ` : "";
      avatar.title = `${prefix}${member.displayName}`;
      avatar.setAttribute("aria-label", avatar.title);
      stack.appendChild(avatar);
    });

    indicator.appendChild(stack);
    if (totalMembers > maxVisible) {
      const remaining = totalMembers - maxVisible;
      indicator.appendChild(el("span", "wfws-share-more", `+${remaining} more`));
    }

    indicator.setAttribute(
      "aria-label",
      `${totalMembers} workspace member${totalMembers === 1 ? "" : "s"}`
    );
    return indicator;
  };

  // ---------- DOM handles ----------
  const API = root.getAttribute("data-api") || "";
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

  const DELETE_API_URL = root.getAttribute("data-delete-api") || "";
  const deleteModal = root.querySelector("#wfws-delete-modal");
  const deleteModalBackdrop = deleteModal.querySelector(".wfws-modal-backdrop");
  const deleteAffectedSection = deleteModal.querySelector("#wfws-delete-affected");
  const deleteAffectedList = deleteModal.querySelector("#wfws-delete-affected-list");
  const deleteCancelBtn = deleteModal.querySelector("#wfws-delete-cancel");
  const deleteConfirmBtn = deleteModal.querySelector("#wfws-delete-confirm");

  const CREATE_API_URL = root.getAttribute("data-create-api") || "";
  const UPLOAD_API_URL = root.getAttribute("data-upload-api") || CREATE_API_URL;

  // Close any open dropdown when clicking outside
  on(document, "click", (e) => {
    root.querySelectorAll(".wfws-dropdown.open").forEach((dropdown) => {
      if (
        !dropdown.contains(e.target) &&
        !dropdown.previousElementSibling?.contains(e.target)
      ) {
        dropdown.classList.remove("open");
      }
    });
  });

  // ---------- notifications ----------
  const getWorkspaceKey = (workspace, index = 0) =>
    workspace?.workspaceId || workspace?.id || `${workspace?.name || "workspace"}-${index}`;

  const getFileKey = (file, index = 0, workspaceKey = "ws") =>
    file?.fileId || `${workspaceKey}::${file?.fileName || "file"}-${index}`;

  const createWorkspaceSnapshot = (workspaces) => {
    const snapshot = new Map();
    if (!Array.isArray(workspaces)) return snapshot;

    workspaces.forEach((ws, index) => {
      const key = getWorkspaceKey(ws, index);
      const statusInfo = getWorkspaceStatusInfo(ws);
      const filesMap = new Map();
      (ws?.files || []).forEach((file, fileIndex) =>
        filesMap.set(getFileKey(file, fileIndex, key), normalizeStatus(file?.status))
      );

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
  };

  const handleWorkspaceNotifications = (workspaces) => {
    if (state.prevWorkspaceSnapshot.size === 0) {
      state.prevWorkspaceSnapshot = createWorkspaceSnapshot(workspaces);
      return;
    }

    const nextSnapshot = createWorkspaceSnapshot(workspaces);

    workspaces.forEach((ws, index) => {
      const key = getWorkspaceKey(ws, index);
      const current = nextSnapshot.get(key);
      const previous = state.prevWorkspaceSnapshot.get(key);
      if (!current) return;

      const safeName = current.name || "Workspace";
      const errorCount = Number(
        ws?.errorFileCount || ws?.fileStatusCounts?.error || current.errors || 0
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
              () =>
                pushToast(
                  "warning",
                  "Some files failed",
                  `Retry or replace ${errorCount} file${
                    errorCount === 1 ? "" : "s"
                  } in ${safeName}.`
                ),
              prefersReducedMotion ? 0 : 1200
            );
          }
        } else if (previous.status === "ready" && current.status !== "ready") {
          pushToast("warning", "Workspace updating", `${safeName} went back to processing.`);
        }
      }

      (ws?.files || []).forEach((file, fileIndex) => {
        const fileKey = getFileKey(file, fileIndex, key);
        const currentStatus = current.files.get(fileKey);
        const previousStatus = previous.files.get(fileKey);
        const fileName = file?.fileName || "Untitled file";

        if (previousStatus === undefined) {
          pushToast("info", "File uploaded", `'${fileName}' added to ${safeName}.`);
        } else if (previousStatus !== currentStatus) {
          if (currentStatus === "ready") {
            pushToast("success", "File ready", `'${fileName}' is ready in ${safeName}.`);
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
          pushToast("warning", "File removed", `A file was removed from ${safeName}.`);
        }
      });
    });

    state.prevWorkspaceSnapshot.forEach((prevState, key) => {
      if (!nextSnapshot.has(key)) {
        pushToast(
          "warning",
          "Workspace removed",
          `${prevState.name || "A workspace"} is no longer available.`
        );
      }
    });

    state.prevWorkspaceSnapshot = nextSnapshot;
  };

  // ---------- UI helpers ----------
  const createWorkspaceProgressOverlay = (info) => {
    const overlay = el("div", "wfws-progress-overlay");

    const topRow = el("div", "wfws-progress-top");
    topRow.appendChild(createSpinner("lg"));

    const textGroup = el("div", "wfws-progress-text");
    textGroup.appendChild(el("div", "wfws-progress-label", info.label || "Processing"));

    const sub = el("div", "wfws-progress-subtext");
    if (info.total === 0) {
      sub.textContent = "Awaiting uploads";
    } else {
      const baseText =
        info.actionableTotal > 0
          ? `${info.ready} of ${info.actionableTotal} ready (${info.percentReady}%)`
          : `${info.ready} ready`;
      sub.textContent = info.errorCount > 0 ? `${baseText} • ${info.errorCount} failed` : baseText;
    }
    textGroup.appendChild(sub);
    topRow.appendChild(textGroup);
    overlay.appendChild(topRow);

    const meter = el("div", "wfws-progress-meter");
    const bar = el("div", "wfws-progress-bar");
    const fill = el("div", "wfws-progress-fill");
    fill.style.width = `${Math.min(100, Math.max(0, info.percentReady || 0))}%`;
    bar.appendChild(fill);
    meter.appendChild(bar);
    overlay.appendChild(meter);
    return overlay;
  };

  const relativeTime = (iso) => {
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
  };

  const setBusyState = (isBusy) =>
    root.querySelector(".wfws-inner")?.setAttribute("aria-busy", isBusy ? "true" : "false");

  const clearSkeletons = () => grid.querySelectorAll(".is-skeleton").forEach((n) => n.remove());

  // ---------- delete modal ----------
  const openDeleteModal = (workspace) => {
    state.pendingDeleteWorkspace = workspace;
    const subtitle = deleteModal.querySelector(".wfws-delete-subtitle");
    if (subtitle) {
      subtitle.textContent = `This action cannot be undone. "${
        workspace.name || "Untitled"
      }" and all its files will be permanently removed.`;
    }

    const members = workspace.members || [];
    const otherMembers = members.filter((m) => !m.isYou);
    if (otherMembers.length > 0) {
      deleteAffectedSection.style.display = "block";
      deleteAffectedList.innerHTML = "";
      otherMembers.forEach((member) => {
        const userEl = el("div", "wfws-delete-affected-user");
        const avatar = el(
          "span",
          "wfws-delete-affected-avatar",
          getMemberInitials(member.displayName || member.email || "?")
        );
        const name = el("span", "", member.displayName || member.email || "Member");
        userEl.appendChild(avatar);
        userEl.appendChild(name);
        deleteAffectedList.appendChild(userEl);
      });
    } else {
      deleteAffectedSection.style.display = "none";
    }

    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';

    deleteModal.classList.add("open");
    deleteModal.setAttribute("aria-hidden", "false");
    disableScroll();
    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => deleteCancelBtn.focus(), 100);
  };

  const closeDeleteModal = () => {
    deleteModal.classList.remove("open");
    deleteModal.setAttribute("aria-hidden", "true");
    state.pendingDeleteWorkspace = null;
    enableScroll();
  };

  const performDelete = async () => {
    if (!state.pendingDeleteWorkspace || state.isDeleting) return;
    state.isDeleting = true;
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.innerHTML =
      '<svg class="wfws-spinner" viewBox="0 0 50 50"><circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg>Deleting...';

    try {
      const response = await fetch(DELETE_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: state.pendingDeleteWorkspace.workspaceId,
          userId: USER_ID,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || "Failed to delete workspace");
      }

      pushToast(
        "success",
        "Workspace deleted",
        `"${state.pendingDeleteWorkspace.name || "Untitled"}" has been removed.`
      );
      closeDeleteModal();
      requestImmediateRefresh("workspace-deleted");
    } catch (error) {
      console.error("[Workspaces] Delete error:", error);
      pushToast(
        "error",
        "Delete failed",
        error?.message || "Could not delete workspace. Please try again."
      );
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.innerHTML = '<i data-lucide="trash-2" class="wfws-btn-icon"></i>Delete Workspace';
      if (window.lucide) window.lucide.createIcons();
    } finally {
      state.isDeleting = false;
    }
  };

  on(deleteCancelBtn, "click", closeDeleteModal);
  on(deleteModalBackdrop, "click", closeDeleteModal);
  on(deleteConfirmBtn, "click", performDelete);
  on(document, "keydown", (e) => {
    if (e.key === "Escape" && state.pendingDeleteWorkspace) closeDeleteModal();
  });

  // ---------- add modal ----------
  const openAddModal = () => {
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
  };

  // ---------- modal ----------
  const openModal = (workspace, clickedElement) => {
    state.currentWorkspaceData = workspace;
    const wsStatus = getWorkspaceStatusInfo(workspace);

    modalTitle.textContent = workspace.name || "Untitled Workspace";
    modalDate.textContent = workspace.created_at
      ? `Created ${relativeTime(workspace.created_at)}`
      : "";
    modalCount.textContent = wsStatus.summary;

    const modalMeta = modal.querySelector(".wfws-modal-meta");
    if (modalMeta) {
      modalMeta.querySelector(".wfws-modal-status")?.remove();
      modalMeta.querySelector(".wfws-modal-error")?.remove();
      const modalBadge = createStatusBadge(wsStatus.label, wsStatus.tone);
      const modalBadgeWrap = wrapStatusWithSpinner(modalBadge, wsStatus.tone);
      modalBadgeWrap.classList.add("wfws-modal-status");
      modalMeta.insertBefore(modalBadgeWrap, modalMeta.firstChild);
      if (wsStatus.errorCount > 0) {
        const errorBadge = createStatusBadge(`${wsStatus.errorCount} failed`, "error", "sm");
        const errorWrap = wrapStatusWithSpinner(errorBadge, "error", { size: "sm", spin: false });
        errorWrap.classList.add("wfws-modal-error");
        modalMeta.appendChild(errorWrap);
      }
    }

    const members = getWorkspaceMembers(workspace);
    const collaborators = members.filter((member) => !member.isOwner);
    let modalMembers = modal.querySelector(".wfws-modal-members");
    if (!modalMembers) {
      modalMembers = el("div", "wfws-modal-members");
      const membersTitle = el("h3", "wfws-modal-section-title", "Members");
      const list = el("div", "wfws-member-list");
      const actions = el("div", "wfws-member-actions");

      const inviteBtn = el("button", "wfws-btn wfws-btn-primary wfws-member-invite");
      inviteBtn.type = "button";
      inviteBtn.innerHTML = '<i data-lucide="user-plus"></i><span>Invite collaborators</span>';
      on(inviteBtn, "click", () => {
        if (state.currentWorkspaceData) {
          window.dispatchEvent(
            new CustomEvent("wfws:invite-members", { detail: { workspace: state.currentWorkspaceData } })
          );
        }
      });

      const manageBtn = el("button", "wfws-btn wfws-btn-secondary wfws-member-manage");
      manageBtn.type = "button";
      manageBtn.innerHTML = '<i data-lucide="users"></i><span>Manage access</span>';
      on(manageBtn, "click", () => {
        if (state.currentWorkspaceData) {
          window.dispatchEvent(
            new CustomEvent("wfws:manage-members", { detail: { workspace: state.currentWorkspaceData } })
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
        modalFilesSection.parentNode.insertBefore(modalMembers, modalFilesSection);
      } else {
        modal.querySelector(".wfws-modal-body")?.appendChild(modalMembers);
      }
    }

    const membersList = modalMembers.querySelector(".wfws-member-list");
    const actionsRow = modalMembers.querySelector(".wfws-member-actions");
    if (actionsRow) actionsRow.hidden = true;
    const inviteBtn = modalMembers.querySelector(".wfws-member-invite");
    const manageBtn = modalMembers.querySelector(".wfws-member-manage");
    modalMembers.querySelector(".wfws-member-empty")?.remove();

    if (membersList) {
      membersList.innerHTML = "";
      members.forEach((member) => {
        const item = el("div", "wfws-member-item");

        const main = el("div", "wfws-member-main");
        const avatar = el("div", "wfws-member-avatar", member.initials);
        if (member.isYou) avatar.classList.add("is-you");
        avatar.title = member.displayName;
        avatar.setAttribute("aria-label", member.displayName);
        main.appendChild(avatar);

        const info = el("div", "wfws-member-info");
        const nameRow = el("div", "wfws-member-name");
        nameRow.appendChild(el("span", "", member.displayName));
        if (member.isYou) nameRow.appendChild(el("span", "wfws-member-tag", "(You)"));
        info.appendChild(nameRow);
        const secondaryText = member.email && member.email !== member.displayName ? member.email : "";
        if (secondaryText) info.appendChild(el("div", "wfws-member-meta", secondaryText));
        main.appendChild(info);
        item.appendChild(main);

        const roleBadge = el(
          "span",
          `wfws-member-role ${member.isOwner ? "owner" : "member"}`,
          member.isOwner ? "Owner" : "Member"
        );
        roleBadge.hidden = true;
        item.appendChild(roleBadge);
        membersList.appendChild(item);
      });
    }

    if (manageBtn) manageBtn.disabled = collaborators.length === 0;
    if (inviteBtn) inviteBtn.disabled = false;

    if (collaborators.length === 0) {
      const emptyState = el("div", "wfws-member-empty", "This workspace is private to you.");
      if (actionsRow) modalMembers.insertBefore(emptyState, actionsRow);
      else modalMembers.appendChild(emptyState);
    }

    modalFilesList.innerHTML = "";
    if (workspace.files?.length > 0) {
      workspace.files.forEach((file) => {
        const fileItem = el("div", "wfws-file-item");
        const iconWrap = el("div", "wfws-file-icon");
        const img = el("img");
        img.style.cssText = "width:24px;height:24px";
        const src = safeUrl(file?.iconUrl, ["http:", "https:", "data:"]);
        if (src) img.src = src;
        img.alt = file?.fileType || "file";
        iconWrap.appendChild(img);

        const info = el("div", "wfws-file-info");
        info.appendChild(el("div", "wfws-file-name", file?.fileName || "Untitled"));
        info.appendChild(el("div", "wfws-file-type", file?.fileType || "file"));
        fileItem.appendChild(iconWrap);
        fileItem.appendChild(info);

        const fileStatus = getFileStatusInfo(file);
        const badge = createStatusBadge(fileStatus.label, fileStatus.tone, "sm");
        fileItem.appendChild(wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" }));
        modalFilesList.appendChild(fileItem);
      });
    } else {
      modalFilesList.innerHTML =
        '<div style="color:var(--muted);text-align:center;padding:32px;font-size:14px">No files in this workspace</div>';
    }

    const rect = clickedElement.getBoundingClientRect();
    const originX = ((rect.left + rect.width / 2) / window.innerWidth) * 100 + "%";
    const originY = ((rect.top + rect.height / 2) / window.innerHeight) * 100 + "%";
    modalContent.style.transformOrigin = `${originX} ${originY}`;
    modal.classList.add("open");

    if (window.lucide?.createIcons) window.lucide.createIcons();

    modal.setAttribute("aria-hidden", "false");
    disableScroll();
    state.untrapDetailsFocus?.();
    state.untrapDetailsFocus = trapFocus(modal);
    modalClose.focus();
  };

  const closeModal = () => {
    if (!state.currentWorkspaceData) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    state.untrapDetailsFocus?.();
    state.untrapDetailsFocus = null;
    enableScroll();
    state.currentWorkspaceData = null;
  };

  on(modalClose, "click", closeModal);
  on(modalBackdrop, "click", closeModal);
  on(document, "keydown", (e) => {
    if (e.key === "Escape" && state.currentWorkspaceData) closeModal();
  });

  on(window, "wfws:workspace-created", (event) => {
    const name = event?.detail?.workspaceName || "Workspace";
    const sharedEmails = event?.detail?.sharedEmails || [];
    const shareNote = sharedEmails.length
      ? ` Shared with ${sharedEmails.length === 1 ? "1 collaborator" : `${sharedEmails.length} collaborators`}.`
      : "";
    pushToast(
      "success",
      "Workspace uploaded",
      `${name} was created. We'll let you know when ready.${shareNote}`
    );
    requestImmediateRefresh("workspace-created");
  });

  // ---------- cards ----------
  const renderCard = (ws) => {
    const li = el("li", "wfws-card");
    li.setAttribute("role", "article");
    li.setAttribute("tabindex", "-1");

    const statusInfo = getWorkspaceStatusInfo(ws);
    const errorCount = Number(ws?.errorFileCount || ws?.fileStatusCounts?.error || 0);
    if (statusInfo.status) li.dataset.status = statusInfo.status;
    if (statusInfo.tone === "pending") li.classList.add("wfws-card-pending");

    const thumbLink = el("a", "wfws-link");
    thumbLink.href = "#";
    thumbLink.setAttribute("aria-label", ws.name);
    on(thumbLink, "click", (e) => {
      e.preventDefault();
      openModal(ws, li);
    });

    const thumb = el("div", "wfws-thumb");
    const filesWrap = el("div", "wfws-thumb-files");
    if (ws.files?.length) {
      ws.files.slice(0, 5).forEach((file) => {
        const fileItem = el("div", "wfws-thumb-file");
        const iconWrap = el("div", "wfws-thumb-file-icon");
        const img = el("img");
        img.style.width = "16px";
        img.style.height = "16px";
        const src = safeUrl(file.iconUrl, ["http:", "https:", "data:"]);
        if (src) img.src = src;
        img.alt = file?.fileType ? String(file.fileType) : "file";
        iconWrap.appendChild(img);

        const info = el("div", "wfws-thumb-file-info");
        info.appendChild(el("div", "wfws-thumb-file-name", file?.fileName || "Untitled"));
        info.appendChild(el("div", "wfws-thumb-file-type", file?.fileType || "file"));
        fileItem.appendChild(iconWrap);
        fileItem.appendChild(info);

        const fileStatus = getFileStatusInfo(file);
        const badge = createStatusBadge(fileStatus.label, fileStatus.tone, "sm");
        fileItem.appendChild(wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" }));
        filesWrap.appendChild(fileItem);
      });

      if (ws.files.length > 5) {
        const remaining = ws.files.length - 5;
        const moreItem = el("div", "wfws-thumb-file");
        moreItem.style.justifyContent = "center";
        moreItem.style.fontWeight = "500";
        moreItem.style.color = "var(--muted)";
        moreItem.textContent = `+${remaining} more file${remaining === 1 ? "" : "s"}`;
        filesWrap.appendChild(moreItem);
      }
    } else {
      filesWrap.appendChild(el("div", "wfws-thumb-empty", "No files yet"));
    }

    thumb.appendChild(filesWrap);
    if (errorCount > 0) {
      const errorBadge = createStatusBadge(`${errorCount} failed`, "error", "sm");
      errorBadge.setAttribute(
        "aria-label",
        `${errorCount} file${errorCount === 1 ? "" : "s"} failed to process`
      );
      errorBadge.classList.add("wfws-error-pill");
      thumb.appendChild(errorBadge);
    }
    if (statusInfo.tone !== "ready") thumb.appendChild(createWorkspaceProgressOverlay(statusInfo));
    thumbLink.appendChild(thumb);
    li.appendChild(thumbLink);

    const meta = el("div", "wfws-meta");
    const textWrap = el("a", "wfws-link wfws-text");
    textWrap.href = "#";
    textWrap.setAttribute("aria-label", ws.name);
    on(textWrap, "click", (e) => {
      e.preventDefault();
      openModal(ws, li);
    });
    textWrap.appendChild(el("div", "wfws-title", ws.name || "Untitled"));
    const timeEl = el("div", "wfws-time");
    const metaChunks = [];
    const summaryChunk =
      statusInfo.summary ||
      (statusInfo.total > 0 ? `${statusInfo.ready}/${statusInfo.total} ready` : "Awaiting files");
    if (summaryChunk) metaChunks.push(summaryChunk);
    if (ws.created_at) metaChunks.push(relativeTime(ws.created_at));
    timeEl.textContent = metaChunks.filter(Boolean).join(" • ");
    textWrap.appendChild(timeEl);
    const shareIndicator = renderSharingIndicator(ws);
    if (shareIndicator) textWrap.appendChild(shareIndicator);
    meta.appendChild(textWrap);

    const menuWrap = el("div", "wfws-menu-wrap");
    const menuBtn = el("button", "wfws-menu-btn");
    menuBtn.setAttribute("aria-label", "Workspace options");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';

    const dropdown = el("div", "wfws-dropdown");
    dropdown.setAttribute("role", "menu");
    const deleteItem = el("button", "wfws-dropdown-item danger");
    deleteItem.setAttribute("role", "menuitem");
    deleteItem.innerHTML = '<i data-lucide="trash-2"></i><span>Delete</span>';
    on(deleteItem, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropdown.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
      openDeleteModal(ws);
    });
    dropdown.appendChild(deleteItem);
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(dropdown);

    on(menuBtn, "click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.querySelectorAll(".wfws-dropdown.open").forEach((d) => {
        if (d !== dropdown) d.classList.remove("open");
      });
      const isOpen = dropdown.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", String(isOpen));
      if (window.lucide) window.lucide.createIcons();
    });

    meta.appendChild(menuWrap);

    const badgeColumn = el("div", "wfws-meta-badges");
    const statusBadge = createStatusBadge(statusInfo.label, statusInfo.tone);
    statusBadge.setAttribute("aria-label", `Workspace status: ${statusInfo.label}`);
    badgeColumn.appendChild(wrapStatusWithSpinner(statusBadge, statusInfo.tone));

    if (errorCount > 0) {
      const errorBadgeMeta = createStatusBadge(`${errorCount} failed`, "error", "sm");
      errorBadgeMeta.setAttribute(
        "aria-label",
        `${errorCount} file${errorCount === 1 ? "" : "s"} failed`
      );
      badgeColumn.appendChild(
        wrapStatusWithSpinner(errorBadgeMeta, "error", { size: "sm", spin: false })
      );
    }

    meta.appendChild(badgeColumn);
    li.appendChild(meta);
    return li;
  };

  const createAddCard = () => {
    const addCard = el("li", "wfws-card wfws-add-card");
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

    on(addCard, "click", (e) => {
      e.preventDefault?.();
      openAddModal();
    });
    on(addCard, "keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openAddModal();
      }
    });
    return addCard;
  };

  const createEmptyStateCard = () => {
    const empty = el("li", "wfws-card");
    const inner = el("div");
    inner.style.padding = "28px 22px";
    inner.style.textAlign = "center";
    inner.style.color = "var(--muted)";
    inner.style.fontSize = "14px";
    inner.textContent = "No workspaces yet. Create one to get started.";
    empty.appendChild(inner);
    return empty;
  };

  const renderWorkspacesList = (workspaces) => {
    clearSkeletons();
    grid.innerHTML = "";
    const fragment = document.createDocumentFragment();
    if (workspaces?.length) {
      workspaces.forEach((ws) => fragment.appendChild(renderCard(ws)));
    } else {
      fragment.appendChild(createEmptyStateCard());
    }
    fragment.appendChild(createAddCard());
    grid.appendChild(fragment);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  };

  const renderErrorState = (message) => {
    clearSkeletons();
    grid.innerHTML = "";
    const err = el("li", "wfws-card");
    const inner = el("div");
    inner.style.cssText = "padding:22px;font-size:14px;color:rgb(239,68,68)";
    inner.textContent = message;
    err.appendChild(inner);
    grid.appendChild(err);
    grid.appendChild(createAddCard());
    if (window.lucide?.createIcons) window.lucide.createIcons();
  };

  const renderConfigError = () => {
    renderErrorState("Configuration error: API URL not set.");
    pushToast("error", "Configuration issue", "Workspace API endpoint is missing.");
  };

  // ---------- polling ----------
  const scheduleNextPoll = (delay) => {
    if (state.pollTimerId) clearTimeout(state.pollTimerId);

    if (state.pollCount >= SETTINGS.MAX_POLLS) {
      console.info("[Workspaces] Max polls reached, stopping automatic updates");
      return;
    }

    if (!state.lastHasPending && state.lastStableTime) {
      const stableDuration = Date.now() - state.lastStableTime;
      if (stableDuration >= SETTINGS.STABLE_TIMEOUT) {
        console.info("[Workspaces] All workspaces stable for 5+ minutes, stopping polls");
        return;
      }
    }

    let nextDelay;
    if (document.hidden) {
      nextDelay = SETTINGS.BACKOFF_INTERVALS[Math.min(state.backoffIndex, SETTINGS.BACKOFF_INTERVALS.length - 1)];
    } else if (typeof delay === "number") {
      nextDelay = delay;
    } else if (state.lastHasPending) {
      nextDelay = SETTINGS.ACTIVE_POLL_DELAY;
      state.backoffIndex = 0;
    } else {
      nextDelay = SETTINGS.BACKOFF_INTERVALS[Math.min(state.backoffIndex, SETTINGS.BACKOFF_INTERVALS.length - 1)];
      state.backoffIndex++;
    }

    state.pollTimerId = window.setTimeout(() => runWorkspaceFetch("poll").catch(() => {}), nextDelay);
  };

  const requestImmediateRefresh = (reason = "manual") => {
    if (
      state.pollCount >= SETTINGS.MAX_POLLS ||
      (state.lastStableTime && Date.now() - state.lastStableTime >= SETTINGS.STABLE_TIMEOUT)
    ) {
      console.info("[Workspaces] Resuming polling due to user interaction");
      state.pollCount = 0;
      state.backoffIndex = 0;
      state.lastStableTime = null;
    }
    runWorkspaceFetch(reason).catch(() => {});
  };

  const loadWorkspaces = async ({ signal } = {}) => {
    const effectiveUserId = USER_ID || "public";
    if (!USER_ID && !state.loggedAnonymousFallback) {
      console.info('[Workspaces] No member ID found, using "public".');
      state.loggedAnonymousFallback = true;
    }

    const controller = new AbortController();
    if (signal?.aborted) controller.abort();
    else if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

    const timeoutId = setTimeout(() => controller.abort(), SETTINGS.FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API}?userId=${encodeURIComponent(effectiveUserId)}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const payload = typeof data.body === "string" ? JSON.parse(data.body) : data;
      return { workspaces: payload?.workspaces || [], payload };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const runWorkspaceFetch = async (reason = "refresh") => {
    if (!API) {
      console.warn("[Workspaces] Missing API endpoint.");
      renderConfigError();
      return;
    }

    if (state.pollTimerId) {
      clearTimeout(state.pollTimerId);
      state.pollTimerId = null;
    }

    if (state.activeFetchController) {
      state.activeFetchController.abort();
      state.activeFetchController = null;
    }

    if (["initial", "visibility", "focus", "manual"].includes(reason)) {
      state.pollCount = 0;
      state.backoffIndex = 0;
      state.lastStableTime = null;
    }

    const controller = new AbortController();
    state.activeFetchController = controller;
    if (!state.hasRenderedOnce) setBusyState(true);

    try {
      const { workspaces } = await loadWorkspaces({ signal: controller.signal });
      renderWorkspacesList(workspaces);
      handleWorkspaceNotifications(workspaces);

      if (state.lastFetchFailed) {
        pushToast("success", "Connection restored", "Workspace list is up to date.");
        state.lastFetchFailed = false;
      }
      state.hasRenderedOnce = true;

      const hadPendingBefore = state.lastHasPending;
      state.lastHasPending = hasPendingEntities(workspaces);
      if (!state.lastHasPending && hadPendingBefore) state.lastStableTime = Date.now();
      else if (!state.lastHasPending && !state.lastStableTime) state.lastStableTime = Date.now();
      else if (state.lastHasPending) state.lastStableTime = null;

      state.pollCount++;
      scheduleNextPoll(state.lastHasPending ? SETTINGS.ACTIVE_POLL_DELAY : undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("[Workspaces] Fetch failed", error);
      renderErrorState("Failed to load workspaces.");
      if (!state.lastFetchFailed) {
        pushToast("error", "Unable to refresh", error?.message || "Check connection.");
      }
      state.lastFetchFailed = true;
      state.lastHasPending = true;
      state.pollCount++;
      scheduleNextPoll(SETTINGS.ERROR_POLL_DELAY);
    } finally {
      setBusyState(false);
      if (state.activeFetchController === controller) state.activeFetchController = null;
    }
  };

  on(document, "visibilitychange", () => {
    if (!document.hidden) requestImmediateRefresh("visibilitychange");
  });
  on(window, "focus", () => {
    if (!document.hidden) requestImmediateRefresh("window-focus");
  });

  requestImmediateRefresh("initial-load");
})();
