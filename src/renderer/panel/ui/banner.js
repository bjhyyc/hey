/**
 * Banner message management
 */

let bannerElement = null;

/**
 * Initialize banner with DOM element reference
 * @param {HTMLElement} el - Banner DOM element
 */
export function initBanner(el) {
  bannerElement = el;
}

/**
 * Show banner message
 * @param {string} message - Message to display
 * @param {string} tone - "error" or "success"
 */
export function showBanner(message, tone = "error") {
  if (!bannerElement) return;

  bannerElement.textContent = message;
  bannerElement.classList.toggle("success", tone === "success");
  bannerElement.hidden = false;

  if (tone === "success") {
    window.setTimeout(() => {
      bannerElement.hidden = true;
    }, 2200);
  }
}

/**
 * Hide banner message
 */
export function hideBanner() {
  if (!bannerElement) return;

  bannerElement.hidden = true;
  bannerElement.textContent = "";
  bannerElement.classList.remove("success");
}
