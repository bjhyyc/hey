// Browser-native ESM mirror of studio-behavior-profile.json. Keep the JSON as
// the CommonJS/server contract; the sync test prevents either representation
// from drifting. A JavaScript module is required when Electron loads renderer
// source directly over file:// in development mode.
const studioProfile = Object.freeze({
  profile: "petpack-studio/v1",
  actionKeys: Object.freeze([
    "idle",
    "sneeze",
    "roll",
    "sleepTransition",
    "sleepLoop",
    "stretch",
    "hoverAttention"
  ]),
  oneshotActionKeys: Object.freeze([
    "sneeze",
    "roll",
    "sleepTransition",
    "stretch",
    "hoverAttention"
  ]),
  interruptActionKeys: Object.freeze([
    "sneeze",
    "roll",
    "sleepTransition",
    "stretch"
  ]),
  defaultTiming: Object.freeze({
    idleTimeoutMs: 22000,
    hoverDelayMs: 2000,
    hoverCooldownMs: 20000
  })
});

export default studioProfile;
