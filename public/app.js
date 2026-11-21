const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const weekDays = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];
const monthNames = ['січень','лютий','березень','квітень','травень','червень','липень','серпень','вересень','жовтень','листопад','грудень'];
const state = { month: '', selectedDay: '', employees: [], shifts: [], botUsername: '' };
const KyivToday = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const pretty = d => `${d.slice(8,10)}.${d.slice(5,7)}.${d.slice(0,4)}`;
const fullDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('uk-UA',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
function monthAdd(month, delta) { const [y,m]=month.split('-').map(Number);const d=new Date(Date.UTC(y,m-1+delta,1));return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
let toastTimeout;
function toast(message, error=false) {
  const el = $('#toast');el.textContent=message;el.className=error?'show error':'show';
  clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.className='',4500);
}
async function api(path,{method='GET',body}={}) {
  const response = await fetch(path,{method,credentials:'same-origin',headers:body ? {'content-type':'application/json'} : {},body:body ? JSON.stringify(body) : undefined});
  const data = await response.json().catch(()=>({error:`Помилка HTTP ${response.status}`}));
  if (!response.ok) {
    if (response.status===401 && path!=='/api/login') showLogin();
    throw new Error(data.error||`Помилка ${response.status}`);
  }
  return data;
}
function showLogin() { $('#login-screen').hidden=false;$('#workspace').hidden=true; }
function showWorkspace() { $('#login-screen').hidden=true;$('#workspace').hidden=false; }
async function load() {
  const data = await api(`/api/roster?month=${encodeURIComponent(state.month)}`);
  state.employees=data.employees;state.shifts=data.shifts;
  renderAll();
}
function renderAll() {
  $('#stat-shifts').textContent=state.shifts.length;
  $('#stat-workers').textContent=state.employees.filter(e=>e.active).length;
  $('#stat-connected').textContent=state.employees.filter(e=>e.active&&e.linked).length;
  const [y,m]=state.month.split('-').map(Number);
  $('#month-label').textContent=`${monthNames[m-1][0].toUpperCase()}${monthNames[m-1].slice(1)} ${y}`;
  renderCalendar();renderDay();renderEmployees();
}
function renderCalendar() {
  const [y,m]=state.month.split('-').map(Number);
  const first = new Date(Date.UTC(y,m-1,1));
  const firstWeekday=(first.getUTCDay()+6)%7;
  const lastDay=new Date(Date.UTC(y,m,0)).getUTCDate();
  const totalCells=Math.ceil((firstWeekday+lastDay)/7)*7;
  let html=weekDays.map(w=>`<div class="weekday">${w}</div>`).join('');
  const today=KyivToday();
  for(let n=0;n<totalCells;n++){
    const d=new Date(Date.UTC(y,m-1,n-firstWeekday+1));
    const date=d.toISOString().slice(0,10);
    const outside=d.getUTCMonth()!==m-1;
    const events=state.shifts.filter(s=>s.date===date);
    const items=events.slice(0,2).map((s,i)=>`<span class="event-pill ${i%2?'alt':''}" title="${esc(`${s.start} ${s.team}: ${s.members.map(p=>p.name).join(', ')}`)}">${esc(s.start)} ${esc(s.team)}: ${esc(s.members.map(p=>p.name.split(' ')[0]).join(', '))}</span>`).join('');
    html+=`<button type="button" class="day-cell ${outside?'outside':''} ${date===today?'today':''} ${date===state.selectedDay?'selected':''}" data-day="${date}" aria-label="${esc(fullDate(date))}, ${events.length} змін"><span class="date-number">${d.getUTCDate()}</span>${items}${events.length>2?`<span class="more-shifts">+ ще ${events.length-2}</span>`:''}</button>`;
  }
  $('#calendar-grid').innerHTML=html;
}
function renderDay() {
  const shifts=state.shifts.filter(s=>s.date===state.selectedDay);
  $('#day-title').textContent=fullDate(state.selectedDay);
  $('#day-content').innerHTML=shifts.length ? shifts.map(s=>`<article class="shift-card"><div class="shift-card-head"><div><h3>${esc(s.team)}</h3><div class="timing">${esc(s.start)} — ${esc(s.end)}${s.end<=s.start?' (до наступного дня)':''}</div></div><div class="card-actions"><button class="text-btn" data-edit-shift="${s.id}">Змінити</button><button class="text-btn danger" data-delete-shift="${s.id}">Видалити</button></div></div><div class="person-pills">${s.members.map(m=>`<span class="person-pill">${esc(m.name)}</span>`).join('')}</div>${s.note?`<p>📝 ${esc(s.note)}</p>`:''}</article>`).join('') : '<div class="empty-state">На цей день чергувань поки немає. Натисни «Додати чергування», щоб запланувати команду.</div>';
}
function renderEmployees() {
  const query=($('#employee-search').value||'').toLowerCase().replace(/[\s().-]/g,'');
  const filtered=state.employees.filter(e=>!query || `${e.name} ${e.phone||''}`.toLowerCase().replace(/[\s().-]/g,'').includes(query));
  $('#employees-list').innerHTML=filtered.length ? filtered.map(e=>`<article class="employee-row ${e.active?'':'muted'}"><div class="employee-main"><div class="avatar">${esc(e.name.trim()[0]?.toUpperCase()||'?')}</div><div><strong>${esc(e.name)}</strong><small>${e.phone?'📱 '+esc(e.phone)+' · ':'Телефон не вказано · '}${e.active?'Активний':'Неактивний'} · ${e.linked?'✅ Telegram підключено':'○ Telegram ще не підключено'} · ${e.reminders?'🔔 Нагадування увімкнено':'🔕 Вимкнено'}</small></div></div><div class="employee-actions"><button class="btn secondary small-btn" data-edit-emp="${e.id}">Редагувати</button>${e.active?`<button class="btn secondary small-btn" data-code-emp="${e.id}">Код Telegram</button>`:''}${e.linked?`<button class="btn secondary small-btn" data-test-emp="${e.id}">Тест</button><button class="text-btn danger" data-disconnect-emp="${e.id}">Відв'язати</button>`:''}</div></article>`).join('') : '<div class="empty-state">Ще немає працівників. Додай хоча б одного, перш ніж створювати зміну.</div>';
}
function tab(name) {
  document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(el=>el.classList.toggle('active',el.id===`panel-${name}`));
  $('#page-title').textContent=({calendar:'Графік чергувань',employees:'Працівники',telegram:'Telegram-бот'})[name];
  $('#print').hidden=name!=='calendar';$('#add-shift').hidden=name!=='calendar';
  if(name==='telegram') loadBotStatus();
}
function shiftModal(id=null) {
  const shift=state.shifts.find(s=>s.id===id);
  $('#shift-form').reset();
  $('#shift-id').value=shift?.id??'';
  $('#shift-dialog-title').textContent=shift?'Редагувати зміну':'Нове чергування';
  $('#shift-date').value=shift?.date||state.selectedDay;
  $('#shift-team').value=shift?.team||'Зміна №1';
  $('#shift-start').value=shift?.start||'08:00';
  $('#shift-note').value=shift?.note||'';
  const assigned=new Set(shift?.members.map(p=>p.id)||[]);
  const active=state.employees.filter(e=>e.active || assigned.has(e.id));
  $('#shift-members').innerHTML=active.length ? active.map(p=>`<label><input type="checkbox" value="${p.id}" ${assigned.has(p.id)?'checked':''} ${p.active?'':'disabled'}/> <span>${esc(p.name)}${p.active?'':' (неактивний)'}</span></label>`).join('') : '<div class="empty-state">Спочатку додай працівників у розділі «Працівники».</div>';
  $('#shift-dialog').showModal();
}
function employeeModal(id=null) {
  const e=state.employees.find(p=>p.id===id);
  $('#employee-form').reset();
  $('#employee-id').value=e?.id??'';
  $('#employee-dialog-title').textContent=e?'Редагувати працівника':'Новий працівник';
  $('#employee-name').value=e?.name||'';
  $('#employee-phone').value=e?.phone||'';
  $('#employee-active').checked=e?.active??true;
  $('#employee-reminders').checked=e?.reminders??true;
  $('#employee-flags').hidden=!e;
  $('#employee-dialog').showModal();
}
async function loadBotStatus() {
  const status=$('#bot-status');status.textContent='Перевірка зв’язку...';
  try {
    const b=await api('/api/bot-status');
    if(!b.configured){status.textContent='Токен бота не налаштований у Cloudflare';return;}
    state.botUsername=b.bot_username||'';
    const expected=`${location.origin}/telegram/webhook`;
    status.textContent=`@${b.bot_username} · ${b.webhook_url===expected?'✅ Webhook активний':'⚠️ Потрібно підключити webhook'} · Черга: ${b.pending??0}${b.webhook_error?` · Помилка: ${b.webhook_error}`:''}`;
  }catch(e){status.textContent=e.message;}
}
async function action(fn) { try { await fn(); } catch(e) { toast(e.message,true); } }
function setMonth(next) {
  state.month=next;
  state.selectedDay=(KyivToday().startsWith(next)?KyivToday():`${next}-01`);
  action(load);
}
function attachEvents() {
  $('#login-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    $('#login-error').textContent='';
    try {await api('/api/login',{method:'POST',body:{password:$('#admin-password').value}});$('#admin-password').value='';showWorkspace();await load();}
    catch(err){$('#login-error').textContent=err.message;}
  });});
  $('#logout').addEventListener('click',()=>action(async()=>{await api('/api/logout',{method:'POST'});showLogin();}));
  document.querySelectorAll('[data-tab]').forEach(el=>el.addEventListener('click',()=>tab(el.dataset.tab)));
  $('#month-prev').addEventListener('click',()=>setMonth(monthAdd(state.month,-1)));
  $('#month-next').addEventListener('click',()=>setMonth(monthAdd(state.month,1)));
  $('#month-now').addEventListener('click',()=>setMonth(KyivToday().slice(0,7)));
  $('#calendar-grid').addEventListener('click',e=>{const day=e.target.closest('[data-day]')?.dataset.day;if(!day)return;if(day.slice(0,7)!==state.month){setMonth(day.slice(0,7));return;}state.selectedDay=day;renderCalendar();renderDay();});
  $('#add-shift').addEventListener('click',()=>shiftModal());
  $('#add-day-shift').addEventListener('click',()=>shiftModal());
  $('#add-worker').addEventListener('click',()=>employeeModal());
  $('#employee-search').addEventListener('input',renderEmployees);
  $('#print').addEventListener('click',()=>window.print());
  document.querySelectorAll('.close-modal').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $('#shift-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const id=Number($('#shift-id').value)||null;
    const payload={date:$('#shift-date').value,team:$('#shift-team').value,start:$('#shift-start').value,end:$('#shift-start').value,note:$('#shift-note').value,members:[...$('#shift-members').querySelectorAll('input:checked:not(:disabled)')].map(i=>Number(i.value))};
    await api(id?`/api/shifts/${id}`:'/api/shifts',{method:id?'PUT':'POST',body:payload});
    $('#shift-dialog').close();toast('✅ Зміну збережено');
    if(payload.date.slice(0,7)!==state.month)setMonth(payload.date.slice(0,7));else{state.selectedDay=payload.date;await load();}
  });});
  $('#employee-form').addEventListener('submit',e=>{e.preventDefault();action(async()=>{
    const id=Number($('#employee-id').value)||null;
    const payload={name:$('#employee-name').value,phone:$('#employee-phone').value,active:$('#employee-active').checked,reminders:$('#employee-reminders').checked};
    await api(id?`/api/employees/${id}`:'/api/employees',{method:id?'PUT':'POST',body:payload});
    $('#employee-dialog').close();toast('✅ Працівника збережено');await load();
  });});
  $('#day-content').addEventListener('click',e=>action(async()=>{
    const edit=e.target.closest('[data-edit-shift]');if(edit){shiftModal(Number(edit.dataset.editShift));return;}
    const del=e.target.closest('[data-delete-shift]');if(del&&confirm('Видалити це чергування для всіх учасників?')){await api(`/api/shifts/${del.dataset.deleteShift}`,{method:'DELETE'});toast('Зміну видалено');await load();}
  }));
  $('#employees-list').addEventListener('click',e=>action(async()=>{
    const edit=e.target.closest('[data-edit-emp]');if(edit){employeeModal(Number(edit.dataset.editEmp));return;}
    const code=e.target.closest('[data-code-emp]');if(code){
      const r=await api(`/api/employees/${code.dataset.codeEmp}/code`,{method:'POST'});
      $('#code-person').textContent=`Для працівника: ${r.name}`;$('#employee-code').textContent=r.code;
      $('#code-dialog').showModal();return;
    }
    const test=e.target.closest('[data-test-emp]');if(test){await api('/api/test-reminder',{method:'POST',body:{id:Number(test.dataset.testEmp)}});toast('✅ Тест надіслано');return;}
    const disconnect=e.target.closest('[data-disconnect-emp]');if(disconnect&&confirm('Відв’язати Telegram цього працівника?')){
      await api(`/api/employees/${disconnect.dataset.disconnectEmp}/disconnect`,{method:'POST'});toast('Telegram відв’язано');await load();
    }
  }));
  $('#copy-code').addEventListener('click',()=>action(async()=>{await navigator.clipboard.writeText(`/start ${$('#employee-code').textContent}`);toast('Команду скопійовано');}));
  $('#setup-webhook').addEventListener('click',()=>action(async()=>{const r=await api('/api/webhook',{method:'POST'});toast(`✅ Webhook підключено: ${r.address}`);await loadBotStatus();}));
}
async function boot() {
  state.month=KyivToday().slice(0,7);state.selectedDay=KyivToday();
  attachEvents();
  try{const r=await api('/api/auth');if(r.authenticated){showWorkspace();await load();}else showLogin();}
  catch(e){showLogin();$('#login-error').textContent=e.message;}
}
boot();