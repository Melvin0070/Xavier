(() => {
	const root = document.getElementById("wf-workspaces");
	if (!root || root.dataset.init === "1") return;
	root.dataset.init = "1";

	const prefersReducedMotion = window.matchMedia?.(
		"(prefers-reduced-motion: reduce)",
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
			(el) => el.offsetParent !== null || el === document.activeElement,
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
			workspace?.fileStatusCounts?.error || workspace?.errorFileCount || 0,
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
					normalizeStatus(file?.status),
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
					0,
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
						prefersReducedMotion ? 0 : 800,
					);

					if (errorCount > 0) {
						setTimeout(
							() => {
								pushToast(
									"warning",
									"Some files failed",
									`Retry or replace ${errorCount} file${
										errorCount === 1 ? "" : "s"
									} in ${safeName}.`,
								);
							},
							prefersReducedMotion ? 0 : 1200,
						);
					}
				} else if (previous.status === "ready" && current.status !== "ready") {
					pushToast(
						"warning",
						"Workspace updating",
						`${safeName} went back to processing.`,
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
						`'${fileName}' added to ${safeName}.`,
					);
				} else if (previousStatus !== currentStatus) {
					if (currentStatus === "ready") {
						pushToast(
							"success",
							"File ready",
							`'${fileName}' is ready in ${safeName}.`,
						);
					} else if (currentStatus === "error") {
						pushToast(
							"error",
							"File failed",
							`'${fileName}' could not be processed in ${safeName}.`,
						);
					}
				}
			});

			previous.files.forEach((_status, fileKey) => {
				if (!current.files.has(fileKey)) {
					pushToast(
						"warning",
						"File removed",
						`A file was removed from ${safeName}.`,
					);
				}
			});
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
		fill.style.width = `${Math.min(100, Math.max(0, info.percentReady || 0))}%`;
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
		const normalized = baseMembers.map((member) => ({ ...member }));

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
			const legacyShared = Array.isArray(ws?.sharedUsers) ? ws.sharedUsers : [];
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
				`${totalMembers} workspace member${totalMembers === 1 ? "" : "s"}`,
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

	const CREATE_API_URL = root.getAttribute("data-create-api") || "";
	const UPLOAD_API_URL = root.getAttribute("data-upload-api") || CREATE_API_URL;
	const DELETE_API_URL =
		"https://i94kergm7g.execute-api.eu-central-1.amazonaws.com/default/delete_workspace";

	// Menu functions
	let activeMenu = null;

	function toggleMenu(event, menuId) {
		event.preventDefault();
		event.stopPropagation();
		const dropdown = document.getElementById(menuId);
		if (!dropdown) return;

		if (activeMenu && activeMenu !== dropdown) {
			activeMenu.classList.remove("is-open");
		}

		if (dropdown.classList.contains("is-open")) {
			dropdown.classList.remove("is-open");
			activeMenu = null;
		} else {
			dropdown.classList.add("is-open");
			activeMenu = dropdown;
		}
	}

	// Delete Modal Logic
	const deleteModal = root.querySelector("#wfws-delete-modal");
	const deleteClose = deleteModal.querySelector(".wfws-modal-close");
	const deleteCancel = deleteModal.querySelector(".wfws-delete-cancel");
	const deleteConfirm = deleteModal.querySelector(".wfws-delete-confirm");
	const deleteBackdrop = deleteModal.querySelector(".wfws-modal-backdrop");
	let workspaceToDelete = null;

	function closeDeleteModal() {
		deleteModal.classList.remove("open");
		deleteModal.setAttribute("aria-hidden", "true");
		workspaceToDelete = null;
		enableScroll();
	}

	function openDeleteConfirmModal(ws) {
		if (activeMenu) {
			activeMenu.classList.remove("is-open");
			activeMenu = null;
		}

		workspaceToDelete = ws;
		const members = getWorkspaceMembers(ws);
		const hasCollaborators = members.some((m) => !m.isOwner);
		const nameEl = deleteModal.querySelector(".wfws-delete-name");
		const warningEl = deleteModal.querySelector(".wfws-delete-warning");
		const errorEl = deleteModal.querySelector(".wfws-delete-error");

		nameEl.textContent = ws.name || "this workspace";
		errorEl.classList.remove("show");
		errorEl.textContent = "";

		// Owner check is done before calling this function
		deleteConfirm.disabled = false;
		deleteConfirm.style.opacity = "1";
		deleteConfirm.style.cursor = "pointer";

		if (hasCollaborators) {
			warningEl.style.display = "block";
		} else {
			warningEl.style.display = "none";
		}

		// Ensure restriction is hidden
		const restrictionEl = deleteModal.querySelector(".wfws-delete-restriction");
		if (restrictionEl) restrictionEl.style.display = "none";

		deleteModal.classList.add("open");
		deleteModal.setAttribute("aria-hidden", "false");
		disableScroll();
	}

	async function handleDeleteWorkspace() {
		if (!workspaceToDelete) return;

		const btn = deleteConfirm;
		const originalText = btn.innerHTML;
		btn.disabled = true;
		btn.innerHTML =
			'<span class="wfws-spinner"></span><span>Deleting...</span>';

		try {
			const res = await fetch(DELETE_API_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workspaceId: workspaceToDelete.workspaceId,
					userId: USER_ID,
				}),
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(
					data.message || data.error || "Failed to delete workspace",
				);
			}

			// Success
			pushToast(
				"success",
				"Workspace deleted",
				`"${workspaceToDelete.name}" has been deleted.`,
			);
			closeDeleteModal();
			requestImmediateRefresh("delete-success");
		} catch (err) {
			console.error(err);
			const errorEl = deleteModal.querySelector(".wfws-delete-error");
			errorEl.textContent = err.message;
			errorEl.classList.add("show");
		} finally {
			btn.disabled = false;
			btn.innerHTML = originalText;
		}
	}

	// Delete Event Listeners
	if (deleteClose) deleteClose.addEventListener("click", closeDeleteModal);
	if (deleteCancel) deleteCancel.addEventListener("click", closeDeleteModal);
	if (deleteBackdrop)
		deleteBackdrop.addEventListener("click", closeDeleteModal);
	if (deleteConfirm)
		deleteConfirm.addEventListener("click", handleDeleteWorkspace);

	// Close menu when clicking outside
	document.addEventListener("click", (e) => {
		if (activeMenu && !e.target.closest(".wfws-menu-container")) {
			activeMenu.classList.remove("is-open");
			activeMenu = null;
		}
	});

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
					"sm",
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
						}),
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
						}),
					);
				}
			});

			actions.appendChild(inviteBtn);
			actions.appendChild(manageBtn);
			actions.hidden = true;
			modalMembers.appendChild(membersTitle);
			modalMembers.appendChild(list);
			modalMembers.appendChild(actions);

			if (modalFilesSection?.parentNode) {
				modalFilesSection.parentNode.insertBefore(
					modalMembers,
					modalFilesSection,
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
					"sm",
				);
				fileItem.appendChild(
					wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" }),
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
			`${((rect.left + rect.width / 2) / window.innerWidth) * 100}%`;
		const originY =
			`${((rect.top + rect.height / 2) / window.innerHeight) * 100}%`;

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
		if (e.key === "Escape" && currentWorkspaceData) closeModal();
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
			`${name} was created. We'll let you know when ready.${shareNote}`,
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
			ws?.errorFileCount || ws?.fileStatusCounts?.error || 0,
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
				img.alt = file?.fileType ? String(file.fileType) : "file";
				iconWrap.appendChild(img);

				const info = document.createElement("div");
				info.className = "wfws-thumb-file-info";
				const name = document.createElement("div");
				name.className = "wfws-thumb-file-name";
				name.textContent =
					file?.fileName ? String(file.fileName) : "Untitled";
				const type = document.createElement("div");
				type.className = "wfws-thumb-file-type";
				type.textContent =
					file?.fileType ? String(file.fileType) : "file";
				info.appendChild(name);
				info.appendChild(type);

				fileItem.appendChild(iconWrap);
				fileItem.appendChild(info);
				const fileStatus = getFileStatusInfo(file);
				const badge = createStatusBadge(
					fileStatus.label,
					fileStatus.tone,
					"sm",
				);
				fileItem.appendChild(
					wrapStatusWithSpinner(badge, fileStatus.tone, { size: "sm" }),
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
				"sm",
			);
			errorBadge.setAttribute(
				"aria-label",
				`${errorCount} file${errorCount === 1 ? "" : "s"} failed to process`,
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
		const badgeColumn = document.createElement("div");
		badgeColumn.className = "wfws-meta-badges";

		// Add Menu
		const menuContainer = document.createElement("div");
		menuContainer.className = "wfws-menu-container";
		const menuId = `wfws-menu-${Math.random().toString(36).substr(2, 9)}`;

		const menuTrigger = document.createElement("button");
		menuTrigger.className = "wfws-menu-trigger";
		menuTrigger.setAttribute("aria-label", "Workspace options");
		menuTrigger.innerHTML = '<i data-lucide="more-vertical"></i>';
		menuTrigger.addEventListener("click", (e) => toggleMenu(e, menuId));

		const menuDropdown = document.createElement("div");
		menuDropdown.className = "wfws-menu-dropdown";
		menuDropdown.id = menuId;

		const deleteBtn = document.createElement("button");
		deleteBtn.className = "wfws-menu-item danger";
		deleteBtn.innerHTML = '<i data-lucide="trash-2"></i> Delete';
		deleteBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			// Close menu
			if (activeMenu) {
				activeMenu.classList.remove("is-open");
				activeMenu = null;
			}

			const isOwner = String(ws.ownerUserId || ws.userId) === String(USER_ID);
			if (!isOwner) {
				pushToast(
					"error",
					"Permission Denied",
					"Only the workspace owner can delete this workspace.",
				);
				return;
			}

			openDeleteConfirmModal(ws);
		});

		menuDropdown.appendChild(deleteBtn);
		menuContainer.appendChild(menuTrigger);
		menuContainer.appendChild(menuDropdown);
		badgeColumn.appendChild(menuContainer);

		const statusBadge = createStatusBadge(statusInfo.label, statusInfo.tone);

		statusBadge.setAttribute(
			"aria-label",
			`Workspace status: ${statusInfo.label}`,
		);
		badgeColumn.appendChild(
			wrapStatusWithSpinner(statusBadge, statusInfo.tone),
		);

		if (errorCount > 0) {
			const errorBadgeMeta = createStatusBadge(
				`${errorCount} failed`,
				"error",
				"sm",
			);
			errorBadgeMeta.setAttribute(
				"aria-label",
				`${errorCount} file${errorCount === 1 ? "" : "s"} failed`,
			);
			badgeColumn.appendChild(
				wrapStatusWithSpinner(errorBadgeMeta, "error", {
					size: "sm",
					spin: false,
				}),
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
			"Workspace API endpoint is missing.",
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
				"[Workspaces] Max polls reached, stopping automatic updates",
			);
			return;
		}

		// Check if everything has been stable for too long
		if (!lastHasPending && lastStableTime) {
			const stableDuration = Date.now() - lastStableTime;
			if (stableDuration >= STABLE_TIMEOUT) {
				console.info(
					"[Workspaces] All workspaces stable for 5+ minutes, stopping polls",
				);
				return;
			}
		}

		let nextDelay;
		if (document.hidden) {
			// When tab is hidden, use longer interval
			nextDelay =
				BACKOFF_INTERVALS[Math.min(backoffIndex, BACKOFF_INTERVALS.length - 1)];
		} else if (typeof delay === "number") {
			nextDelay = delay;
		} else if (lastHasPending) {
			// Active processing: use short delay and reset backoff
			nextDelay = ACTIVE_POLL_DELAY;
			backoffIndex = 0;
		} else {
			// Idle: use exponential backoff
			nextDelay =
				BACKOFF_INTERVALS[Math.min(backoffIndex, BACKOFF_INTERVALS.length - 1)];
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
				},
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
					"Workspace list is up to date.",
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
					error?.message || "Check connection.",
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
