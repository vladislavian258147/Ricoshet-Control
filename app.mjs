import { BluetoothClient } from './bluetooth.mjs';
import { RoundClock } from './clock.mjs';
import { createDemoBluetooth } from './demo.mjs';
import { MODES, TEAM_NAMES, STATE_NAMES, FINISHED, formatClock, settingsDraft, settingsCommands, verifySettings, integer, humanError, durationOf, validateSnapshot } from './protocol.mjs';

const $ = id => document.getElementById(id);
const storage = {
  getItem(key) { try { return localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { localStorage.setItem(key,value); } catch {} },
  removeItem(key) { try { localStorage.removeItem(key); } catch {} },
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
const clock = new RoundClock(storage);
let snapshot = null, searchSnapshot = null, loaded = false, selected = 'CS', lastSync = 0, sourceName = '', sourceDemo = false;
let isDemo = false, saving = false, startPending = false, volumeDirty = false, draft = null, draftMode = null, noticeTimer;
const logs = [];

try {
  const cache = JSON.parse(storage.getItem('ricoshet:last') ?? 'null');
  if (cache) {
    snapshot = validateSnapshot(cache.snapshot); sourceName = String(cache.name ?? ''); sourceDemo = !!cache.demo;
    lastSync = Number(cache.at) || 0; selected = snapshot.MODE;
    clock.select(String(cache.device ?? ''));
    if (snapshot.MODE === 'CODES') searchSnapshot = snapshot;
  }
} catch { snapshot = null; }

function notify(message, kind = 'info') {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = message;
  $('notice').className = `notice ${kind}`;
  $('notice').setAttribute('role', kind === 'error' ? 'alert' : 'status');
  $('notice').hidden = false;
  if (kind === 'success') noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function log(direction, message) {
  const at = new Date().toLocaleTimeString('ru-RU', { hour12:false });
  logs.push(`${at} ${direction === 'tx' ? '→' : direction === 'rx' ? '←' : '·'} ${message}`);
  if (logs.length > 1000) logs.splice(0,logs.length-1000);
  if ($('log-details').open) renderLog();
}
function renderLog() {
  const node = $('log-content');
  const atBottom = node.scrollHeight-node.scrollTop-node.clientHeight < 40;
  node.textContent = logs.join('\n') || 'Здесь появятся команды и ответы устройства.';
  if (atBottom) node.scrollTop = node.scrollHeight;
}
const client = new BluetoothClient({
  onLog:log,
  onBusy:() => renderControls(),
  onState(kind, message) {
    if (kind === 'connected') {
      sourceName = message; sourceDemo = isDemo;
      clock.select(client.device.id || client.device.name || 'device');
    }
    if (kind !== 'connected') loaded = false;
    const pill = $('connection-pill');
    pill.className = `connection-pill ${kind === 'connected' ? 'online' : kind === 'connecting' ? 'connecting' : ''}`;
    pill.lastElementChild.textContent = kind === 'connected' ? (isDemo ? 'Демо' : 'На связи') : kind === 'connecting' ? 'Подключение' : 'Нет связи';
    $('device-name').textContent = kind === 'connecting' ? message : kind === 'connected' ? message : 'Подключи устройство';
    $('connection-description').textContent = kind === 'connecting' ? 'Разреши доступ к Bluetooth в браузере.' : kind === 'connected' ? 'Получаем полный статус устройства…' : 'Выбери BLE-модуль и получи настройки игры.';
    if (kind === 'disconnected' && message !== 'Отключено' && !client.connecting) notify(humanError(new Error(message)), 'error');
    render();
  },
  onSnapshot(value) {
    snapshot = value; loaded = true; lastSync = Date.now();
    if (value.MODE === 'CODES') searchSnapshot = value;
    clock.reconcile(value);
    storage.setItem('ricoshet:last', JSON.stringify({ snapshot:value, name:sourceName, at:lastSync, demo:sourceDemo, device:client.device?.id ?? '' }));
    $('connection-description').textContent = isDemo ? 'Виртуальный модуль готов к игре.' : 'Настройки получены · связь Bluetooth LE';
    if (!volumeDirty) $('volume').value = value.VOL;
    render();
  },
});

function canControl() { return client.connected && loaded && snapshot?.MODE === selected; }
function canConfigure() { return canControl() && !snapshot.BUSY && !startPending; }
function viewSettings() { return selected === 'CODES' && snapshot?.MODE !== 'CODES' ? searchSnapshot : snapshot; }

function renderControls() {
  const connected = client.connected, pending = client.connecting || client.busy || saving || startPending;
  $('connect').hidden = connected;
  $('connect').disabled = client.connecting;
  $('connect').querySelector('span').textContent = client.connecting ? 'Подключение…' : 'Подключиться';
  $('disconnect').hidden = !connected && !client.connecting;
  $('demo').hidden = connected || client.connecting;
  $('demo-banner').hidden = !(isDemo && connected);
  $('refresh').disabled = !connected || client.busy || saving;
  $('reset').disabled = !connected || !loaded || pending;
  $('select-mode').disabled = !connected || !loaded || pending;
  $('settings').disabled = !canConfigure() || pending;
  const emptyCodes = selected === 'CODES' && !snapshot?.FINDCOUNT;
  $('start').disabled = !canConfigure() || pending || emptyCodes;
  $('start').querySelector('span').textContent = startPending ? 'Отправляем старт…' : canControl() && snapshot.BUSY ? (snapshot.STARTIN ? 'Старт запланирован' : FINISHED.has(snapshot.STATE) ? 'Раунд завершён' : 'Раунд идёт') : emptyCodes && canControl() ? 'Сначала добавь коды' : 'Начать раунд';
  for (const id of ['start-delay','delay-minus','delay-plus']) $(id).disabled = !canConfigure() || pending;
  $('volume').disabled = !connected || !loaded || saving;
  $('save-volume').disabled = !connected || !loaded || client.busy || saving || !volumeDirty;
  $('volume-value').textContent = loaded || volumeDirty ? $('volume').value : snapshot ? snapshot.VOL : '—';
  if ($('settings-dialog').open) {
    const editable = canConfigure() && draftMode === selected;
    $('settings-fields').disabled = !editable || saving;
    $('save-settings').disabled = !editable || client.busy || saving;
    $('close-settings').disabled = saving;
    $('reload-draft').disabled = saving || !editable;
    $('add-code').disabled = saving || !editable || (draft?.codes?.length ?? 0) >= 32;
  }
}

function render() {
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === selected;
    button.setAttribute('aria-selected', active); button.tabIndex = active ? 0 : -1;
  });
  $('mode-panel').setAttribute('aria-labelledby', `tab-${selected}`);
  $('mode-name').textContent = MODES[selected];
  $('mode-kicker').textContent = `СЦЕНАРИЙ 0${['CS','DOM','CODES'].indexOf(selected)+1}`;
  const selectedOnDevice = snapshot?.MODE === selected;
  $('active-mode').textContent = !snapshot ? 'Режим не получен' : `${sourceDemo ? 'Демо · ' : ''}${!loaded ? 'Последний: ' : selectedOnDevice ? 'На устройстве: ' : 'Устройство: '}${MODES[snapshot.MODE]}`;
  $('active-mode').classList.toggle('active', loaded && selectedOnDevice);
  $('mode-switch').hidden = !snapshot || selectedOnDevice;
  $('mode-switch-text').textContent = loaded && snapshot?.BUSY ? 'Смена режима сбросит текущий раунд.' : 'Выбери этот режим, чтобы настроить и запустить игру.';
  $('select-mode').firstChild.textContent = loaded && snapshot?.BUSY ? 'Переключить и сбросить ' : 'Выбрать этот режим ';
  const s = viewSettings();
  const min = value => value == null ? '—' : `${Math.floor(value/60)} мин`;
  const sec = value => value == null ? '—' : `${value} с`;
  const rows = selected === 'CS'
    ? [['Раунд', min(s?.ROUND)], ['Взрыватель', sec(s?.FUSE)], ['Обезвреживание', sec(s?.DEFUSE)], ['С набором', sec(s?.KIT)], ['Код', s?.CODE ?? '—',true], ['Ввод кода', sec(s?.CODETIME)]]
    : selected === 'DOM'
    ? [['Команд', s?.TEAMS ?? '—'], ['Раунд', min(s?.DOMROUND)], ['Захват', sec(s?.CAPTURE)], ['Нейтрализация', sec(s?.NEUTRAL)]]
    : [['Команд', s?.FINDTEAMS ?? '—'], ['Раунд', min(s?.FINDROUND)], ['Кодов', s?.FINDCOUNT ?? '—'], ['Повтор кодов', !s ? '—' : s.FINDREUSE ? 'Разрешён' : 'Запрещён']];
  $('settings-summary').innerHTML = rows.map(([name,value,code]) => `<div><dt>${name}</dt><dd${code ? ' class="code-value"' : ''}>${escape(value)}</dd></div>`).join('');
  $('settings').querySelector('span').textContent = selected === 'CODES' ? 'Настройки и коды' : 'Настроить';
  $('settings-lock').textContent = !snapshot ? 'Настройки появятся после подключения.' : !loaded ? 'Показаны последние полученные настройки.' : !selectedOnDevice ? 'Сначала выбери этот режим на устройстве.' : snapshot.BUSY ? 'Для изменения настроек сбрось раунд.' : 'Изменения сохраняются на устройстве.';
  $('cs-section').hidden = selected !== 'CS';
  $('cs-state-name').textContent = !snapshot ? 'Ожидание подключения' : selectedOnDevice ? STATE_NAMES[snapshot.STATE] : 'Режим CS не выбран';
  $('cs-code').textContent = s?.CODE ?? '•••••••';
  $('cs-state-note').textContent = !loaded ? 'Состояние обновится после подключения.' : 'Ввод кода и обезвреживание — на игровом устройстве.';
  renderScores(); renderTimer(); renderControls(); renderLastSync();
}

function renderScores() {
  const active = snapshot?.MODE === selected;
  const s = active ? snapshot : viewSettings();
  $('score-section').hidden = selected === 'CS';
  $('score-unit').textContent = selected === 'DOM' ? 'Время удержания' : 'Баллы';
  const count = selected === 'DOM' ? (s?.TEAMS ?? 4) : (s?.FINDTEAMS ?? 4);
  const colors = ['#ef9a8e','#bcd889','#8ebbe5','#e3c876'];
  $('team-scores').innerHTML = TEAM_NAMES.slice(0,count).map((name,i) => {
    const winner = active && FINISHED.has(snapshot.STATE) && (snapshot.WINNERS & (1 << i));
    const score = !active ? '—' : selected === 'DOM' ? formatClock(snapshot[`SCORE${i+1}_MS`]/1000) : snapshot[`POINTS${i+1}`];
    return `<div class="team-score${winner ? ' leader' : ''}" style="--team:${colors[i]}"><span class="team-name"><i></i>${name}</span><strong>${score}</strong></div>`;
  }).join('');
  const winners = active && FINISHED.has(snapshot.STATE) ? TEAM_NAMES.slice(0,count).filter((_,i) => snapshot.WINNERS & (1 << i)) : [];
  $('winner').hidden = !winners.length;
  $('winner').textContent = winners.length === 1 ? `Победитель: ${winners[0]}` : `Ничья: ${winners.join(', ')}`;
  $('point-state').hidden = selected !== 'DOM' || !active;
  $('point-owner').textContent = snapshot?.DOMOWNER ? `Точка: ${TEAM_NAMES[snapshot.DOMOWNER-1]}` : 'Точка нейтральная';
  $('point-progress-label').textContent = snapshot?.DOMCONTESTED ? 'Спор · пауза' : snapshot?.DOMPROGRESS ? `${snapshot.DOMOWNER ? 'Нейтрализация' : 'Захват'} ${snapshot.DOMPROGRESS}%` : 'Ожидание захвата';
  $('point-progress').style.width = `${snapshot?.DOMPROGRESS ?? 0}%`;
  $('codes-used').hidden = selected !== 'CODES';
  $('codes-used').textContent = active ? `Разных кодов зачтено: ${snapshot.FINDUSED} из ${snapshot.FINDCOUNT}${!loaded ? ' · последние данные' : ''}` : 'Счёт появится после выбора режима на устройстве.';
  $('device-codes').hidden = selected !== 'CODES' || !s;
  $('device-code-count').textContent = s?.FINDCOUNT ?? 0;
  $('device-code-list').innerHTML = !s?.codes?.length ? '<p class="subnote" style="margin-top:15px">Список пуст. Добавь коды в настройках.</p>' : s.codes.map(c => `<div class="device-code"><span>${escape(c.code)}</span><span>${c.points} балл.</span><span aria-label="${c.used ? 'Зачтён' : 'Не зачтён'}">${c.used ? '✓' : '·'}</span></div>`).join('');
}

function renderTimer() {
  const s = snapshot, active = s?.MODE === selected;
  const local = clock.view(selected);
  const done = active && FINISHED.has(s.STATE);
  let seconds = null, label = 'ТАЙМЕР РАУНДА', state = !loaded ? 'Ожидание связи' : active ? STATE_NAMES[s.STATE] : 'Другой режим', note = '';
  let style = '';
  if (done) { seconds=0; note='Результат получен с устройства. Для новой игры сбрось раунд.'; }
  else if (local && active) {
    seconds=local.seconds;
    label=local.phase === 'delay' ? 'ДО НАЧАЛА РАУНДА' : 'ТАЙМЕР РАУНДА';
    style=local.phase === 'delay' ? 'delay' : 'running';
    state=local.phase === 'delay' ? 'Обратный отсчёт' : s.STATE === 'READY' ? 'Раунд идёт' : STATE_NAMES[s.STATE];
    note=!client.connected || !loaded ? 'Нет связи · локальный отсчёт телефона' : !local.confirmed ? 'Старт отправлен · ожидаем подтверждение' : selected === 'CS' ? 'Таймер телефона · состояние установки — ниже' : 'Таймер телефона · счёт обновляется с устройства';
  } else if (s && active && s.BUSY) {
    if (selected !== 'CS') seconds=s.REMAIN;
    note=selected === 'CS' ? 'Раунд уже идёт. Точное время старта неизвестно этому телефону.' : 'Последнее время, полученное с устройства.';
  } else {
    const settings=viewSettings();
    seconds=settings ? (selected === 'CS' ? settings.ROUND : selected === 'DOM' ? settings.DOMROUND : settings.FINDROUND) : null;
    note=!snapshot ? 'Подключись, чтобы получить параметры раунда.' : !active ? 'Сначала выбери этот режим на устройстве.' : !loaded ? 'Последние параметры · устройство не подключено' : 'Готов к запуску. Укажи задержку и начинай игру.';
  }
  $('timer-value').textContent=seconds == null ? '--:--' : formatClock(seconds);
  $('timer-value').className=`timer ${style}`;
  $('timer-label').textContent=label;
  $('timer-note').textContent=note;
  $('state-badge').textContent=state;
  const total=active && s ? durationOf(s) : 0;
  $('timer-progress').style.width=done ? '100%' : local?.phase === 'round' && total ? `${Math.max(0,Math.min(100,(1-seconds/total)*100))}%` : '0%';
}

function renderLastSync() {
  $('last-sync').textContent=!lastSync ? 'Ещё не подключались' : `${sourceDemo ? 'Демо · ' : ''}${!loaded ? 'Последнее: ' : 'Обновлено: '}${new Date(lastSync).toLocaleTimeString('ru-RU',{ hour12:false })}`;
}

async function connect(demo = false) {
  $('notice').hidden=true; isDemo=demo; loaded=false; volumeDirty=false; searchSnapshot=null;
  try {
    await client.connect(demo ? createDemoBluetooth() : undefined);
    if (demo) notify('Демо подключено. Можно настроить и запустить виртуальную игру.', 'success');
  } catch (error) { notify(humanError(error), 'error'); }
  render();
}
$('connect').addEventListener('click', () => connect(false));
$('demo').addEventListener('click', () => connect(true));
$('disconnect').addEventListener('click', () => { client.disconnect(); isDemo=false; render(); });
$('notice-close').addEventListener('click', () => { $('notice').hidden=true; });

async function action(fn, success) {
  $('notice').hidden=true;
  try { await fn(); if (success) notify(success,'success'); }
  catch (error) { notify(`${error.commandsAccepted ? 'Команды приняты, но состояние не подтверждено. ' : ''}${humanError(error)}`, 'error'); }
  render();
}
$('refresh').addEventListener('click', () => action(() => client.requestStatus(), 'Статус обновлён.'));
$('reset').addEventListener('click', () => action(() => client.batch(['RESET']), 'Раунд сброшен.'));
$('select-mode').addEventListener('click', () => action(() => client.batch([`MODE ${selected}`]), `Режим «${MODES[selected]}» выбран.`));
$('start').addEventListener('click', async () => {
  if (!canConfigure() || client.busy) return;
  let delay;
  try { delay=integer($('start-delay').value,0,3600,'Задержка старта, с'); }
  catch (error) { notify(error.message,'error'); return; }
  storage.setItem('ricoshet:delay', String(delay));
  const mode=selected, duration=durationOf(snapshot);
  startPending=true; renderControls();
  await action(async () => {
    try {
      await client.batch([`START ${delay}`], { onTransmitted(command, at) { if (command.startsWith('START ')) { clock.start(mode,delay,duration,at); renderTimer(); } } });
      clock.confirm();
    } catch (error) {
      if (error.commandsAccepted) clock.confirm();
      else if (error.message.startsWith('ERR ')) clock.clear();
      throw error;
    }
  });
  startPending=false; render();
});
const savedDelay=storage.getItem('ricoshet:delay');
if (snapshot) $('volume').value=snapshot.VOL;
if (savedDelay && /^[0-9]{1,4}$/.test(savedDelay) && Number(savedDelay)<=3600) $('start-delay').value=savedDelay;
for (const [id,delta] of [['delay-minus',-5],['delay-plus',5]]) $(id).addEventListener('click', () => { $('start-delay').value=String(Math.max(0,Math.min(3600,(Number($('start-delay').value)||0)+delta))); });

function selectTab(mode) { selected=mode; render(); }
document.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', () => selectTab(button.dataset.mode));
  button.addEventListener('keydown', event => {
    const modes=['CS','DOM','CODES'], i=modes.indexOf(selected);
    const next=event.key === 'ArrowRight' ? modes[(i+1)%3] : event.key === 'ArrowLeft' ? modes[(i+2)%3] : event.key === 'Home' ? modes[0] : event.key === 'End' ? modes[2] : null;
    if (next) { event.preventDefault(); selectTab(next); $(`tab-${next}`).focus(); }
  });
});
$('volume').addEventListener('input', () => { volumeDirty=true; renderControls(); });
$('save-volume').addEventListener('click', () => action(async () => { await client.batch([`VOL ${integer($('volume').value,0,30,'Громкость')}`]); volumeDirty=false; renderControls(); }, 'Громкость сохранена.'));

function draftKey() { return `ricoshet:draft:${client.device?.id ?? ''}:${draftMode}`; }
function persistDraft() { storage.setItem(draftKey(),JSON.stringify(draft)); }
function field(key,label,value,hint,wide = false,maxLength = 5) {
  return `<label class="form-field${wide ? ' wide' : ''}"><span>${label}</span><input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" data-field="${key}" value="${escape(value)}" maxlength="${maxLength}" aria-label="${label}"><small>${hint}</small></label>`;
}
function renderForm() {
  $('settings-mode').textContent=`НАСТРОЙКИ / ${MODES[draftMode].toUpperCase()}`;
  $('settings-title').textContent=draftMode === 'CODES' ? 'Поиск кодов' : draftMode === 'DOM' ? 'Захват точки' : 'Параметры CS';
  let html=field('minutes','Раунд, мин',draft.minutes,'1–360 минут');
  if (draftMode === 'CS') html+=field('FUSE','Взрыватель, с',draft.FUSE,'5–3600 секунд')+field('DEFUSE','Обезвреживание, с',draft.DEFUSE,'1–300 секунд')+field('KIT','С набором, с',draft.KIT,'1–300 секунд')+field('CODETIME','Ввод кода, с',draft.CODETIME,'1–30 секунд')+field('CODE','Код CS',draft.CODE,'1–8 цифр',false,8);
  else html+=field('teams','Количество команд',draft.teams,'2–4 команды');
  if (draftMode === 'DOM') html+=field('CAPTURE','Захват, с',draft.CAPTURE,'1–300 секунд')+field('NEUTRAL','Нейтрализация, с',draft.NEUTRAL,'1–300 секунд');
  $('settings-inputs').innerHTML=html;
  $('code-editor').hidden=draftMode !== 'CODES';
  if (draftMode === 'CODES') { $('reuse-codes').checked=draft.reuse; renderCodeEditor(); }
  $('form-error').hidden=true;
  $('save-progress').textContent='Изменения сохранятся на устройстве';
}
function renderCodeEditor() {
  $('code-count').textContent=`${draft.codes.length} / 32`;
  $('code-entries').innerHTML=draft.codes.map((c,i) => `<div class="code-entry"><div class="code-entry-header"><span>КОД ${String(i+1).padStart(2,'0')}</span><button type="button" class="text-button" data-remove="${i}" aria-label="Удалить код ${i+1}">Удалить</button></div><div class="form-grid">${field(`code:${i}`,'Код',c.code,'',false,7)}${field(`points:${i}`,'Баллы',c.points,'',false,4)}</div></div>`).join('');
  renderControls();
}
$('settings').addEventListener('click', () => {
  if (!canConfigure()) return;
  draftMode=selected; draft=settingsDraft(draftMode,snapshot);
  let restored=false;
  try {
    const cached=JSON.parse(storage.getItem(draftKey()) ?? 'null');
    if (cached && typeof cached.minutes === 'string' && (draftMode !== 'CODES' || Array.isArray(cached.codes) && cached.codes.length<=32 && cached.codes.every(c => typeof c?.code === 'string' && typeof c?.points === 'string'))) { draft=cached; restored=true; }
  } catch {}
  renderForm(); $('draft-notice').hidden=!restored;
  if (typeof $('settings-dialog').showModal === 'function') $('settings-dialog').showModal();
  else $('settings-dialog').setAttribute('open','');
  renderControls();
});
function closeSettings() { if (saving) return; if (typeof $('settings-dialog').close === 'function') $('settings-dialog').close(); else $('settings-dialog').removeAttribute('open'); $('settings').focus(); }
$('close-settings').addEventListener('click', closeSettings);
$('settings-dialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('reload-draft').addEventListener('click', () => { draft=settingsDraft(draftMode,snapshot); storage.removeItem(draftKey()); renderForm(); $('draft-notice').hidden=true; renderControls(); });
$('settings-form').addEventListener('input', event => {
  const key=event.target.dataset.field;
  if (!key) return;
  const value=event.target.value.replace(/[^0-9]/g,'');
  if (event.target.value !== value) event.target.value=value;
  if (key.startsWith('code:')) draft.codes[Number(key.split(':')[1])].code=value;
  else if (key.startsWith('points:')) draft.codes[Number(key.split(':')[1])].points=value;
  else draft[key]=value;
  persistDraft(); $('form-error').hidden=true;
});
$('reuse-codes').addEventListener('change', () => { draft.reuse=$('reuse-codes').checked; persistDraft(); });
$('add-code').addEventListener('click', () => {
  if (draft.codes.length>=32) return;
  draft.codes.push({ code:'',points:'1' }); persistDraft(); renderCodeEditor();
  document.querySelector(`[data-field="code:${draft.codes.length-1}"]`).focus();
});
$('code-entries').addEventListener('click', event => {
  const button=event.target.closest('[data-remove]'); if (!button) return;
  draft.codes.splice(Number(button.dataset.remove),1); persistDraft(); renderCodeEditor(); $('add-code').focus();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!canConfigure() || saving || client.busy || draftMode !== selected) return;
  let commands;
  try { commands=settingsCommands(draftMode,draft,snapshot); }
  catch (error) { $('form-error').textContent=error.message; $('form-error').hidden=false; return; }
  saving=true; $('form-error').hidden=true; renderControls();
  try {
    const actual=await client.batch(commands, { transaction:draftMode === 'CODES', onProgress(done,total) { $('save-progress').textContent=`Сохранение: ${done} / ${total}`; } });
    verifySettings(draftMode,draft,actual);
    storage.removeItem(draftKey()); saving=false; closeSettings(); notify('Настройки сохранены и проверены.', 'success');
  } catch (error) {
    $('form-error').textContent=`${error.commandsAccepted ? 'Команды приняты, но проверка не завершена. ' : ''}${humanError(error)} Черновик сохранён на телефоне.`;
    $('form-error').hidden=false;
    $('save-progress').textContent='Сохранение не подтверждено';
  } finally { saving=false; render(); }
});

async function copy(text, success) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const box=document.createElement('textarea'); box.value=text; box.style.position='fixed'; box.style.opacity='0'; document.body.append(box); box.select();
      const ok=document.execCommand('copy'); box.remove(); if (!ok) throw new Error('Копирование недоступно');
    }
    notify(success,'success');
  } catch { notify('Не удалось скопировать. Можно выделить текст вручную.', 'error'); }
}
$('copy-link').addEventListener('click', () => copy(location.origin+location.pathname,'Ссылка скопирована. Открой её в Bluefy.'));
$('copy-log').addEventListener('click', () => copy(logs.join('\n'),'Журнал скопирован.'));
$('clear-log').addEventListener('click', () => { logs.length=0; renderLog(); });
$('log-details').addEventListener('toggle', () => { if ($('log-details').open) renderLog(); });
$('compatibility').hidden=!!navigator.bluetooth;
if (!navigator.bluetooth) $('help').open=true;

async function poll() {
  if (!client.connected || client.busy || saving || startPending || document.visibilityState === 'hidden') return;
  try { await client.requestStatus(); } catch (error) { notify(humanError(error),'error'); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && client.connected) { loaded=false; render(); poll(); } });
setInterval(poll,3000);
setInterval(renderTimer,250);
render();
