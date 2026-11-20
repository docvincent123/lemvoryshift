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
  const linked=await (await worker.fetch(req(`/api/employees/${e1.id}/code`,'POST',{},cookie),env)).json();
  assert.match(linked.code,/^[A-HJ-NP-Z2-9]{12}$/);
});
