import { isValidISODate, validMonth, addDays, kyivParts, prettyDate, parseBotDate, splitTelegramText, normalizePhone } from './utils.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
});
const fail = (error, status = 400) => json({ error }, status);

const textVal = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const validTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const enc = new TextEncoder();
const unsigned8 = value => new Uint8Array(value);
const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const unbase64Url = input => unsigned8(Uint8Array.from(atob(input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4)), c => c.charCodeAt(0)));
async function sha256(input) { return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input)))); }
async function macKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']); }
async function signSession(env) {
  const payload = base64Url(enc.encode(`v1:${Date.now() + 12 * 3600_000}`));
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(env.SESSION_SECRET), enc.encode(payload))));
  return `${payload}.${signature}`;
}
async function checkSession(request, env) {
  if (!env.SESSION_SECRET) return false;
  const c = request.headers.get('cookie') || '';
  const t = c.split(';').map(s => s.trim()).find(s => s.startsWith('shift_session='))?.slice(14);
  if (!t || t.length > 250 || t.split('.').length !== 2) return false;
  try {
    const [payload, sig] = t.split('.');
    const decoded = new TextDecoder().decode(unbase64Url(payload));
    if (!decoded.startsWith('v1:') || Number(decoded.slice(3)) < Date.now()) return false;
    return await crypto.subtle.verify('HMAC', await macKey(env.SESSION_SECRET), unbase64Url(sig), enc.encode(payload));
  } catch { return false; }
}
function cookie(value, clear = false) {
  return `shift_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; ${clear ? 'Max-Age=0' : 'Max-Age=43200'}`;
}
function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}
async function getBody(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('Потрібен JSON');
  if (Number(request.headers.get('content-length')) > 16_384) throw new Error('Завеликий запит');
  return request.json();
}
async function login(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return fail('Спочатку налаштуйте ADMIN_PASSWORD і SESSION_SECRET', 503);
  const key = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Math.floor(Date.now() / 1000);
  const f = await env.DB.prepare('SELECT failures,window_started FROM login_failures WHERE client_key=?').bind(key).first();
  if (f && f.failures >= 10 && now - f.window_started < 900) return fail('Забагато спроб. Спробуйте через 15 хвилин.', 429);
  const { password } = await getBody(request);
  const candidate = await sha256(String(password ?? ''));
  const expected = await sha256(env.ADMIN_PASSWORD);
  if (candidate !== expected) {
    await env.DB.prepare(`INSERT INTO login_failures(client_key,failures,window_started) VALUES(?,1,?)
      ON CONFLICT(client_key) DO UPDATE SET failures=CASE WHEN ? - window_started > 900 THEN 1 ELSE failures+1 END,
      window_started=CASE WHEN ? - window_started > 900 THEN ? ELSE window_started END`).bind(key, now, now, now, now).run();
    return fail('Невірний пароль', 401);
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE client_key=?').bind(key).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie(await signSession(env)) });
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
}
async function loadShifts(env, from, toExclusive) {
  const { results: rows } = await env.DB.prepare(`
    SELECT s.id, s.shift_date, s.starts_at, s.ends_at, s.team_name, s.comment,
           e.id AS employee_id, e.full_name, e.active, e.telegram_id, e.reminders_enabled
    FROM shifts s
    LEFT JOIN shift_members sm ON sm.shift_id=s.id
    LEFT JOIN employees e ON e.id=sm.employee_id
    WHERE s.shift_date>=? AND s.shift_date<?
    ORDER BY s.shift_date,s.starts_at,s.id,e.full_name
  `).bind(from, toExclusive).all();
  const shifts = [], byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      const shift = { id: row.id, date: row.shift_date, start: row.starts_at, end: row.ends_at, team: row.team_name, note: row.comment, members: [] };
      byId.set(row.id, shift); shifts.push(shift);
    }
    if (row.employee_id != null) byId.get(row.id).members.push({ id: row.employee_id, name: row.full_name, active: !!row.active, telegram_id: row.telegram_id, reminders_enabled: !!row.reminders_enabled });
  }
  return shifts;
}
async function roster(env, month) {
  if (!validMonth(month)) return fail('Некоректний місяць');
  const employees = (await env.DB.prepare('SELECT e.id,e.full_name,e.active,e.telegram_id,e.reminders_enabled,p.phone_e164 FROM employees e LEFT JOIN employee_phones p ON p.employee_id=e.id ORDER BY e.active DESC,e.full_name').all()).results;
  const shifts = await loadShifts(env, `${month}-01`, nextMonth(month));
  // Telegram chat IDs should never be exposed to the browser.
  return json({ employees: employees.map(e => ({ id:e.id,name:e.full_name,phone:e.phone_e164||'',active:!!e.active,linked:!!e.telegram_id,reminders:!!e.reminders_enabled })),
    shifts: shifts.map(s => ({ ...s, members: s.members.map(({id,name,active}) => ({id,name,active})) })) });
}
async function validateMemberIds(env, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(i => !Number.isSafeInteger(i) || i <= 0)) return null;
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) return null;
  const query = `SELECT id FROM employees WHERE active=1 AND id IN (${unique.map(() => '?').join(',')})`;
  const rows = (await env.DB.prepare(query).bind(...unique).all()).results;
  return rows.length === unique.length ? unique : null;
}
async function saveShift(request, env, id = null) {
  const b = await getBody(request);
  if (!isValidISODate(b.date) || !validTime(b.start)) return fail('Дата або час некоректні');
  if (b.end != null && b.end !== b.start) return fail('Підтримуються лише добові чергування: час завершення має дорівнювати часу початку наступного дня');
  const end = b.start; // 24-hour shifts only, crosses midnight to the following day
  const team = textVal(b.team, 60), note = textVal(b.note, 300);
  if (!team) return fail('Назва бригади обов’язкова');
  const memberIds = await validateMemberIds(env, b.members);
  if (!memberIds) return fail('Виберіть від 1 до 50 активних працівників');
  if (id !== null) {
    const present = await env.DB.prepare('SELECT id FROM shifts WHERE id=?').bind(id).first();
    if (!present) return fail('Зміну не знайдено', 404);
    const queries = [
      env.DB.prepare('UPDATE shifts SET shift_date=?,starts_at=?,ends_at=?,team_name=?,comment=? WHERE id=?').bind(b.date,b.start,end,team,note,id),
      env.DB.prepare('DELETE FROM shift_members WHERE shift_id=?').bind(id),
      ...memberIds.map(emp => env.DB.prepare('INSERT INTO shift_members(shift_id,employee_id) VALUES(?,?)').bind(id,emp))
    ];
    await env.DB.batch(queries);
    return json({ ok:true,id });
  }
  const result = await env.DB.prepare('INSERT INTO shifts(shift_date,starts_at,ends_at,team_name,comment) VALUES(?,?,?,?,?)')
    .bind(b.date,b.start,end,team,note).run();
  const newId = result.meta.last_row_id;
  await env.DB.batch(memberIds.map(emp => env.DB.prepare('INSERT INTO shift_members(shift_id,employee_id) VALUES(?,?)').bind(newId,emp)));
  return json({ ok:true,id:newId }, 201);
}
async function saveEmployee(request, env, id = null) {
  const b = await getBody(request);
  const name = textVal(b.name, 90);
  if (name.length < 2) return fail('Укажіть ПІБ працівника');
  const rawPhone = typeof b.phone === 'string' ? b.phone.trim() : '';
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return fail('Введіть український номер у форматі +380XXXXXXXXX');
  if (phone) {
    const duplicate = await env.DB.prepare('SELECT employee_id FROM employee_phones WHERE phone_e164=?').bind(phone).first();
    if (duplicate && duplicate.employee_id !== id) return fail('Цей номер телефону вже закріплено за іншим працівником',409);
  }
  if (id === null) {
    const res = await env.DB.prepare('INSERT INTO employees(full_name) VALUES(?)').bind(name).run();
    if (phone) await env.DB.prepare('INSERT INTO employee_phones(employee_id,phone_e164) VALUES(?,?)').bind(res.meta.last_row_id,phone).run();
    return json({ok:true,id:res.meta.last_row_id}, 201);
  }
  const result = await env.DB.prepare('UPDATE employees SET full_name=?,active=?,reminders_enabled=? WHERE id=?')
    .bind(name, b.active ? 1 : 0, b.reminders ? 1 : 0, id).run();
  if (!result.meta.changes) return fail('Працівника не знайдено',404);
  if (phone) {
    await env.DB.prepare(`INSERT INTO employee_phones(employee_id,phone_e164) VALUES(?,?)
      ON CONFLICT(employee_id) DO UPDATE SET phone_e164=excluded.phone_e164`).bind(id,phone).run();
  } else {
    await env.DB.prepare('DELETE FROM employee_phones WHERE employee_id=?').bind(id).run();
  }
  return json({ok:true});
}
async function createConnectCode(env, id) {
  const employee = await env.DB.prepare('SELECT active,full_name FROM employees WHERE id=?').bind(id).first();
  if (!employee || !employee.active) return fail('Працівник неактивний або не існує',404);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = crypto.getRandomValues(new Uint8Array(12));
  const code = [...random].map(i => alphabet[i % alphabet.length]).join('');
  await env.DB.prepare('UPDATE employees SET connect_code_hash=?,connect_code_expires=? WHERE id=?')
    .bind(await sha256(code), Math.floor(Date.now()/1000)+24*3600, id).run();
  return json({ code,expires_hours:24,name:employee.full_name });
}
async function telegramCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не налаштовано');
  const result = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload)
  });
  const value = await result.json().catch(() => ({ok:false,description:'Bad Telegram response'}));
  if (!result.ok || !value.ok) throw new Error(value.description || `Telegram ${result.status}`);
  return value.result;
}
async function say(env, chatId, message) {
  for (const chunk of splitTelegramText(message)) {
    await telegramCall(env, 'sendMessage', { chat_id:chatId, text:chunk, disable_web_page_preview:true });
  }
}
const shiftLine = s => `🕗 ${s.start}–${s.end}${s.end <= s.start ? ' (+1 день)' : ''} · ${s.team}\n👥 ${s.members.map(x=>x.name).join(', ')}${s.note ? `\n📝 ${s.note}` : ''}`;
async function handleBot(message, env) {
  if (message?.chat?.type !== 'private') return;
  const chatId = String(message.chat.id);
  // Telegram Contact: link only when the user explicitly shared THEIR own number.
  // Never trust a phone number merely typed in chat or another person's contact card.
  if (message.contact) {
    if (!message.from?.id || String(message.contact.user_id) !== String(message.from.id)
      || chatId !== String(message.from.id)) {
      return say(env,chatId,'⚠️ Надішли саме власний номер через кнопку Telegram «Поділитися номером».');
    }
    const phone = normalizePhone(message.contact.phone_number);
    if (!phone) return say(env,chatId,'⚠️ Потрібен український номер +380XXXXXXXXX. Якщо у тебе інший номер, попроси адміністратора видати код.');
    const employee = await env.DB.prepare(`SELECT e.id,e.full_name,e.telegram_id,e.active
      FROM employee_phones p JOIN employees e ON e.id=p.employee_id WHERE p.phone_e164=?`).bind(phone).first();
    if (!employee || !employee.active) return say(env,chatId,'❌ Цей номер не внесено до графіка. Звернись до адміністратора.');
    const current = await env.DB.prepare('SELECT id FROM employees WHERE telegram_id=?').bind(chatId).first();
    if ((current && current.id !== employee.id) || (employee.telegram_id && employee.telegram_id !== chatId)) {
      return say(env,chatId,'⚠️ Telegram уже прив’язаний до іншого профілю. Попроси адміністратора перевірити прив’язку.');
    }
    await env.DB.prepare('UPDATE employees SET telegram_id=?,connect_code_hash=NULL,connect_code_expires=NULL WHERE id=?').bind(chatId,employee.id).run();
    return telegramCall(env,'sendMessage',{chat_id:chatId,
      text:`✅ ${employee.full_name}, твій номер підтверджено через Telegram! Графік підключений.\n\nНапиши /my, щоб побачити свої чергування, або /my next — наступний місяць.`,
      reply_markup:{remove_keyboard:true}});
  }
  if (!message?.text) return;
  const content = message.text.trim();
  const [rawCmd, ...args] = content.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split('@')[0];
  const emp = await env.DB.prepare('SELECT id,full_name,active,reminders_enabled FROM employees WHERE telegram_id=?').bind(chatId).first();
  const help = 'Команди:\n/my — мої чергування цього місяця\n/my next — мої чергування наступного місяця\n/next — найближче чергування\n/month — загальний графік за місяць\n/month next — загальний графік наступного місяця\n/team 24.11 — хто чергує у вказаний день\n/tomorrow — хто чергує завтра\n/reminders on або off — нагадування';
  if (cmd === '/start' && args[0]) {
    const code = args[0].toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) return say(env,chatId,'❌ Неправильний код підключення.');
    const hash = await sha256(code);
    const candidate = await env.DB.prepare('SELECT id,full_name FROM employees WHERE connect_code_hash=? AND connect_code_expires>? AND active=1')
      .bind(hash,Math.floor(Date.now()/1000)).first();
    if (!candidate) return say(env,chatId,'❌ Код прострочений або невірний. Попроси адміністратора видати новий.');
    const existing = await env.DB.prepare('SELECT id FROM employees WHERE telegram_id=?').bind(chatId).first();
    if (existing && existing.id !== candidate.id) return say(env,chatId,'Цей Telegram уже підключений до іншого працівника. Звернись до адміністратора.');
    try {
      await env.DB.prepare('UPDATE employees SET telegram_id=?,connect_code_hash=NULL,connect_code_expires=NULL WHERE id=?').bind(chatId,candidate.id).run();
      return say(env,chatId,`✅ Привіт, ${candidate.full_name}! Твій графік підключено.\n\n${help}`);
    } catch { return say(env,chatId,'⚠️ Підключення не вдалося. Звернись до адміністратора.'); }
  }
  if (!emp || !emp.active) return telegramCall(env,'sendMessage',{
    chat_id:chatId,
    text:'👋 Привіт! Для прив’язки графіка натисни кнопку і поділися своїм номером. Номер має бути внесений адміністратором. Або введи /start КОД, якщо адміністратор видав код.',
    reply_markup:{keyboard:[[{text:'📱 Поділитися моїм номером',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true}
  });
  if (['/start','/help','меню'].includes(cmd)) return say(env,chatId,`Привіт, ${emp.full_name}!\n\n${help}`);
  const now = kyivParts();
  const thisMonth = now.date.slice(0,7);
  if (cmd === '/reminders') {
    if (!['on','off'].includes(args[0])) return say(env,chatId,`🔔 Нагадування: ${emp.reminders_enabled ? 'увімкнено' : 'вимкнено'}\nВведи /reminders on або /reminders off`);
    await env.DB.prepare('UPDATE employees SET reminders_enabled=? WHERE id=?').bind(args[0]==='on'?1:0,emp.id).run();
    return say(env,chatId,`🔔 Нагадування ${args[0]==='on' ? 'увімкнено' : 'вимкнено'}.`);
  }
  if (cmd === '/next') {
    const results = await loadShifts(env,now.date,addDays(now.date,120));
    const next = results.find(s=>s.members.some(e=>e.id===emp.id));
    return say(env,chatId,next ? `📌 Наступне чергування: ${prettyDate(next.date)}\n${shiftLine(next)}` : 'Найближчих чергувань не знайдено.');
  }
  if (cmd === '/my' || cmd === '/month') {
    const month = args[0]==='next' ? nextMonth(`${thisMonth}-01`).slice(0,7) : args[0] && validMonth(args[0]) ? args[0] : thisMonth;
    const results = await loadShifts(env,`${month}-01`,nextMonth(month));
    const subset = cmd === '/my' ? results.filter(s=>s.members.some(e=>e.id===emp.id)) : results;
    return say(env,chatId,`${cmd==='/my' ? '📅 Мої чергування' : '📅 Загальний графік'} · ${month}\n\n${subset.length ? subset.map(s=>`${prettyDate(s.date)}\n${shiftLine(s)}`).join('\n\n') : 'Змін немає.'}\n\n${cmd === '/month' ? 'Наступний місяць: /month next' : 'Наступний місяць: /my next'}`);
  }
  if (['/team','/today','/tomorrow'].includes(cmd)) {
    const date = cmd === '/tomorrow' ? addDays(now.date,1) : parseBotDate(args[0],now.date);
    if (!date) return say(env,chatId,'Формат дати: /team 24.11 або /team 2026-11-24');
    const shifts = await loadShifts(env,date,addDays(date,1));
    return say(env,chatId,`👥 Хто чергує ${prettyDate(date)}:\n\n${shifts.length ? shifts.map(shiftLine).join('\n\n') : 'Немає запланованих чергувань.'}`);
  }
  return say(env,chatId,`Не знаю такої команди.\n\n${help}`);
}
async function processWebhook(request, env) {
  const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || provided !== env.TELEGRAM_WEBHOOK_SECRET) return fail('Forbidden',403);
  const update = await getBody(request);
  // Telegram webhook retries unsuccessful requests. Keep processing short.
  if (update.message) await handleBot(update.message, env);
  return json({ok:true});
}
async function scheduleReminders(env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
  const now = kyivParts();
  // Hourly Cron in UTC; send from 18:00 through 22:59 Europe/Kyiv, DST-safe.
  if (now.hour < 18 || now.hour > 22) return;
  const tomorrow = addDays(now.date,1);
  const shifts = await loadShifts(env,tomorrow,addDays(tomorrow,1));
  const recipients = new Map();
  for (const shift of shifts) for (const emp of shift.members) {
    if (!emp.active || !emp.telegram_id || !emp.reminders_enabled) continue;
    if (!recipients.has(emp.id)) recipients.set(emp.id,{chat_id:emp.telegram_id,shifts:[]});
    recipients.get(emp.id).shifts.push(shift);
  }
  // Serial sends avoid outbound request bursts and database contention.
  for (const [id, r] of recipients) {
    const inserted = await env.DB.prepare('INSERT OR IGNORE INTO reminder_log(employee_id,shift_date,reminder_type) VALUES(?,?,?)').bind(id,tomorrow,'evening-before').run();
    if (!inserted.meta.changes) continue;
    try {
      await say(env,r.chat_id,`🔔 Нагадування: завтра, ${prettyDate(tomorrow)}, ти на роботі!\n\n${r.shifts.map(shiftLine).join('\n\n')}\n\nГарного чергування! 💪`);
    } catch (e) {
      console.error('Telegram reminder error for employee',id,String(e));
      await env.DB.prepare('DELETE FROM reminder_log WHERE employee_id=? AND shift_date=? AND reminder_type=?').bind(id,tomorrow,'evening-before').run();
    }
  }
}
async function adminApi(request, env, path) {
  const method = request.method;
  if (method === 'GET' && path === '/api/roster') {
    const month = new URL(request.url).searchParams.get('month') || kyivParts().date.slice(0,7);
    return roster(env,month);
  }
  if (method === 'POST' && path === '/api/employees') return saveEmployee(request,env);
  const employeeMatch = path.match(/^\/api\/employees\/(\d+)$/);
  if (employeeMatch && method === 'PUT') return saveEmployee(request,env,Number(employeeMatch[1]));
  if (employeeMatch && method === 'DELETE') {
    const result = await env.DB.prepare('UPDATE employees SET active=0,telegram_id=NULL,connect_code_hash=NULL,connect_code_expires=NULL WHERE id=?').bind(Number(employeeMatch[1])).run();
    return result.meta.changes ? json({ok:true}) : fail('Не знайдено',404);
  }
  const connectMatch = path.match(/^\/api\/employees\/(\d+)\/code$/);
  if (connectMatch && method === 'POST') return createConnectCode(env,Number(connectMatch[1]));
  const disconnectMatch = path.match(/^\/api\/employees\/(\d+)\/disconnect$/);
  if (disconnectMatch && method === 'POST') {
    const result = await env.DB.prepare('UPDATE employees SET telegram_id=NULL,connect_code_hash=NULL,connect_code_expires=NULL WHERE id=?').bind(Number(disconnectMatch[1])).run();
    return result.meta.changes ? json({ok:true}) : fail('Не знайдено',404);
  }
  if (path === '/api/shifts' && method === 'POST') return saveShift(request,env);
  const shiftMatch = path.match(/^\/api\/shifts\/(\d+)$/);
  if (shiftMatch && method === 'PUT') return saveShift(request,env,Number(shiftMatch[1]));
  if (shiftMatch && method === 'DELETE') {
    const r=await env.DB.prepare('DELETE FROM shifts WHERE id=?').bind(Number(shiftMatch[1])).run();
    return r.meta.changes ? json({ok:true}) : fail('Не знайдено',404);
  }
  if (path === '/api/webhook' && method === 'POST') {
    if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN) return fail('Налаштуйте TELEGRAM_BOT_TOKEN і TELEGRAM_WEBHOOK_SECRET',503);
    const address = `${new URL(request.url).origin}/telegram/webhook`;
    const result = await telegramCall(env,'setWebhook',{url:address,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message'],drop_pending_updates:false});
    return json({ok:!!result,address});
  }
  if (path === '/api/bot-status' && method === 'GET') {
    if (!env.TELEGRAM_BOT_TOKEN) return json({configured:false});
    try {
      const [bot, webhook] = await Promise.all([
        telegramCall(env,'getMe',{}),telegramCall(env,'getWebhookInfo',{})
      ]);
      return json({configured:true,bot_username:bot.username,webhook_url:webhook.url,pending:webhook.pending_update_count,webhook_error:webhook.last_error_message||null});
    } catch (e) { return fail(`Помилка Telegram: ${String(e.message).slice(0,180)}`,502); }
  }
  if (path === '/api/test-reminder' && method === 'POST') {
    const { id } = await getBody(request);
    const employee = await env.DB.prepare('SELECT telegram_id,full_name FROM employees WHERE id=? AND active=1').bind(id).first();
    if (!employee?.telegram_id) return fail('Працівник ще не підключив Telegram');
    await say(env,employee.telegram_id,'✅ Тестове повідомлення Lemvori Shift: Telegram підключено.');
    return json({ok:true});
  }
  return fail('Не знайдено',404);
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/telegram/webhook') {
        if (request.method !== 'POST') return fail('Method Not Allowed',405);
        return await processWebhook(request,env);
      }
      if (path.startsWith('/api/')) {
        if (!env.DB) return fail('D1 database binding DB відсутній',503);
        if (['POST','PUT','DELETE','PATCH'].includes(request.method) && !sameOrigin(request)) return fail('Неправильне джерело запиту',403);
        if (path === '/api/login' && request.method==='POST') return login(request,env);
        if (path === '/api/auth' && request.method==='GET') return json({authenticated:await checkSession(request,env)});
        if (path === '/api/logout' && request.method==='POST') return json({ok:true},200,{'set-cookie':cookie('',true)});
        if (!await checkSession(request,env)) return fail('Потрібна авторизація',401);
        return await adminApi(request,env,path);
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error('Worker error',String(e),e?.stack);
      return e instanceof SyntaxError ? fail('Некоректний JSON') : fail(e?.message === 'Потрібен JSON' || e?.message === 'Завеликий запит' ? e.message : 'Внутрішня помилка сервера',e?.message === 'Потрібен JSON' || e?.message === 'Завеликий запит' ? 400 : 500);
    }
  },
  async scheduled(_event,env,ctx) { ctx.waitUntil(scheduleReminders(env)); }
};