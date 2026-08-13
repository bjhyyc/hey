/**
 * Creates a throttled function that only invokes the provided function at most once per delay period.
 * @param {Function} fn - The function to throttle
 * @param {number} delayMs - The delay in milliseconds
 * @returns {Function} The throttled function
 */
export function throttle(fn, delayMs) {
  let lastCallTime = 0;
  let timeoutId = null;
  let lastArgs = null;

  return function throttled(...args) {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;

    lastArgs = args;

    // If enough time has passed, call immediately
    if (timeSinceLastCall >= delayMs) {
      lastCallTime = now;
      fn.apply(this, args);
      return;
    }

    // Otherwise, schedule a call for the end of the period
    if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCallTime = Date.now();
        timeoutId = null;
        if (lastArgs) {
          fn.apply(this, lastArgs);
        }
      }, delayMs - timeSinceLastCall);
    }
  };
}
