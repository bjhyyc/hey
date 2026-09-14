/**
 * Support and distribution endpoints, baked at build time via NEXT_PUBLIC_*
 * (the CloudBase build overrides them through Dockerfile ARGs, the same
 * mechanism as the plan code). Everything here degrades honestly: an
 * unconfigured value renders "not yet available" rather than a dead control.
 */

/** The customer-service QQ number. Empty until the operator provides one. */
export const SUPPORT_QQ = (process.env.NEXT_PUBLIC_SUPPORT_QQ ?? "").trim();

/**
 * QQ's web-to-chat entry. Tencent moved stranger "temporary sessions" behind
 * the paid 企点 product, so for an ordinary number this link now answers
 * "无法发起临时会话" unless the visitor is already a friend. It is therefore
 * kept only as a last-resort shortcut, never as the advertised channel.
 */
export const SUPPORT_QQ_URL = SUPPORT_QQ
  ? `https://wpa.qq.com/msgrd?v=3&uin=${encodeURIComponent(SUPPORT_QQ)}&site=heyirmy.com&menu=yes`
  : "";

/**
 * The desktop-client protocol. On a PC with QQ installed this opens the real
 * chat window immediately - for customers who already added us as a friend,
 * which is the case that actually works today.
 */
export const SUPPORT_QQ_DESKTOP_URL = SUPPORT_QQ
  ? `tencent://message/?uin=${encodeURIComponent(SUPPORT_QQ)}&Site=heyirmy.com&Menu=yes`
  : "";

/**
 * The operator's QQ profile-card short link (qm.qq.com/q/...). Opening it in
 * the QQ app leads straight to "加好友", which needs no paid product and works
 * from both phone and desktop. Empty until the operator shares their card.
 */
export const SUPPORT_QQ_CARD_URL = (process.env.NEXT_PUBLIC_SUPPORT_QQ_CARD_URL ?? "").trim();

/** Customer-service QQ group number, shown so it can be searched by hand. */
export const SUPPORT_QQ_GROUP = (process.env.NEXT_PUBLIC_SUPPORT_QQ_GROUP ?? "").trim();

/**
 * The group's join link (jq.qq.com/...). A group needs no friend approval and
 * no temporary-session permission, which makes it the one QQ entry that
 * cannot dead-end. Empty until the operator creates the group.
 */
export const SUPPORT_QQ_GROUP_URL = (process.env.NEXT_PUBLIC_SUPPORT_QQ_GROUP_URL ?? "").trim();

/** Optional support mailbox, for customers who do not use QQ at all. */
export const SUPPORT_EMAIL = (process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "").trim();

/** True when at least one support channel is configured. */
export const HAS_SUPPORT_CHANNEL = Boolean(SUPPORT_QQ || SUPPORT_QQ_GROUP_URL || SUPPORT_EMAIL);

/** Where the packaged desktop client installer lives (public COS/CDN URL). */
export const CLIENT_DOWNLOAD_URL = (process.env.NEXT_PUBLIC_CLIENT_DOWNLOAD_URL ?? "").trim();

/** SHA-256 of the installer, shown so a careful customer can verify it. */
export const CLIENT_DOWNLOAD_SHA256 = (process.env.NEXT_PUBLIC_CLIENT_DOWNLOAD_SHA256 ?? "").trim();

/** Installer version label shown next to the download button. */
export const CLIENT_VERSION = (process.env.NEXT_PUBLIC_CLIENT_VERSION ?? "").trim();

/**
 * macOS ships as two archives, one per chip, plus an install script. There is
 * no Apple developer account behind the build, so a downloaded copy cannot be
 * opened by double-clicking and cannot be let through from 系统设置 either; the
 * script downloads the right archive for the machine, verifies it, installs
 * it, and clears the quarantine that Gatekeeper acts on. All of these degrade
 * the same way as the Windows values: unset means "not available yet".
 */
export const MACOS_INSTALL_SCRIPT_URL = (process.env.NEXT_PUBLIC_MACOS_INSTALL_SCRIPT_URL ?? "").trim();

/** Apple Silicon archive and its SHA-256, the values the install script verifies against. */
export const MACOS_CLIENT_ARM64_URL = (process.env.NEXT_PUBLIC_MACOS_CLIENT_ARM64_URL ?? "").trim();
export const MACOS_CLIENT_ARM64_SHA256 = (process.env.NEXT_PUBLIC_MACOS_CLIENT_ARM64_SHA256 ?? "").trim();

/** Intel archive and its SHA-256. */
export const MACOS_CLIENT_X64_URL = (process.env.NEXT_PUBLIC_MACOS_CLIENT_X64_URL ?? "").trim();
export const MACOS_CLIENT_X64_SHA256 = (process.env.NEXT_PUBLIC_MACOS_CLIENT_X64_SHA256 ?? "").trim();

/** Version label shown for the macOS build. */
export const MACOS_CLIENT_VERSION = (process.env.NEXT_PUBLIC_MACOS_CLIENT_VERSION ?? "").trim();

/**
 * Whether the macOS build is signed with a Developer ID *and* notarized by
 * Apple. While false the page leads with the install script, because a plain
 * download cannot be opened; once true the archives are offered directly and
 * the script and its explanation disappear, since a notarized app opens with
 * no prompt at all and telling people otherwise only sends them looking for a
 * problem that is not there.
 *
 * Defaults to false, because that is what a build produces when the signing
 * credentials are absent - electron-builder skips notarization silently rather
 * than failing, so a green build is no evidence at all. Only set this true
 * after `spctl -a -vvv --type install` accepts the stapled build and a Mac with
 * no developer certificate has opened the downloaded copy without a prompt.
 */
export const MACOS_CLIENT_NOTARIZED =
  (process.env.NEXT_PUBLIC_MACOS_CLIENT_NOTARIZED ?? "").trim() === "true";
