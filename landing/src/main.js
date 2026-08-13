const sections = Array.from(document.querySelectorAll(".story-section"));
const tabs = Array.from(document.querySelectorAll("[data-tab-target]"));
const paw = document.querySelector(".tab-paw");
const downloadDialog = document.querySelector("#download-guide");
const appDownloadLinks = Array.from(document.querySelectorAll(".js-app-download"));
const sectionByName = new Map(sections.map((section) => [section.dataset.section, section]));
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const wheelSensitivity = reduceMotion.matches ? 1 / 120 : 1 / 600;
const minWheelStep = reduceMotion.matches ? 0.12 : 0.08;
const touchSensitivity = reduceMotion.matches ? 0.012 : 0.0045;
const snapDelayMs = reduceMotion.matches ? 80 : 320;

let progress = Math.max(
  0,
  sections.findIndex((section) => `#${section.id}` === window.location.hash)
);
let targetProgress = progress;
let activeIndex = Math.round(progress);
let scrollAnchor = Math.round(progress);
let touchStartY = null;
let animationFrame = null;
let snapTimer = null;

function clampProgress(value) {
  return Math.min(Math.max(value, 0), sections.length - 1);
}

function opacityForDistance(distance) {
  // Use a steeper curve so one section is clearly dominant during transition.
  // Fully visible within 0.35, fully gone by 0.75 — avoids the ghostly 50/50 overlap.
  const t = Math.min(Math.max((0.75 - distance) / 0.75, 0), 1);
  return t * t * (3 - 2 * t); // smoothstep — fast fade-in, fast fade-out, smooth at edges
}

function setActiveIndex(nextIndex, { updateHash = true } = {}) {
  activeIndex = nextIndex;
  const activeSection = sections[activeIndex];
  const sectionName = activeSection.dataset.section;

  for (const section of sections) {
    const isActive = section === activeSection;
    section.classList.toggle("is-active", isActive);
    section.setAttribute("aria-hidden", String(!isActive));
    section.style.pointerEvents = isActive ? "auto" : "none";
  }

  for (const tab of tabs) {
    tab.classList.toggle("active-section", tab.dataset.tabTarget === sectionName);
  }

  if (updateHash && window.location.hash !== `#${activeSection.id}`) {
    history.replaceState(null, "", `#${activeSection.id}`);
  }
}

function renderProgress({ updateHash = true } = {}) {
  const nearestIndex = Math.round(progress);

  for (const [index, section] of sections.entries()) {
    const distance = Math.abs(index - progress);
    const opacity = opacityForDistance(distance);
    section.style.opacity = opacity.toFixed(3);
    section.style.zIndex = String(Math.round(opacity * 100));

    // Stagger content elements: copy slides up and fades in slightly after the section
    const copy = section.querySelector(".copy-block");
    const stat = section.querySelector(".stat-block");
    if (copy) {
      const contentOpacity = Math.min(Math.max((opacity - 0.3) / 0.7, 0), 1);
      const translateY = (1 - contentOpacity) * 32;
      copy.style.opacity = contentOpacity.toFixed(3);
      copy.style.transform = `translateY(${translateY.toFixed(1)}px)`;
    }
    if (stat) {
      const statOpacity = Math.min(Math.max((opacity - 0.5) / 0.5, 0), 1);
      stat.style.opacity = statOpacity.toFixed(3);
    }
  }

  updatePaw();
  setActiveIndex(nearestIndex, { updateHash });
}

// Paw indicator: tabs map to sections 1-5 (indices 0-4), sections 0 and 6 have no tab.
// Instead of sliding, the paw snaps to the nearest tab and fades in/out like the copy-block.
function updatePaw() {
  if (!paw || tabs.length === 0) return;

  // tabProgress: 0 = first tab, 4 = last tab
  const tabProgress = progress - 1;

  if (tabProgress < -0.5 || tabProgress > tabs.length - 0.5) {
    paw.style.opacity = "0";
    return;
  }

  const nearestTab = Math.round(Math.min(Math.max(tabProgress, 0), tabs.length - 1));
  const distance = Math.abs(tabProgress - nearestTab);

  // Same curve as copy-block: fade in when section is mostly settled
  const pawOpacity = Math.min(Math.max((1 - distance * 2.5), 0), 1);

  const tab = tabs[nearestTab];
  const navRect = paw.parentElement.getBoundingClientRect();
  const copyEl = tab.querySelector(".tab-copy");
  const copyRect = (copyEl || tab).getBoundingClientRect();
  const x = copyRect.left - navRect.left + 26;

  paw.style.opacity = pawOpacity.toFixed(3);
  paw.style.left = `${x.toFixed(1)}px`;
}

function setProgress(nextProgress, options) {
  progress = clampProgress(nextProgress);
  renderProgress(options);
}

function startProgressAnimation() {
  if (animationFrame) {
    return;
  }

  function tick() {
    const distance = targetProgress - progress;

    if (Math.abs(distance) < 0.004) {
      setProgress(targetProgress);
      animationFrame = null;
      return;
    }

    setProgress(progress + distance * (reduceMotion.matches ? 1 : 0.12));
    animationFrame = requestAnimationFrame(tick);
  }

  animationFrame = requestAnimationFrame(tick);
}

function clearSnapTimer() {
  if (snapTimer) {
    window.clearTimeout(snapTimer);
    snapTimer = null;
  }
}

function animateToIndex(targetIndex) {
  targetProgress = clampProgress(targetIndex);
  scrollAnchor = targetProgress;

  clearSnapTimer();
  startProgressAnimation();
}

function scheduleSnap() {
  clearSnapTimer();

  snapTimer = window.setTimeout(() => {
    snapTimer = null;
    const snapTarget = Math.round(targetProgress);
    scrollAnchor = snapTarget;
    animateToIndex(snapTarget);
  }, snapDelayMs);
}

function handleWheel(event) {
  if (downloadDialog?.open) {
    return;
  }

  if (Math.abs(event.deltaY) < 1) {
    return;
  }

  event.preventDefault();

  const wheelStep = Math.sign(event.deltaY) * Math.max(Math.abs(event.deltaY) * wheelSensitivity, minWheelStep);
  // Clamp to at most 1 section away from the scroll anchor
  targetProgress = Math.min(Math.max(clampProgress(targetProgress + wheelStep), scrollAnchor - 1), scrollAnchor + 1);
  startProgressAnimation();
  scheduleSnap();
}

function handleTouchStart(event) {
  touchStartY = event.touches[0]?.clientY ?? null;
}

function handleTouchMove(event) {
  if (downloadDialog?.open) {
    return;
  }

  if (touchStartY == null) {
    return;
  }

  const currentY = event.touches[0]?.clientY ?? touchStartY;
  const deltaY = touchStartY - currentY;

  if (Math.abs(deltaY) < 3) {
    return;
  }

  event.preventDefault();

  targetProgress = clampProgress(targetProgress + deltaY * touchSensitivity);
  // Clamp to at most 1 section away from the scroll anchor
  targetProgress = Math.min(Math.max(targetProgress, scrollAnchor - 1), scrollAnchor + 1);
  startProgressAnimation();
  touchStartY = currentY;
  scheduleSnap();
}

function handleTouchEnd() {
  if (touchStartY != null) {
    scheduleSnap();
    touchStartY = null;
  }
}

function handleKeydown(event) {
  if (downloadDialog?.open) {
    return;
  }

  if (["ArrowDown", "PageDown", " "].includes(event.key)) {
    event.preventDefault();
    animateToIndex(activeIndex + 1);
  }

  if (["ArrowUp", "PageUp"].includes(event.key)) {
    event.preventDefault();
    animateToIndex(activeIndex - 1);
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", (event) => {
    event.preventDefault();
    const target = sectionByName.get(tab.dataset.tabTarget);
    if (target) {
      animateToIndex(sections.indexOf(target));
    }
  });
}

function showDownloadGuide(platform) {
  if (!downloadDialog) return;

  const title = downloadDialog.querySelector("#download-guide-title");
  if (title) {
    title.textContent = `${platform || "应用"} 开始下载了`;
  }

  if (typeof downloadDialog.showModal === "function") {
    downloadDialog.showModal();
  } else {
    downloadDialog.setAttribute("open", "");
  }
}

for (const link of appDownloadLinks) {
  link.addEventListener("click", () => {
    window.setTimeout(() => showDownloadGuide(link.dataset.platform), 180);
  });
}

downloadDialog?.addEventListener("click", (event) => {
  if (event.target === downloadDialog) {
    downloadDialog.close();
  }
});

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const target = document.querySelector(link.getAttribute("href"));
    if (target?.classList.contains("story-section")) {
      event.preventDefault();
      animateToIndex(sections.indexOf(target));
    }
  });
});

window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
window.addEventListener("touchstart", handleTouchStart, { passive: true });
window.addEventListener("touchmove", handleTouchMove, { passive: false });
window.addEventListener("touchend", handleTouchEnd, { passive: true });
window.addEventListener("keydown", handleKeydown);
window.addEventListener("resize", () => updatePaw());
window.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("hashchange", () => {
  const targetIndex = sections.findIndex((section) => `#${section.id}` === window.location.hash);
  if (targetIndex >= 0) {
    targetProgress = targetIndex;
    setProgress(targetIndex, { updateHash: false });
  }
});

renderProgress({ updateHash: window.location.hash === "" });
