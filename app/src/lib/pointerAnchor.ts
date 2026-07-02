type Point = { x: number; y: number };

let lastPointer: Point = {
  x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
  y: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
};

let tracking = false;

function rememberPointer(event: PointerEvent | MouseEvent | TouchEvent) {
  const touch =
    ('touches' in event && event.touches[0]) ||
    ('changedTouches' in event && event.changedTouches[0]) ||
    null;
  const x = touch ? touch.clientX : (event as MouseEvent).clientX;
  const y = touch ? touch.clientY : (event as MouseEvent).clientY;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    lastPointer = { x, y };
  }
}

export function ensurePointerTracking() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('pointerdown', rememberPointer, true);
  document.addEventListener('mousedown', rememberPointer, true);
  document.addEventListener('touchstart', rememberPointer, true);
}

export function getLastPointer(): Point {
  return { ...lastPointer };
}

function overflowScore(
  left: number,
  top: number,
  width: number,
  height: number,
  margin: number,
  vw: number,
  vh: number,
) {
  let score = 0;
  if (left < margin) score += margin - left;
  if (top < margin) score += margin - top;
  if (left + width > vw - margin) score += left + width - (vw - margin);
  if (top + height > vh - margin) score += top + height - (vh - margin);
  return score;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Prefer top-left, then bottom-left, top-right, bottom-right of cursor. */
export function pickAnchoredPosition(
  anchor: Point,
  boxWidth: number,
  boxHeight: number,
  margin = 12,
  gap = 12,
): Point {
  const vw = Math.max(document.documentElement.clientWidth, window.innerWidth);
  const vh = Math.max(document.documentElement.clientHeight, window.innerHeight);
  const bw = Math.min(boxWidth, Math.max(160, vw - margin * 2));
  const bh = Math.min(boxHeight, Math.max(120, vh - margin * 2));
  const { x, y } = anchor;

  const candidates = [
    { left: x - bw - gap, top: y - bh - gap },
    { left: x - bw - gap, top: y + gap },
    { left: x + gap, top: y - bh - gap },
    { left: x + gap, top: y + gap },
  ];

  let picked = candidates[0];
  let bestScore = overflowScore(picked.left, picked.top, bw, bh, margin, vw, vh);
  for (const candidate of candidates) {
    const score = overflowScore(candidate.left, candidate.top, bw, bh, margin, vw, vh);
    if (score === 0) {
      picked = candidate;
      break;
    }
    if (score < bestScore) {
      picked = candidate;
      bestScore = score;
    }
  }

  return {
    x: clamp(picked.left, margin, Math.max(margin, vw - bw - margin)),
    y: clamp(picked.top, margin, Math.max(margin, vh - bh - margin)),
  };
}
