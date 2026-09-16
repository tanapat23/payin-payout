import { Telegraf, Markup } from 'telegraf';
import { todayStr, timeStr, addDays } from './dateUtils.js';
import * as db from './db.js';
import { diamondStatusText } from './diamonds.js';
import { oilChangeWarning } from './maintenance.js';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
// Income can optionally carry a diamond count, space-separated: "21 35" = 21 baht, +35 diamonds.
const INCOME_RE = /^(\d+(?:\.\d{1,2})?)(?:\s+(\d+))?$/;
// Oil-change expenses require both the amount and the odometer reading: "300 15000".
const AMOUNT_ODOMETER_RE = /^(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)$/;

const TOP_CATEGORIES = [
  { key: 'fuel', label: '⛽ น้ำมัน' },
  { key: 'food', label: '🍔 อาหาร' },
  { key: 'other', label: '📦 อื่นๆ' },
];
const REPAIR_SUBCATEGORIES = [
  { key: 'oil_change', label: '🛢 เปลี่ยนน้ำมันเครื่อง' },
  { key: 'tire', label: '🛞 เปลี่ยนยาง' },
  { key: 'repair_other', label: '🔧 ซ่อมอื่นๆ' },
];
const ALL_CATEGORIES = [...TOP_CATEGORIES, ...REPAIR_SUBCATEGORIES];
const categoryLabel = (key) => ALL_CATEGORIES.find((c) => c.key === key)?.label || '📦 อื่นๆ';

function baht(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatHours(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} ชม. ${m} นาที`;
}

const notStartedKeyboard = Markup.keyboard([['🚗 เริ่มบันทึก']]).resize();
const recordingKeyboard = Markup.keyboard([
  ['💰 รายได้', '💸 รายจ่าย'],
  ['↩️ ลบรายการล่าสุด'],
  ['🏁 จบการบันทึก'],
]).resize();
const categoryKeyboard = Markup.inlineKeyboard([
  ...TOP_CATEGORIES.filter((c) => c.key !== 'other').map((c) => [Markup.button.callback(c.label, `expense_cat_${c.key}`)]),
  [Markup.button.callback('🔧 ซ่อมบำรุง', 'repair_menu')],
  [Markup.button.callback('📦 อื่นๆ', 'expense_cat_other')],
]);
const repairMenuKeyboard = Markup.inlineKeyboard([
  ...REPAIR_SUBCATEGORIES.map((c) => [Markup.button.callback(c.label, `expense_cat_${c.key}`)]),
  [Markup.button.callback('← กลับ', 'expense_cat_menu')],
]);

function summaryText(summary) {
  const lines = [
    `📅 สรุปวันที่ ${summary.date}`,
    `💰 รายได้: ${baht(summary.income)} บาท`,
    `💸 รายจ่าย: ${baht(summary.expense)} บาท`,
    `📊 คงเหลือ: ${baht(summary.net)} บาท`,
    `🧾 จำนวนรายการ: ${summary.count}`,
  ];
  const categories = Object.entries(summary.expenseByCategory || {}).filter(([, amt]) => amt > 0);
  if (categories.length) {
    lines.push('— รายจ่ายแยกหมวด —');
    for (const [key, amt] of categories) {
      lines.push(`${categoryLabel(key)}: ${baht(amt)} บาท`);
    }
  }
  if (summary.hoursWorked > 0) {
    lines.push(`⏱ เวลาทำงาน: ${formatHours(summary.hoursWorked)}`);
    lines.push(`⚡ รายได้เฉลี่ย: ${baht(summary.incomePerHour)} บาท/ชม.`);
  }
  if (summary.distanceKm > 0) {
    lines.push(`🛣 ระยะทาง: ${baht(summary.distanceKm)} กม.`);
    lines.push(`💵 เงินต่อกิโล: ${baht(summary.incomePerKm)} บาท/กม.`);
    if (summary.fuelPerKm > 0) {
      lines.push(`⛽ ค่าน้ำมันต่อกิโล: ${baht(summary.fuelPerKm)} บาท/กม.`);
    }
  }
  if (summary.diamonds > 0) {
    lines.push(`💎 เพชรสะสม: ${summary.diamonds} (ระดับสูงสุดที่ทำได้: ${summary.diamondLevel || 0})`);
  }
  return lines.join('\n');
}

function maybeOilWarning() {
  const vehicle = db.getVehicle();
  return oilChangeWarning(vehicle.currentOdometer, vehicle.lastOilChangeOdometer);
}

export function createBot(token, allowedChatId) {
  const bot = new Telegraf(token);

  // Registered before the access-control gate so it always works — otherwise there'd be
  // no way to discover your chat id in order to set ALLOWED_CHAT_ID in the first place.
  bot.command('whoami', (ctx) => ctx.reply(`chat id ของคุณคือ: ${ctx.chat.id}`));

  if (allowedChatId) {
    bot.use(async (ctx, next) => {
      if (String(ctx.chat?.id) !== String(allowedChatId)) {
        await ctx.reply('ไม่ได้รับอนุญาตให้ใช้บอทนี้ พิมพ์ /whoami เพื่อดู chat id ของคุณ');
        return;
      }
      return next();
    });
  }

  bot.start(async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status === 'open') {
      await ctx.reply('กำลังบันทึกของวันนี้อยู่ เลือกรายการได้เลย', recordingKeyboard);
    } else {
      await ctx.reply(
        'สวัสดี 👋 บอทจดบันทึกรายรับ-รายจ่ายรายวัน\nกดปุ่ม "เริ่มบันทึก" เพื่อเริ่มวันทำงาน',
        notStartedKeyboard
      );
    }
  });

  bot.hears('🚗 เริ่มบันทึก', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status === 'open') {
      await ctx.reply('กำลังบันทึกอยู่แล้ว เลือกรายการได้เลย', recordingKeyboard);
      return;
    }
    await db.setPendingType(date, 'start_odometer');
    await ctx.reply('พิมพ์เลขไมล์ปัจจุบัน (กม.) ก่อนเริ่มงาน เช่น 12345');
  });

  bot.hears('💰 รายได้', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้ กดปุ่ม "เริ่มบันทึก" ก่อน', notStartedKeyboard);
      return;
    }
    await db.setPendingType(date, 'income');
    await ctx.reply('พิมพ์จำนวนรายได้ เช่น 21\nถ้าได้เพชรจากออเดอร์นี้ด้วย ให้พิมพ์ "จำนวนเงิน เว้นวรรค จำนวนเพชร" เช่น 21 35');
  });

  bot.hears('💸 รายจ่าย', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้ กดปุ่ม "เริ่มบันทึก" ก่อน', notStartedKeyboard);
      return;
    }
    await ctx.reply('รายจ่ายนี้เป็นหมวดไหน?', categoryKeyboard);
  });

  bot.action('repair_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('ซ่อมบำรุงหมวดไหน?', repairMenuKeyboard).catch(() => {});
  });

  bot.action('expense_cat_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('รายจ่ายนี้เป็นหมวดไหน?', categoryKeyboard).catch(() => {});
  });

  bot.action(/^expense_cat_(fuel|food|other|oil_change|tire|repair_other)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const date = todayStr();
    const day = db.getDay(date);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้ กดปุ่ม "เริ่มบันทึก" ก่อน', notStartedKeyboard);
      return;
    }
    const category = ctx.match[1];
    await db.setPendingType(date, 'expense');
    await db.setPendingCategory(date, category);
    if (category === 'oil_change') {
      await ctx.reply('พิมพ์ "จำนวนเงิน เว้นวรรค เลขไมล์ตอนเปลี่ยน" เช่น 300 15000');
    } else {
      await ctx.reply(`พิมพ์จำนวนเงินค่า${categoryLabel(category).replace(/^\S+\s/, '')} (ตัวเลขเท่านั้น เช่น 50)`);
    }
  });

  bot.hears('🏁 จบการบันทึก', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้', notStartedKeyboard);
      return;
    }
    await db.setPendingType(date, 'end_odometer');
    await ctx.reply(
      'พิมพ์เลขไมล์ปัจจุบัน (กม.) เพื่อจบการบันทึกวันนี้\n(ถ้ายังไม่อยากจบ กดปุ่ม "รายได้"/"รายจ่าย" เพื่อบันทึกต่อได้เลย)'
    );
  });

  bot.hears('↩️ ลบรายการล่าสุด', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้', notStartedKeyboard);
      return;
    }
    const removed = await db.undoLastEntry(date);
    if (!removed) {
      await ctx.reply('ยังไม่มีรายการให้ลบวันนี้', recordingKeyboard);
      return;
    }
    const summary = db.getDaySummary(date);
    const label = removed.type === 'income' ? '💰 รายได้' : `💸 รายจ่าย${removed.category ? ` (${categoryLabel(removed.category)})` : ''}`;
    const diamondNote = removed.diamond > 0 ? ` (เพชร -${removed.diamond})` : '';
    await ctx.reply(
      `ลบรายการล่าสุดแล้ว: ${label} ${baht(removed.amount)} บาท${diamondNote} 🗑️\n\n` +
        `รวมวันนี้ — รายได้: ${baht(summary.income)} | รายจ่าย: ${baht(summary.expense)} | คงเหลือ: ${baht(summary.net)}`,
      recordingKeyboard
    );
  });

  bot.on('text', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    const text = ctx.message.text.trim();

    // Awaiting the starting odometer reading — the day isn't "open" yet at this point.
    if (day?.pendingType === 'start_odometer') {
      if (!AMOUNT_RE.test(text)) {
        await ctx.reply('กรุณาพิมพ์เลขไมล์เป็นตัวเลขเท่านั้น เช่น 12345');
        return;
      }
      const odometer = Number(text);

      // Odometer only increases: check against today's last close, or yesterday's if this
      // is the first session of the day — catches typos before they corrupt the distance.
      let reference = day.endOdometer != null ? { value: day.endOdometer, when: 'เมื่อครั้งก่อนของวันนี้' } : null;
      if (!reference) {
        const yesterday = db.getDay(addDays(date, -1));
        if (yesterday?.endOdometer != null) reference = { value: yesterday.endOdometer, when: 'เมื่อวาน' };
      }
      if (reference && odometer < reference.value) {
        await ctx.reply(
          `เลขไมล์เริ่มต้นต้องมากกว่าหรือเท่ากับเลขไมล์ตอนจบ${reference.when} (${baht(reference.value)} กม.) พิมพ์ใหม่อีกครั้ง`
        );
        return;
      }

      await db.startDay(date, odometer);
      const startWarning = maybeOilWarning();
      await ctx.reply(
        `เริ่มบันทึกวันที่ ${date} เวลา ${timeStr()} แล้ว ✅ (เลขไมล์เริ่มต้น ${baht(odometer)} กม.)\nเลือกรายการที่ต้องการบันทึก` +
          (startWarning ? `\n\n${startWarning}` : ''),
        recordingKeyboard
      );
      return;
    }

    if (day?.status !== 'open') {
      await ctx.reply('กดปุ่ม "เริ่มบันทึก" เพื่อเริ่มวันทำงานก่อนนะ', notStartedKeyboard);
      return;
    }

    // Awaiting the ending odometer reading — typing it is what actually closes the day.
    if (day.pendingType === 'end_odometer') {
      if (!AMOUNT_RE.test(text)) {
        await ctx.reply('กรุณาพิมพ์เลขไมล์เป็นตัวเลขเท่านั้น เช่น 12345');
        return;
      }
      const odometer = Number(text);
      if (day.startOdometer != null && odometer < day.startOdometer) {
        await ctx.reply(`เลขไมล์ต้องมากกว่าหรือเท่ากับเลขเริ่มต้น (${baht(day.startOdometer)} กม.) พิมพ์ใหม่อีกครั้ง`);
        return;
      }
      await db.endDay(date, odometer);
      const summary = db.getDaySummary(date);
      const endWarning = maybeOilWarning();
      await ctx.reply(
        `จบการบันทึกแล้ว 🎉\n\n${summaryText(summary)}` + (endWarning ? `\n\n${endWarning}` : ''),
        notStartedKeyboard
      );
      return;
    }

    if (!day.pendingType) {
      await ctx.reply('เลือกปุ่ม "รายได้" หรือ "รายจ่าย" ก่อนพิมพ์จำนวนเงิน', recordingKeyboard);
      return;
    }
    const type = day.pendingType;
    const category = type === 'expense' ? day.pendingCategory : null;
    let amount;
    let diamond = 0;
    let oilChangeOdometer = null;

    if (type === 'income') {
      const match = INCOME_RE.exec(text);
      if (!match) {
        await ctx.reply('กรุณาพิมพ์เป็นตัวเลข เช่น 21 หรือถ้ามีเพชรด้วยพิมพ์ "21 35"');
        return;
      }
      amount = Number(match[1]);
      diamond = match[2] ? Number(match[2]) : 0;
    } else if (category === 'oil_change') {
      const match = AMOUNT_ODOMETER_RE.exec(text);
      if (!match) {
        await ctx.reply('กรุณาพิมพ์ "จำนวนเงิน เว้นวรรค เลขไมล์ตอนเปลี่ยน" เช่น 300 15000');
        return;
      }
      amount = Number(match[1]);
      oilChangeOdometer = Number(match[2]);
    } else {
      if (!AMOUNT_RE.test(text)) {
        await ctx.reply('กรุณาพิมพ์เป็นตัวเลขเท่านั้น เช่น 21 หรือ 21.50');
        return;
      }
      amount = Number(text);
    }
    if (amount <= 0) {
      await ctx.reply('จำนวนเงินต้องมากกว่า 0');
      return;
    }

    await db.addEntry(date, type, amount, diamond, category);
    if (oilChangeOdometer != null) {
      await db.recordOilChange(date, oilChangeOdometer);
    }
    const summary = db.getDaySummary(date);
    const label = type === 'income' ? '💰 รายได้' : `💸 รายจ่าย${category ? ` (${categoryLabel(category)})` : ''}`;
    const diamondNote = diamond > 0 ? ` (เพชร +${diamond})` : '';
    const odometerNote = oilChangeOdometer != null ? ` (เลขไมล์ ${baht(oilChangeOdometer)} กม.)` : '';
    const lines = [
      `บันทึก ${label} ${baht(amount)} บาท${diamondNote}${odometerNote} เวลา ${timeStr()} ✅`,
      '',
      `รวมวันนี้ — รายได้: ${baht(summary.income)} | รายจ่าย: ${baht(summary.expense)} | คงเหลือ: ${baht(summary.net)}`,
    ];
    if (summary.diamonds > 0) {
      lines.push(diamondStatusText(summary.diamonds, date));
    }
    if (oilChangeOdometer != null) {
      lines.push('✅ บันทึกรอบเปลี่ยนน้ำมันเครื่องใหม่แล้ว จะเริ่มนับระยะทางใหม่จากตรงนี้');
    }
    await ctx.reply(lines.join('\n'), recordingKeyboard);
  });

  return bot;
}
