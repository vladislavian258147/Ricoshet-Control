export const MODES = { CS: 'CS', DOM: 'Захват точки', CODES: 'Поиск кодов' };
export const TEAM_NAMES = ['Красная', 'Зелёная', 'Синяя', 'Жёлтая'];
export const STATE_NAMES = {
  READY: 'Готов к игре', PLANTING: 'Установка', ARMED: 'Заложена',
  DEFUSING: 'Обезвреживание', DEFUSED: 'Обезврежена', EXPLODED: 'Взрыв',
  ROUND_OVER: 'Раунд завершён', DOM_ACTIVE: 'Захват точки', DOM_FINISHED: 'Раунд завершён',
  FIND_ACTIVE: 'Поиск кодов', FIND_FINISHED: 'Раунд завершён',
};
export const FINISHED = new Set(['DEFUSED', 'EXPLODED', 'ROUND_OVER', 'DOM_FINISHED', 'FIND_FINISHED']);
export const BASE_KEYS = ['MODE','BUSY','STATE','ROUND','FUSE','DEFUSE','KIT','VOL','CODE','CODETIME',
  'DOMROUND','TEAMS','CAPTURE','NEUTRAL','DOMOWNER','DOMACTOR','DOMPROGRESS','DOMCONTESTED',
  'WINNERS','REMAIN','STARTIN','SCORE1_MS','SCORE2_MS','SCORE3_MS','SCORE4_MS'];
export const SEARCH_KEYS = ['FINDCOUNT','FINDTEAMS','FINDROUND','FINDUSED','POINTS1','POINTS2','POINTS3','POINTS4'];
const KNOWN = new Set([...BASE_KEYS, ...SEARCH_KEYS, 'FINDREUSE', 'CSARMED']);

export function integer(value, low, high, label) {
  const text = String(value ?? '');
  const n = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n) || n < low || n > high) {
    throw new Error(`${label}: от ${low} до ${high}`);
  }
  return n;
}

export function parseCode(value, index) {
  const p = value?.split(',') ?? [];
  if (p.length !== 3 || !/^[0-9]{3,7}$/.test(p[0]) || !/^[01]$/.test(p[2])) {
    throw new Error(`Некорректный FINDCODE${index}`);
  }
  return { code: p[0], points: integer(p[1], 1, 9999, `Баллы кода ${index}`), used: p[2] === '1' };
}

export function validateSnapshot(values) {
  const v = { ...values };
  const missing = BASE_KEYS.filter(k => !(k in v));
  if (missing.length) throw new Error(`Неполный STATUS: нет ${missing.join(', ')}`);
  if (!Object.hasOwn(MODES,v.MODE) || !Object.hasOwn(STATE_NAMES,v.STATE)) throw new Error('Некорректный режим или состояние в STATUS');
  if (!/^[0-9]{1,8}$/.test(v.CODE)) throw new Error('Некорректный CODE в STATUS');
  const ranges = {
    BUSY: [0,1], ROUND: [60,21600], FUSE: [5,3600], DEFUSE: [1,300], KIT: [1,300],
    VOL: [0,30], CODETIME: [1,30], DOMROUND: [60,21600], TEAMS: [2,4], CAPTURE: [1,300],
    NEUTRAL: [1,300], DOMOWNER: [0,4], DOMACTOR: [0,4], DOMPROGRESS: [0,100],
    DOMCONTESTED: [0,1], WINNERS: [0,15], REMAIN: [0,21600], STARTIN: [0,3600],
    SCORE1_MS: [0,4294967295], SCORE2_MS: [0,4294967295], SCORE3_MS: [0,4294967295], SCORE4_MS: [0,4294967295],
  };
  for (const [k, [lo, hi]] of Object.entries(ranges)) v[k] = integer(v[k], lo, hi, k);
  if ('CSARMED' in v) v.CSARMED = integer(v.CSARMED, 0, 1, 'CSARMED');
  v.codes = [];
  if (v.MODE === 'CODES') {
    const absent = SEARCH_KEYS.filter(k => !(k in v));
    if (absent.length) throw new Error(`Неполный STATUS: нет ${absent.join(', ')}`);
    v.FINDCOUNT = integer(v.FINDCOUNT, 0, 32, 'FINDCOUNT');
    v.FINDTEAMS = integer(v.FINDTEAMS, 2, 4, 'FINDTEAMS');
    v.FINDROUND = integer(v.FINDROUND, 60, 21600, 'FINDROUND');
    v.FINDUSED = integer(v.FINDUSED, 0, v.FINDCOUNT, 'FINDUSED');
    v.FINDREUSE = integer(v.FINDREUSE ?? '0', 0, 1, 'FINDREUSE');
    for (let i = 1; i <= 4; i++) v[`POINTS${i}`] = integer(v[`POINTS${i}`], 0, v.FINDREUSE ? 4294967295 : 319968, `POINTS${i}`);
    for (let i = 1; i <= v.FINDCOUNT; i++) v.codes.push(parseCode(v[`FINDCODE${i}`], i));
    if (new Set(v.codes.map(c => c.code)).size !== v.FINDCOUNT) throw new Error('Повторяющиеся коды в STATUS');
    if (v.codes.filter(c => c.used).length !== v.FINDUSED) throw new Error('Неполный STATUS: FINDUSED не совпадает со списком');
  }
  return v;
}

/** Полный снимок настроек; частично полученные значения не передаются в интерфейс. */
export class StatusCollector {
  constructor() { this.clear(); }
  clear() { this.values = {}; this.invalid = ''; }
  accept(line) {
    const eq = line.indexOf('=');
    if (eq < 1) return null;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'MODE') this.clear();
    if (!('MODE' in this.values) && key !== 'MODE') return null;
    if (key === 'ROUNDTIME' || key === 'REUSE') {
      this.invalid = 'Прошивка отправляет устаревшие имена STATUS. Необходима версия с полями ROUND, DOMROUND и FINDROUND.';
    }
    if (!KNOWN.has(key) && !/^FINDCODE(?:[1-9]|[12][0-9]|3[0-2])$/.test(key)) return null;
    if (key in this.values) this.invalid ||= `Повтор поля ${key} в STATUS`;
    this.values[key] = value;
    if (key !== 'SCORE4_MS') return null;
    if (this.invalid) throw new Error(this.invalid);
    return validateSnapshot(this.values);
  }
}

/** Уведомления могут содержать части строк или несколько строк с разделителями CR/LF. */
export class LineDecoder {
  constructor() { this.decoder = new TextDecoder(); this.buffer = ''; }
  push(bytes) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    const parts = this.buffer.split(/[\r\n]/);
    this.buffer = parts.pop();
    if (this.buffer.length > 8192) { this.buffer = ''; throw new Error('Переполнение буфера Bluetooth'); }
    return parts.map(s => s.trim()).filter(Boolean);
  }
}

export function searchCommands(draft) {
  const teams = integer(draft.teams, 2, 4, 'Число команд');
  const seconds = integer(draft.minutes, 1, 360, 'Раунд, мин') * 60;
  if (!Array.isArray(draft.codes) || draft.codes.length > 32) throw new Error('Не более 32 кодов');
  const seen = new Set();
  const entries = draft.codes.map((e, i) => {
    if (!/^[0-9]{3,7}$/.test(e.code)) throw new Error(`Код ${i + 1}: от 3 до 7 цифр`);
    if (seen.has(e.code)) throw new Error(`Код ${e.code} повторяется`);
    seen.add(e.code);
    return `FC ${i} ${e.code} ${integer(e.points, 1, 9999, `Баллы кода ${i + 1}`)}`;
  });
  return [`FINDCFG ${entries.length} ${teams} ${seconds}`, ...entries, draft.reuse ? 'FINDCOMMIT 1' : 'FINDCOMMIT'];
}

export function settingsDraft(mode, s) {
  const duration = mode === 'CS' ? s.ROUND : mode === 'DOM' ? s.DOMROUND : s.FINDROUND;
  const common = { minutes: String(Math.max(1, Math.floor((duration ?? 600) / 60))) };
  if (mode === 'CS') return { ...common, FUSE: String(s.FUSE), DEFUSE: String(s.DEFUSE), KIT: String(s.KIT), CODE: s.CODE, CODETIME: String(s.CODETIME), armed: Boolean(s.CSARMED) };
  if (mode === 'DOM') return { ...common, teams: String(s.TEAMS), CAPTURE: String(s.CAPTURE), NEUTRAL: String(s.NEUTRAL) };
  return { ...common, teams: String(s.FINDTEAMS ?? 2), reuse: Boolean(s.FINDREUSE), codes: (s.codes ?? []).map(c => ({ code: c.code, points: String(c.points) })) };
}

export function settingsCommands(mode, draft, s) {
  if (mode === 'CODES') return searchCommands(draft);
  const values = { [mode === 'CS' ? 'ROUND' : 'DOMROUND']: integer(draft.minutes, 1, 360, 'Раунд, мин') * 60 };
  if (mode === 'CS') {
    for (const [key, lo, hi, label] of [['FUSE',5,3600,'Взрыватель, с'], ['DEFUSE',1,300,'Обезвреживание, с'], ['KIT',1,300,'С набором, с'], ['CODETIME',1,30,'Ввод кода, с']]) values[key] = integer(draft[key], lo, hi, label);
    if (!/^[0-9]{1,8}$/.test(draft.CODE)) throw new Error('Код CS: от 1 до 8 цифр');
    values.CODE = draft.CODE;
    if (s.CSARMED != null) values.CSARMED = draft.armed ? 1 : 0;
    else if (draft.armed) throw new Error('Для старта с установленной бомбой необходимо обновить прошивку.');
  } else if (mode === 'DOM') {
    values.TEAMS = integer(draft.teams, 2, 4, 'Число команд');
    values.CAPTURE = integer(draft.CAPTURE, 1, 300, 'Захват, с');
    values.NEUTRAL = integer(draft.NEUTRAL, 1, 300, 'Нейтрализация, с');
  } else throw new Error('Неизвестный режим');
  return Object.entries(values).filter(([k, v]) => v !== s[k]).map(([k,v]) => `${k} ${v}`);
}

export function durationOf(s) { return s.MODE === 'CS' ? (s.CSARMED ? s.FUSE : s.ROUND) : s.MODE === 'DOM' ? s.DOMROUND : s.FINDROUND; }
export function verifySettings(mode, draft, snapshot) {
  if (snapshot.MODE !== mode) throw new Error('Устройство вернуло другой режим игры.');
  let equal;
  if (mode === 'CODES') {
    equal = snapshot.FINDTEAMS === Number(draft.teams) && snapshot.FINDROUND === Number(draft.minutes)*60 &&
      Boolean(snapshot.FINDREUSE) === Boolean(draft.reuse) && snapshot.codes.length === draft.codes.length &&
      snapshot.codes.every((c,i) => c.code === draft.codes[i].code && c.points === Number(draft.codes[i].points));
  } else equal = settingsCommands(mode,draft,snapshot).length === 0;
  if (!equal) throw new Error('Устройство вернуло другие настройки. Необходимо обновить статус и проверить значения.');
}
export function formatClock(seconds) {
  const n = Math.max(0, Math.ceil(seconds || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

export function humanError(error) {
  const text = error?.message ?? String(error);
  const errors = { 'ERR BUSY': 'Раунд уже идёт. Для продолжения необходимо сбросить раунд.', 'ERR MODE': 'Необходимо выбрать этот режим на устройстве.', 'ERR EMPTY': 'Необходимо добавить хотя бы один код.', 'ERR CODE': 'Устройство отклонило код.', 'ERR VALUE': 'Устройство отклонило значение.', 'ERR INCOMPLETE': 'Устройство получило не весь список кодов.', 'ERR CONFIG': 'Передача списка кодов прервана.', 'ERR COMMAND': 'Прошивка не распознала команду.' };
  if (errors[text]) return errors[text];
  if (error?.name === 'NotFoundError') return 'Устройство не выбрано. Можно подключиться ещё раз.';
  if (error?.name === 'NetworkError') return 'Связь Bluetooth прервана. Необходимо повторное подключение.';
  if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return 'Браузер не разрешил Bluetooth. Необходимо открыть панель в Bluefy и разрешить подключение.';
  return text;
}

