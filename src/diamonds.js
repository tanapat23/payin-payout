// Grab's daily diamond-quest thresholds — cumulative diamonds needed to unlock each bonus level.
// Weekend targets are higher than weekday targets.
const WEEKDAY_THRESHOLDS = [
  { level: 1, target: 435 },
  { level: 2, target: 515 },
  { level: 3, target: 615 },
  { level: 4, target: 725 },
];

const WEEKEND_THRESHOLDS = [
  { level: 1, target: 480 },
  { level: 2, target: 560 },
  { level: 3, target: 655 },
  { level: 4, target: 775 },
];

export function thresholdsFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat, noon avoids TZ edge cases
  return dow === 0 || dow === 6 ? WEEKEND_THRESHOLDS : WEEKDAY_THRESHOLDS;
}

// Highest level whose target has been reached by `cumulative` diamonds (0 if none yet).
export function levelFor(cumulative, thresholds) {
  let level = 0;
  for (const t of thresholds) {
    if (cumulative >= t.target) level = t.level;
  }
  return level;
}

export function diamondStatusText(cumulative, dateStr) {
  const thresholds = thresholdsFor(dateStr);
  const level = levelFor(cumulative, thresholds);
  const next = thresholds.find((t) => t.level === level + 1);
  if (!next) {
    return `💎 เพชรสะสมวันนี้: ${cumulative} — ถึงระดับสูงสุด (ระดับ ${level}) แล้ว 🎉`;
  }
  const progress = `${cumulative}/${next.target}`;
  const prefix = level > 0 ? `ผ่านระดับ ${level} แล้ว, ` : '';
  return `💎 เพชรสะสมวันนี้: ${progress} (${prefix}กำลังไปสู่ระดับ ${next.level})`;
}
