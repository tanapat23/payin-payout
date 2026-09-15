import { Telegraf, Markup } from 'telegraf';
import { todayStr, timeStr } from './dateUtils.js';
import * as db from './db.js';
import { diamondStatusText } from './diamonds.js';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
// Income can optionally carry a diamond count, space-separated: "21 35" = 21 baht, +35 diamonds.
const INCOME_RE = /^(\d+(?:\.\d{1,2})?)(?:\s+(\d+))?$/;

function baht(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const notStartedKeyboard = Markup.keyboard([['🚗 เริ่มบันทึก']]).resize();
const recordingKeyboard = Markup.keyboard([['💰 รายได้', '💸 รายจ่าย'], ['🏁 จบการบันทึก']]).resize();
const confirmStopKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback('✅ ยืนยันจบการบันทึก', 'confirm_stop'), Markup.button.callback('❌ ยกเลิก', 'cancel_stop')],
]);

function summaryText(summary) {
  const lines = [
    `📅 สรุปวันที่ ${summary.date}`,
    `💰 รายได้: ${baht(summary.income)} บาท`,
    `💸 รายจ่าย: ${baht(summary.expense)} บาท`,
    `📊 คงเหลือ: ${baht(summary.net)} บาท`,
    `🧾 จำนวนรายการ: ${summary.count}`,
  ];
  if (summary.diamonds > 0) {
    lines.push(`💎 เพชรสะสม: ${summary.diamonds} (ระดับสูงสุดที่ทำได้: ${summary.diamondLevel || 0})`);
  }
  return lines.join('\n');
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
    await db.startDay(date);
    await ctx.reply(`เริ่มบันทึกวันที่ ${date} เวลา ${timeStr()} แล้ว ✅\nเลือกรายการที่ต้องการบันทึก`, recordingKeyboard);
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
    await db.setPendingType(date, 'expense');
    await ctx.reply('พิมพ์จำนวนรายจ่าย (ตัวเลขเท่านั้น เช่น 50)');
  });

  bot.hears('🏁 จบการบันทึก', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    if (day?.status !== 'open') {
      await ctx.reply('ยังไม่ได้เริ่มบันทึกวันนี้', notStartedKeyboard);
      return;
    }
    await ctx.reply('ยืนยันจบการบันทึกของวันนี้ใช่หรือไม่?', confirmStopKeyboard);
  });

  bot.action('confirm_stop', async (ctx) => {
    await ctx.answerCbQuery();
    const date = todayStr();
    await db.endDay(date);
    const summary = db.getDaySummary(date);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply(`จบการบันทึกแล้ว 🎉\n\n${summaryText(summary)}`, notStartedKeyboard);
  });

  bot.action('cancel_stop', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    await ctx.reply('ยกเลิกแล้ว บันทึกต่อได้เลย', recordingKeyboard);
  });

  bot.on('text', async (ctx) => {
    const date = todayStr();
    const day = db.getDay(date);
    const text = ctx.message.text.trim();

    if (day?.status !== 'open') {
      await ctx.reply('กดปุ่ม "เริ่มบันทึก" เพื่อเริ่มวันทำงานก่อนนะ', notStartedKeyboard);
      return;
    }
    if (!day.pendingType) {
      await ctx.reply('เลือกปุ่ม "รายได้" หรือ "รายจ่าย" ก่อนพิมพ์จำนวนเงิน', recordingKeyboard);
      return;
    }
    const type = day.pendingType;
    let amount;
    let diamond = 0;

    if (type === 'income') {
      const match = INCOME_RE.exec(text);
      if (!match) {
        await ctx.reply('กรุณาพิมพ์เป็นตัวเลข เช่น 21 หรือถ้ามีเพชรด้วยพิมพ์ "21 35"');
        return;
      }
      amount = Number(match[1]);
      diamond = match[2] ? Number(match[2]) : 0;
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

    await db.addEntry(date, type, amount, diamond);
    const summary = db.getDaySummary(date);
    const label = type === 'income' ? '💰 รายได้' : '💸 รายจ่าย';
    const diamondNote = diamond > 0 ? ` (เพชร +${diamond})` : '';
    const lines = [
      `บันทึก ${label} ${baht(amount)} บาท${diamondNote} เวลา ${timeStr()} ✅`,
      '',
      `รวมวันนี้ — รายได้: ${baht(summary.income)} | รายจ่าย: ${baht(summary.expense)} | คงเหลือ: ${baht(summary.net)}`,
    ];
    if (summary.diamonds > 0) {
      lines.push(diamondStatusText(summary.diamonds, date));
    }
    await ctx.reply(lines.join('\n'), recordingKeyboard);
  });

  return bot;
}
