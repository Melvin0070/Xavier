/* ============================================
   DELETE MODAL - Standalone module
   Host on CDN and load via script tag
   ========================================== */
(function () {
	"use strict";

	function openRecentPresentationDeleteModal(itemName) {
		var deleteBtn = document.querySelector(
			'.deck-delete-btn[data-item-name="' + itemName + '"]',
		);
		if (!deleteBtn || deleteBtn.dataset.isOwner !== "true") {
			alert("Only the deck owner can delete this presentation.");
			return;
		}
		
		var modal = document.getElementById("deck-delete-modal");
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
		var warningEl = modal.querySelector(".deck-delete-collaborator-warning");

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

		var errorMsg = modal.querySelector(".deck-delete-error-msg");
		if (errorMsg) errorMsg.style.display = "none";

		modal.style.display = "flex";
		setTimeout(function () {
			modal.classList.add("active");
		}, 10);
	}

	function createDeleteModal() {
		var modal = document.createElement("div");
		modal.id = "deck-delete-modal";
		modal.className = "deck-delete-modal";
		modal.innerHTML =
			'<div class="deck-delete-modal-backdrop"></div>' +
			'<div class="deck-delete-modal-content">' +
			'<div class="deck-delete-modal-header">' +
			'<h3 class="deck-delete-modal-title">Delete Presentation</h3>' +
			'<button class="deck-delete-modal-close" aria-label="Close modal">' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
			'<line x1="18" y1="6" x2="6" y2="18"></line>' +
			'<line x1="6" y1="6" x2="18" y2="18"></line>' +
			"</svg>" +
			"</button>" +
			"</div>" +
			'<div class="deck-delete-modal-body">' +
			'<p class="deck-delete-modal-description">Are you sure you want to delete this presentation? This action cannot be undone.</p>' +
			'<div class="deck-delete-collaborator-warning" style="display: none;"></div>' +
			'<div class="deck-delete-error-msg" style="display: none;"></div>' +
			"</div>" +
			'<div class="deck-delete-modal-footer">' +
			'<button class="deck-delete-btn-secondary deck-delete-modal-cancel">Cancel</button>' +
			'<button class="deck-delete-btn-danger deck-delete-modal-submit">' +
			'<span class="deck-delete-btn-text">Delete</span>' +
			'<span class="deck-delete-btn-loader" style="display: none;">' +
			'<svg class="deck-delete-spinner" viewBox="0 0 50 50">' +
			'<circle class="deck-delete-path" cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle>' +
			"</svg>" +
			"</span>" +
			"</button>" +
			"</div>" +
			"</div>";

		modal
			.querySelector(".deck-delete-modal-backdrop")
			.addEventListener("click", closeRecentPresentationDeleteModal);
		modal
			.querySelector(".deck-delete-modal-close")
			.addEventListener("click", closeRecentPresentationDeleteModal);
		modal
			.querySelector(".deck-delete-modal-cancel")
			.addEventListener("click", closeRecentPresentationDeleteModal);
		modal
			.querySelector(".deck-delete-modal-submit")
			.addEventListener("click", handleDeleteSubmit);

		return modal;
	}

	function closeRecentPresentationDeleteModal() {
		var modal = document.getElementById("deck-delete-modal");
		if (modal) {
			modal.classList.remove("active");
			setTimeout(function () {
				modal.style.display = "none";
			}, 300);
		}
	}

	function showDeleteError(message) {
		var modal = document.getElementById("deck-delete-modal");
		var errorMsg = modal.querySelector(".deck-delete-error-msg");
		errorMsg.textContent = message;
		errorMsg.style.display = "block";
	}

	function handleDeleteSubmit() {
		var modal = document.getElementById("deck-delete-modal");
		var submitBtn = modal.querySelector(".deck-delete-modal-submit");
		var btnText = submitBtn.querySelector(".deck-delete-btn-text");
		var btnLoader = submitBtn.querySelector(".deck-delete-btn-loader");
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
					closeRecentPresentationDeleteModal();
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
	window.openRecentPresentationDeleteModal = openRecentPresentationDeleteModal;
	window.closeRecentPresentationDeleteModal = closeRecentPresentationDeleteModal;
})();
