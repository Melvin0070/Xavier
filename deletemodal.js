/* ============================================
   DELETE MODAL - Standalone module
   Host on CDN and load via script tag
   ========================================== */
(function () {
	"use strict";

	function openDeleteModal(itemName) {
		var deleteBtn = document.querySelector(
			'.deck-delete-btn[data-item-name="' + itemName + '"]',
		);
		if (!deleteBtn || deleteBtn.dataset.isOwner !== "true") {
			alert("Only the deck owner can delete this presentation.");
			return;
		}
		
		var modal = document.getElementById("delete-deck-modal");
		if (!modal) {
			modal = createDeleteModal();
			document.body.appendChild(modal);
		}

		modal.dataset.itemName = itemName;

		// Check for collaborators and show warning
		var avatarStack = document.querySelector(
			'.deck-avatar-stack[data-item-name="' + itemName + '"]',
		);
		var collaboratorCount = avatarStack
			? avatarStack.querySelectorAll(".deck-avatar:not(.is-owner)").length
			: 0;
		var warningEl = modal.querySelector(".delete-collaborator-warning");

		if (collaboratorCount > 0) {
			warningEl.innerHTML =
				'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
				'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
				'<line x1="12" y1="9" x2="12" y2="13"></line>' +
				'<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
				"</svg>" +
				"<span>This presentation is shared with " +
				collaboratorCount +
				" collaborator" +
				(collaboratorCount > 1 ? "s" : "") +
				". Deleting will only remove it from your account, not theirs.</span>";
			warningEl.style.display = "flex";
		} else {
			warningEl.style.display = "none";
		}

		var errorMsg = modal.querySelector(".delete-error-msg");
		if (errorMsg) errorMsg.style.display = "none";

		modal.style.display = "flex";
		setTimeout(function () {
			modal.classList.add("active");
		}, 10);
	}

	function createDeleteModal() {
		var modal = document.createElement("div");
		modal.id = "delete-deck-modal";
		modal.className = "delete-modal";
		modal.innerHTML =
			'<div class="delete-modal-backdrop"></div>' +
			'<div class="delete-modal-content">' +
			'<div class="delete-modal-header">' +
			'<h3 class="delete-modal-title">Delete Presentation</h3>' +
			'<button class="delete-modal-close" aria-label="Close modal">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<line x1="18" y1="6" x2="6" y2="18"></line>' +
			'<line x1="6" y1="6" x2="18" y2="18"></line>' +
			"</svg>" +
			"</button>" +
			"</div>" +
			'<div class="delete-modal-body">' +
			'<p class="delete-modal-description">Are you sure you want to delete this presentation? This action cannot be undone.</p>' +
			'<div class="delete-collaborator-warning" style="display: none;"></div>' +
			'<div class="delete-error-msg" style="display: none;"></div>' +
			"</div>" +
			'<div class="delete-modal-footer">' +
			'<button class="delete-btn-secondary delete-modal-cancel">Cancel</button>' +
			'<button class="delete-btn-danger delete-modal-submit">' +
			'<span class="delete-btn-text">Delete</span>' +
			'<span class="delete-btn-loader" style="display: none;">' +
			'<svg class="delete-spinner" viewBox="0 0 50 50">' +
			'<circle class="path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle>' +
			"</svg>" +
			"</span>" +
			"</button>" +
			"</div>" +
			"</div>";

		modal
			.querySelector(".delete-modal-backdrop")
			.addEventListener("click", closeDeleteModal);
		modal
			.querySelector(".delete-modal-close")
			.addEventListener("click", closeDeleteModal);
		modal
			.querySelector(".delete-modal-cancel")
			.addEventListener("click", closeDeleteModal);
		modal
			.querySelector(".delete-modal-submit")
			.addEventListener("click", handleDeleteSubmit);

		return modal;
	}

	function closeDeleteModal() {
		var modal = document.getElementById("delete-deck-modal");
		if (modal) {
			modal.classList.remove("active");
			setTimeout(function () {
				modal.style.display = "none";
			}, 300);
		}
	}

	function showDeleteError(message) {
		var modal = document.getElementById("delete-deck-modal");
		var errorMsg = modal.querySelector(".delete-error-msg");
		errorMsg.textContent = message;
		errorMsg.style.display = "block";
	}

	function handleDeleteSubmit() {
		var modal = document.getElementById("delete-deck-modal");
		var submitBtn = modal.querySelector(".delete-modal-submit");
		var btnText = submitBtn.querySelector(".delete-btn-text");
		var btnLoader = submitBtn.querySelector(".delete-btn-loader");
		var itemName = modal.dataset.itemName;

		window.$memberstackDom.getCurrentMember().then(function (result) {
			var member = result.data;
			if (!member || !member.id) {
				showDeleteError("Unable to verify your identity. Please try again.");
				return;
			}

			var userId = member.id;

			submitBtn.disabled = true;
			btnText.style.display = "none";
			btnLoader.style.display = "inline-block";

			var deletePayload = {
				user_id: userId,
				item_name: itemName,
			};

			fetch(
				"https://rn2rsz6wbl.execute-api.eu-west-1.amazonaws.com/final/delete-recent-presentations",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(deletePayload),
				},
			)
				.then(function (response) {
					if (!response.ok) {
						throw new Error("Failed to delete presentation. Please try again.");
					}
					return response.json();
				})
				.then(function () {
					closeDeleteModal();
					var card = document.querySelector(
						'.slide-link[data-item-name="' + itemName + '"]',
					);
					if (card) {
						var cardWrapper = card.closest(".w-dyn-item") || card.parentElement;
						if (cardWrapper) {
							cardWrapper.style.transition =
								"opacity 0.3s ease, transform 0.3s ease";
							cardWrapper.style.opacity = "0";
							cardWrapper.style.transform = "scale(0.95)";
							setTimeout(function () {
								cardWrapper.remove();
							}, 300);
						}
					}
					if (window.showSuccessToast) {
						window.showSuccessToast("Presentation deleted successfully");
					}
				})
				.catch(function (error) {
					showDeleteError(
						error.message || "Failed to delete presentation. Please try again.",
					);
				})
				.finally(function () {
					submitBtn.disabled = false;
					btnText.style.display = "inline";
					btnLoader.style.display = "none";
				});
		});
	}

	// Expose globally
	window.openDeleteModal = openDeleteModal;
	window.closeDeleteModal = closeDeleteModal;
})();
