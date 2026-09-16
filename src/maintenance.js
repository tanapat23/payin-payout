const OIL_CHANGE_INTERVAL_KM = 3500;
const OIL_CHANGE_WARNING_BEFORE_KM = 500;

// Warns once the car is within 500 km of the 3,500 km oil-change interval, and again
// (more urgently) once it's overdue. Returns null when there's nothing to say.
export function oilChangeWarning(currentOdometer, lastChangeOdometer) {
  if (currentOdometer == null || lastChangeOdometer == null) return null;
  const sinceChange = currentOdometer - lastChangeOdometer;
  if (sinceChange >= OIL_CHANGE_INTERVAL_KM) {
    return `🚨 เกินรอบเปลี่ยนน้ำมันเครื่องแล้ว! วิ่งมา ${Math.round(sinceChange).toLocaleString('en-US')} กม. นับจากเปลี่ยนครั้งล่าสุด ควรเปลี่ยนโดยด่วน`;
  }
  if (sinceChange >= OIL_CHANGE_INTERVAL_KM - OIL_CHANGE_WARNING_BEFORE_KM) {
    const remaining = Math.round(OIL_CHANGE_INTERVAL_KM - sinceChange);
    return `⚠️ ใกล้ถึงรอบเปลี่ยนน้ำมันเครื่องแล้ว เหลืออีกประมาณ ${remaining.toLocaleString('en-US')} กม.`;
  }
  return null;
}
