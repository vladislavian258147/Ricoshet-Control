import { UUID } from './bluetooth.mjs?v=20261105-ui';
import { BASE_KEYS, SEARCH_KEYS } from './protocol.mjs?v=20261105-ui';

export function demoValues(mode = 'CS') {
  return { MODE:mode, BUSY:'0', STATE:'READY', ROUND:'300', FUSE:'40', DEFUSE:'10', KIT:'5', VOL:'20',
    CODE:'7355608', CODETIME:'4', DOMROUND:'600', TEAMS:'4', CAPTURE:'10', NEUTRAL:'4',
    DOMOWNER:'0', DOMACTOR:'0', DOMPROGRESS:'0', DOMCONTESTED:'0', WINNERS:'0', REMAIN:'600', STARTIN:'0',
    SCORE1_MS:'0', SCORE2_MS:'0', SCORE3_MS:'0', SCORE4_MS:'0', FINDCOUNT:'3', FINDTEAMS:'4', FINDROUND:'600',
    FINDUSED:'0', FINDREUSE:'0', POINTS1:'0', POINTS2:'0', POINTS3:'0', POINTS4:'0',
    FINDCODE1:'2244,1,0', FINDCODE2:'1234,5,0', FINDCODE3:'0012345,10,0' };
}
export function statusLines(v) {
  const keys = [...BASE_KEYS.slice(0,-1)];
  if (v.MODE === 'CODES') keys.push(...SEARCH_KEYS, 'FINDREUSE', ...Array.from({ length:Number(v.FINDCOUNT) }, (_,i) => `FINDCODE${i+1}`));
  keys.push('SCORE4_MS');
  return keys.map(k => `${k}=${v[k]}`).join('\r\n') + '\r\n';
}

/** Виртуальный BLE-модуль использует общий формат уведомлений и очередь команд. */
export function createDemoBluetooth() {
  let v = demoValues(), staged = null, starts = null, ends = null, incoming = '';
  class Characteristic extends EventTarget {
    constructor(properties) { super(); this.properties = properties; }
    async startNotifications() { return this; }
    emit(text) {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += 20) {
        this.value = new DataView(bytes.slice(i,i+20).buffer);
        this.dispatchEvent(new Event('characteristicvaluechanged'));
      }
    }
    async writeValueWithoutResponse(bytes) {
      incoming += new TextDecoder().decode(bytes);
      const lines = incoming.split(/[\r\n]/); incoming = lines.pop();
      for (const line of lines.filter(Boolean)) process(line);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const reader = new Characteristic({ notify:true });
  const writer = new Characteristic({ writeWithoutResponse:true });
  const reset = () => {
    starts = null; ends = null; v.BUSY = '0'; v.STATE = 'READY'; v.STARTIN = '0';
    v.REMAIN = v.MODE === 'DOM' ? v.DOMROUND : v.MODE === 'CODES' ? v.FINDROUND : v.ROUND;
    v.DOMOWNER = '0'; v.DOMPROGRESS = '0'; v.WINNERS = '0'; v.FINDUSED = '0';
    for (let i = 1; i <= 4; i++) { v[`SCORE${i}_MS`] = '0'; v[`POINTS${i}`] = '0'; }
    for (let i = 1; i <= Number(v.FINDCOUNT); i++) v[`FINDCODE${i}`] = v[`FINDCODE${i}`]?.replace(/,[01]$/, ',0');
  };
  function update() {
    if (starts == null) return;
    const now = Date.now();
    v.STARTIN = String(Math.max(0, Math.ceil((starts-now)/1000)));
    v.REMAIN = String(Math.max(0, Math.ceil((ends-Math.max(now,starts))/1000)));
    if (now < starts) return;
    v.STATE = now >= ends ? ({ CS:'ROUND_OVER', DOM:'DOM_FINISHED', CODES:'FIND_FINISHED' })[v.MODE] : ({ CS:'READY', DOM:'DOM_ACTIVE', CODES:'FIND_ACTIVE' })[v.MODE];
    if (v.MODE === 'DOM') { v.DOMOWNER = '1'; v.SCORE1_MS = String(Math.min(ends-starts, now-starts)); if (now >= ends) v.WINNERS = '1'; }
    if (v.MODE === 'CODES' && now >= ends) v.WINNERS = String((1 << Number(v.FINDTEAMS))-1);
  }
  function process(command) {
    update();
    const [name, ...args] = command.split(' ');
    let reply = `OK ${name}`;
    if (name === 'STATUS') { reader.emit(statusLines(v)); return; }
    if (name === 'MODE') { v.MODE = args[0]; reset(); }
    else if (name === 'RESET') reset();
    else if (name === 'FINDABORT') staged = null;
    else if (v.BUSY === '1' && name !== 'VOL') reply = 'ERR BUSY';
    else if (name === 'START') {
      if (v.MODE === 'CODES' && v.FINDCOUNT === '0') reply = 'ERR EMPTY';
      else { starts = Date.now() + Number(args[0])*1000; ends = starts + Number(v.MODE === 'CS' ? v.ROUND : v.MODE === 'DOM' ? v.DOMROUND : v.FINDROUND)*1000; v.BUSY = '1'; update(); reply = 'ACK START'; }
    } else if (name === 'FINDCFG') staged = { count:Number(args[0]), teams:args[1], seconds:args[2], codes:[] };
    else if (name === 'FC') { if (!staged) reply = 'ERR CONFIG'; else staged.codes[Number(args[0])] = `${args[1]},${args[2]},0`; }
    else if (name === 'FINDCOMMIT') {
      if (!staged || staged.codes.filter(Boolean).length !== staged.count) reply = 'ERR INCOMPLETE';
      else {
        for (let i=1;i<=32;i++) delete v[`FINDCODE${i}`];
        v.FINDCOUNT=String(staged.count); v.FINDTEAMS=staged.teams; v.FINDROUND=staged.seconds; v.FINDREUSE=args[0] === '1' ? '1':'0';
        staged.codes.forEach((c,i)=>{v[`FINDCODE${i+1}`]=c;}); staged=null; reset();
      }
    } else if (name in v) v[name] = args[0];
    else reply = 'ERR COMMAND';
    reader.emit(`${reply}\r\n`);
  }
  const device = new EventTarget();
  device.id = 'demo'; device.name = 'RICOSHET · демо';
  const service = { getCharacteristic: async uuid => uuid === UUID.notify ? reader : writer };
  device.gatt = {
    connected:false,
    async connect() { this.connected=true; return this; },
    async getPrimaryService() { return service; },
    disconnect() { this.connected=false; device.dispatchEvent(new Event('gattserverdisconnected')); },
  };
  return { requestDevice: async () => device };
}
