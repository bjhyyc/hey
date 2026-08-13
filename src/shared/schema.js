const SUPPORTED_ASSET_EXTENSIONS = [".gif", ".webp", ".webm", ".mp4", ".mov", ".png", ".svg"];
const SUPPORTED_OPERATORS = ["=", "!=", ">", ">=", "<", "<=", "between", "in", "notIn"];
const SUPPORTED_ACTION_TYPES = [
  "blank",
  "delay",
  "playAnimation",
  "setKeyframeProgress",
  "showMessage",
  "randomMessage",
  "changeScale",
  "changeOpacity",
  "movePet",
  "pomodoroTimer",
  "hidePet",
  "showPet",
  "disableInteractions",
  "enableInteractions",
  "resetPosition",
  "openPanel"
];

const DISCRETE_POINTER_FIELDS = [
  "distanceToPetCenter"
];

const DRAG_PROGRESS_FIELDS = [
  "isInsidePet",
  "distanceToPetCenter",
  "distanceToPetBounds",
  "dragDeltaX",
  "dragDeltaY",
  "dragDistance",
  "dragDurationMs"
];

const TIME_FIELDS = ["elapsedMs"];
const MOUSE_STILL_FIELDS = ["isInsidePet", "distanceToPetCenter", "distanceToPetBounds", "durationMs"];
const CLOCK_FIELDS = ["currentHour", "dayOfWeek"];
const POMODORO_COMPLETE_FIELDS = ["durationMs", "elapsedMs", "label"];

const TRIGGER_PARAMETER_FIELDS = {
  click: DISCRETE_POINTER_FIELDS,
  doubleClick: DISCRETE_POINTER_FIELDS,
  rightClick: DISCRETE_POINTER_FIELDS,
  dragStart: DISCRETE_POINTER_FIELDS,
  dragging: DRAG_PROGRESS_FIELDS,
  dragEnd: DRAG_PROGRESS_FIELDS,
  mouseEnter: DISCRETE_POINTER_FIELDS,
  mouseLeave: DISCRETE_POINTER_FIELDS,
  mouseMove: [
    "isInsidePet",
    "distanceToPetCenter",
    "distanceToPetBounds",
    "deltaX",
    "deltaY",
    "speed",
    "direction",
    "angleToPet",
    "angleToPetDegrees",
    "angleToPetProgress",
    "isMovingTowardPet",
    "isMovingAwayFromPet"
  ],
  mouseStill: MOUSE_STILL_FIELDS,
  hoverDuration: TIME_FIELDS,
  idleDuration: TIME_FIELDS,
  timer: CLOCK_FIELDS,
  randomTimer: CLOCK_FIELDS,
  pomodoroComplete: POMODORO_COMPLETE_FIELDS,
  appLaunch: [],
  packageLoaded: []
};

module.exports = {
  SUPPORTED_ASSET_EXTENSIONS,
  SUPPORTED_OPERATORS,
  SUPPORTED_ACTION_TYPES,
  TRIGGER_PARAMETER_FIELDS
};
