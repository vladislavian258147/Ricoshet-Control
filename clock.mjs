import { durationOf, FINISHED } from './protocol.mjs';

// Absolute deadlines survive a suspended browser tab and page reloads.
// They are estimates on the phone; STATE and scores always come from the prop.
export class RoundClock {
  constructor(storage, now = () => Date.now()) { this.storage = storage; this.now = now; this.device = ''; this.value = null; }
  select(device) {
    this.device = device;
    try { this.value = JSON.parse(this.storage?.getItem(`ricoshet:clock:${device}`) ?? 'null'); } catch { this.value = null; }
    const v = this.value;
    if (v && (!['CS','DOM','CODES'].includes(v.mode) || !Number.isFinite(v.start) || !Number.isFinite(v.end) || v.end < v.start || v.end - v.start > 21600000 || v.start > this.now() + 3600000 || this.now() - v.end > 86400000)) this.clear();
  }
  persist() { try { this.storage?.setItem(`ricoshet:clock:${this.device}`, JSON.stringify(this.value)); } catch {} }
  clear() { this.value = null; this.persist(); }
  start(mode, delay, seconds, sentAt = this.now()) {
    this.value = { mode, start: sentAt + delay * 1000, end: sentAt + (delay + seconds) * 1000, confirmed: false };
    this.persist();
  }
  confirm() { if (this.value) { this.value.confirmed = true; this.persist(); } }
  reconcile(s) {
    if (s.STATE === 'READY' && !s.BUSY && !s.STARTIN) { this.clear(); return; }
    if (FINISHED.has(s.STATE)) { this.clear(); return; }
    if (this.value?.mode !== s.MODE) this.clear();
    if (this.value) {
      const now=this.now();
      const active=s.STATE === 'DOM_ACTIVE' || s.STATE === 'FIND_ACTIVE';
      // No round id is available. A large disagreement can mean another phone
      // reset/started the prop while we were away; small STATUS delays never
      // shift a running local clock.
      const changedDelay=s.STARTIN > 0 && Math.abs((this.value.start-now)/1000-s.STARTIN)>5;
      const changedRound=active && !s.STARTIN && Math.abs(Math.max(0,(this.value.end-now)/1000)-s.REMAIN)>5;
      if (changedDelay || changedRound) this.clear();
      else { this.confirm(); return; }
    }
    if (s.STARTIN > 0) {
      this.start(s.MODE, s.STARTIN, durationOf(s)); this.confirm();
    } else if (s.STATE === 'DOM_ACTIVE' || s.STATE === 'FIND_ACTIVE') {
      this.start(s.MODE, 0, s.REMAIN); this.confirm();
    }
  }
  view(mode) {
    const v = this.value;
    if (!v || v.mode !== mode) return null;
    const now = this.now();
    return { phase: now < v.start ? 'delay' : 'round', seconds: Math.max(0, Math.ceil(((now < v.start ? v.start : v.end) - now) / 1000)), confirmed: v.confirmed };
  }
}
