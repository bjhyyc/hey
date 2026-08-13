const CURRENT_ONBOARDING_VERSION = 1;

function getOnboardingVersion(config) {
  const version = Number(config && config.system && config.system.onboardingVersion);
  return Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
}

function shouldShowOnboarding(config) {
  return getOnboardingVersion(config) < CURRENT_ONBOARDING_VERSION;
}

module.exports = {
  CURRENT_ONBOARDING_VERSION,
  getOnboardingVersion,
  shouldShowOnboarding
};
