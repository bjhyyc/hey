/**
 * Support and distribution endpoints, baked at build time via NEXT_PUBLIC_*
 * (the CloudBase build overrides them through Dockerfile ARGs, the same
 * mechanism as the plan code). Everything here degrades honestly: an
 * unconfigured value renders "not yet available" rather than a dead control.
 */

/** The customer-service QQ number. Empty until the operator provides one. */
export const SUPPORT_QQ = (process.env.NEXT_PUBLIC_SUPPORT_QQ ?? "").trim();

/**
 * QQ's web-to-chat entry. It opens a temporary chat with the number, and we
 * always show the number alongside it - a customer whose QQ blocks temporary
 * chats can still search and add it by hand.
 */
export const SUPPORT_QQ_URL = SUPPORT_QQ
  ? `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(SUPPORT_QQ)}&site=heyirmy.com&menu=yes`
  : "";

/** Where the packaged desktop client installer lives (public COS/CDN URL). */
export const CLIENT_DOWNLOAD_URL = (process.env.NEXT_PUBLIC_CLIENT_DOWNLOAD_URL ?? "").trim();

/** SHA-256 of the installer, shown so a careful customer can verify it. */
export const CLIENT_DOWNLOAD_SHA256 = (process.env.NEXT_PUBLIC_CLIENT_DOWNLOAD_SHA256 ?? "").trim();

/** Installer version label shown next to the download button. */
export const CLIENT_VERSION = (process.env.NEXT_PUBLIC_CLIENT_VERSION ?? "").trim();
