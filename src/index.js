import 'dotenv/config';
import { createBot } from './bot.js';
import { createServer } from './server.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ไม่พบ TELEGRAM_BOT_TOKEN — คัดลอก .env.example เป็น .env แล้วใส่ token');
  process.exit(1);
}

const bot = createBot(token, process.env.ALLOWED_CHAT_ID);
const port = Number(process.env.WEB_PORT) || 3000;

bot
  .launch()
  .then(() => console.log('✅ Telegram bot กำลังทำงาน (polling)'))
  .catch((err) => console.error('❌ เริ่มบอทไม่สำเร็จ ตรวจสอบ TELEGRAM_BOT_TOKEN:', err.message));

const app = createServer({ username: process.env.WEB_USERNAME, password: process.env.WEB_PASSWORD });
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ เว็บแดชบอร์ดรันที่ http://localhost:${port}`);
  if (!process.env.WEB_USERNAME || !process.env.WEB_PASSWORD) {
    console.warn('⚠️  ยังไม่ได้ตั้ง WEB_USERNAME/WEB_PASSWORD ใน .env — หน้าเว็บเปิดดูได้โดยไม่ต้องใส่รหัสผ่าน');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
