// WatchParty runtime clock/scheduler seam.
// Production uses browser timers; tests can replace this object to make leases
// and pending-intent timers deterministic without patching globals.

const WPRuntimeClock = (() => {
  'use strict';

  let runtimeClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (callback, delay) => setInterval(callback, delay),
    clearInterval: (timer) => clearInterval(timer),
    random: () => Math.random(),
  };

  function configureForTests(nextClock) {
    if (!nextClock || typeof nextClock !== 'object') return;
    runtimeClock = {
      now: typeof nextClock.now === 'function' ? nextClock.now : runtimeClock.now,
      setTimeout: typeof nextClock.setTimeout === 'function' ? nextClock.setTimeout : runtimeClock.setTimeout,
      clearTimeout: typeof nextClock.clearTimeout === 'function' ? nextClock.clearTimeout : runtimeClock.clearTimeout,
      setInterval: typeof nextClock.setInterval === 'function' ? nextClock.setInterval : runtimeClock.setInterval,
      clearInterval: typeof nextClock.clearInterval === 'function' ? nextClock.clearInterval : runtimeClock.clearInterval,
      random: typeof nextClock.random === 'function' ? nextClock.random : runtimeClock.random,
    };
  }

  return {
    now: () => runtimeClock.now(),
    setTimeout: (callback, delay) => runtimeClock.setTimeout(callback, delay),
    clearTimeout: (timer) => runtimeClock.clearTimeout(timer),
    setInterval: (callback, delay) => runtimeClock.setInterval(callback, delay),
    clearInterval: (timer) => runtimeClock.clearInterval(timer),
    random: () => runtimeClock.random(),
    configureForTests,
  };
})();
