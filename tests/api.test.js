import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function makeD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url),'utf8'));
  function prepare(query) {
    const s = sql.prepare(query);
    function bound(params=[]) {
      return {
        bind(...next) { return bound(next); },
        first: async () => s.all(...params)[0] || null,
        all: async () => ({results: s.all(...params)}),
        run: async () => {const r=s.run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
      };
    }
    return bound();
  }
  return {prepare, batch: async statements => {
    sql.exec('BEGIN');
    try {const results=[];for (const stmt of statements) results.push(await stmt.run());sql.exec('COMMIT');return results;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }};
}
function req(path,method='GET',body=null,cookie=null) {
  return new Request(`https://example.com${path}`,{method,headers:{...(body?{'content-type':'application/json','origin':'https://example.com'}:{}),...(cookie?{'cookie':cookie}:{})},body:body?JSON.stringify(body):undefined});
}
test('administration: login, add employees, shared shifts, monthly roster, unprivileged blocking',async()=>{
  const env={DB:makeD1(),ADMIN_PASSWORD:'dev-password',SESSION_SECRET:'a-long-unique-string-that-is-only-for-testing',ASSETS:{fetch:async()=>new Response('asset')}};
  const forbidden=await worker.fetch(req('/api/roster?month=2026-11'),env);
  assert.equal(forbidden.status,401);
  const login=await worker.fetch(req('/api/login','POST',{password:'dev-password'}),env);
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const e1=await (await worker.fetch(req('/api/employees','POST',{name:'Іван'},cookie),env)).json();
  const e2=await (await worker.fetch(req('/api/employees','POST',{name:'Оля'},cookie),env)).json();
  assert.ok(e1.id>0 && e2.id>0);
  const shift={date:'2026-11-24',start:'08:00',end:'08:00',team:'Бригада 1',note:'',members:[e1.id,e2.id]};
  const saved=await worker.fetch(req('/api/shifts','POST',shift,cookie),env);
  assert.equal(saved.status,201);
  const roster=await (await worker.fetch(req('/api/roster?month=2026-11','GET',null,cookie),env)).json();
  assert.equal(roster.shifts.length,1);
  assert.deepEqual(roster.shifts[0].members.map(x=>x.name).sort(),['Іван','Оля']);
  assert.equal(roster.shifts[0].date,'2026-11-24');
  const badRequest=await worker.fetch(req('/api/shifts','POST',{...shift,date:'2026-02-30'},cookie),env);
  assert.equal(badRequest.status,400);
  const updated=await worker.fetch(req(`/api/employees/${e1.id}`,'PUT',{name:'Іван',phone:'050 123 45 67',active:true,reminders:true},cookie),env);
  assert.equal(updated.status,200);
  const phoneRoster=await (await worker.fetch(req('/api/roster?month=2026-11','GET',null,cookie),env)).json();
  assert.equal(phoneRoster.employees.find(e=>e.id===e1.id).phone,'+380501234567');
  const duplicate=await worker.fetch(req(`/api/employees/${e2.id}`,'PUT',{name:'Оля',phone:'+380501234567',active:true,reminders:true},cookie),env);
  assert.equal(duplicate.status,409);
  const not24h=await worker.fetch(req('/api/shifts','POST',{...shift,end:'12:00'},cookie),env);
  assert.equal(not24h.status,400);
  const december=await worker.fetch(req('/api/shifts','POST',{...shift,date:'2026-12-03'},cookie),env);
  assert.equal(december.status,201);
  const nextRoster=await (await worker.fetch(req('/api/roster?month=2026-12','GET',null,cookie),env)).json();
  assert.equal(nextRoster.shifts.length,1);
  assert.equal(nextRoster.shifts[0].date,'2026-12-03');
  const linked=await (await worker.fetch(req(`/api/employees/${e1.id}/code`,'POST',{},cookie),env)).json();
  assert.match(linked.code,/^[A-HJ-NP-Z2-9]{12}$/);
});

test('Telegram contact can link only its owner to an employee with a registered number', async () => {
  const env={DB:makeD1(),ADMIN_PASSWORD:'dev-password',SESSION_SECRET:'a-long-unique-string-that-is-only-for-testing',
    TELEGRAM_BOT_TOKEN:'fake_test_token',TELEGRAM_WEBHOOK_SECRET:'test-secret',ASSETS:{fetch:async()=>new Response('asset')}};
  const login=await worker.fetch(req('/api/login','POST',{password:'dev-password'}),env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const created=await (await worker.fetch(req('/api/employees','POST',{name:'Оксана',phone:'+380671234567'},cookie),env)).json();
  const sent=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async (url,opts)=>{
    sent.push({url:String(url),payload:JSON.parse(opts.body)});
    return new Response(JSON.stringify({ok:true,result:true}),{headers:{'content-type':'application/json'}});
  };
  try {
    const update=async (fromId, contactUserId)=>{
      const message={chat:{type:'private',id:fromId},from:{id:fromId},contact:{phone_number:'0671234567',user_id:contactUserId}};
      return worker.fetch(new Request('https://example.com/telegram/webhook',{
        method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':'test-secret'},
        body:JSON.stringify({message})
      }),env);
    };
    assert.equal((await update(7001,9999)).status,200);
    let roster=await (await worker.fetch(req('/api/roster?month=2026-11','GET',null,cookie),env)).json();
    assert.equal(roster.employees.find(e=>e.id===created.id).linked,false);
    assert.equal((await update(7001,7001)).status,200);
    roster=await (await worker.fetch(req('/api/roster?month=2026-11','GET',null,cookie),env)).json();
    assert.equal(roster.employees.find(e=>e.id===created.id).linked,true);
    assert.ok(sent.some(x=>x.payload.reply_markup?.remove_keyboard===true));
  } finally { globalThis.fetch=originalFetch; }
});
