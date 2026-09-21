import { onValue, ref, type Unsubscribe } from 'firebase/database';
import { db } from './config';

/**
 * Shared clock used by the show scheduler.
 *
 * We anchor Firebase's server-time estimate to performance.now() instead of
 * repeatedly doing Date.now() + offset. This keeps the clock monotonic during
 * a show even if the phone's wall clock changes.
 */
let cachedOffset = 0;
let anchorServerMs = Date.now();
let anchorPerformanceMs = typeof performance !== 'undefined' ? performance.now() : 0;
let subscriberCount = 0;
let stopListening: Unsubscribe | null = null;

function performanceNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function applyOffset(offsetMs: number) {
  cachedOffset = offsetMs;
  anchorServerMs = Date.now() + offsetMs;
  anchorPerformanceMs = performanceNow();
}

function startListening() {
  if (stopListening) return;
  stopListening = onValue(ref(db, '.info/serverTimeOffset'), snapshot => {
    const value = snapshot.val();
    applyOffset(typeof value === 'number' ? value : 0);
  });
}

/** Monotonic best-effort Firebase-server timestamp in milliseconds. */
export function serverNow(): number {
  return anchorServerMs + (performanceNow() - anchorPerformanceMs);
}

export function getServerTimeOffset(): number {
  return cachedOffset;
}

/** Subscribe to live Firebase server-clock offset updates. */
export function watchServerTimeOffset(callback: (offsetMs: number) => void): Unsubscribe {
  startListening();
  subscriberCount += 1;

  const stop = onValue(ref(db, '.info/serverTimeOffset'), snapshot => {
    const value = typeof snapshot.val() === 'number' ? snapshot.val() : 0;
    applyOffset(value);
    callback(value);
  });

  return () => {
    stop();
    subscriberCount -= 1;
    if (subscriberCount <= 0 && stopListening) {
      stopListening();
      stopListening = null;
      subscriberCount = 0;
    }
  };
}
