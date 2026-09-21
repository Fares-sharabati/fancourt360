export type LightState = {
  time: number;
  on: boolean;
  color?: string;
};

export type LightTimeline = LightState[];

export function generateLightTimeline(
  beats: { time: number; strength: number }[],
  color?: string
): LightTimeline {
  const timeline: LightTimeline = [];

  for (const beat of beats) {
    const time = Math.round(beat.time * 1000);
    // Keep flashes short enough to read as a beat while giving slower devices
    // enough time to visibly light up.
    const flashDuration = Math.round(100 + beat.strength * 120);
    timeline.push({ time, on: true, ...(color ? { color } : {}) });
    timeline.push({ time: time + flashDuration, on: false, ...(color ? { color } : {}) });
  }

  return timeline.sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on));
}

export function getLightStateAtTime(
  timeline: LightTimeline,
  position: number
): boolean {
  if (!timeline.length || position < timeline[0].time) return false;

  let state = false;
  for (const event of timeline) {
    if (event.time > position) break;
    state = event.on;
  }
  return state;
}

export function getNextLightEvent(
  timeline: LightTimeline,
  position: number
): LightState | null {
  // Binary search avoids repeatedly scanning the complete timeline during a show.
  let low = 0;
  let high = timeline.length - 1;
  let answer = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].time > position) {
      answer = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return answer >= 0 ? timeline[answer] : null;
}
