import { LineDecoder, StatusCollector } from './protocol.mjs?v=20261105-round2';

export const UUID = {
  service: '0000ffe0-0000-1000-8000-00805f9b34fb',
  notify: '0000ffe1-0000-1000-8000-00805f9b34fb',
  write: '0000ffe2-0000-1000-8000-00805f9b34fb',
};

export class BluetoothClient {
  constructor(callbacks = {}, timeouts = {}) {
    this.cb = callbacks;
    this.statusTimeout = timeouts.status ?? 5000;
    this.commandTimeout = timeouts.command ?? 5000;
    this.connected = false; this.connecting = false; this.epoch = 0;
    this.tail = Promise.resolve(); this.queued = 0; this.pending = null;
    this.lines = new LineDecoder(); this.statusPromise = null;
  }
  get busy() { return this.queued > 0; }
  log(direction, message) { this.cb.onLog?.(direction, message); }
  state(kind, message) { this.cb.onState?.(kind, message); }

  async connect(bluetooth = globalThis.navigator?.bluetooth) {
    if (!bluetooth?.requestDevice) throw new Error('Браузер не поддерживает Web Bluetooth. На iPhone необходимо использовать Bluefy.');
    if (this.connected || this.connecting) throw new Error('Подключение уже открыто');
    this.connecting = true;
    const epoch = ++this.epoch;
    this.state('connecting', 'Необходимо выбрать BLE-модуль');
    try {
      // Запрос устройства выполняется непосредственно из обработчика нажатия.
      const device = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [UUID.service] });
      this.checkEpoch(epoch);
      this.device = device;
      this.disconnectListener = () => { if (this.epoch === epoch) this.disconnect('Связь с устройством прервана'); };
      device.addEventListener('gattserverdisconnected', this.disconnectListener);
      this.state('connecting', 'Подключение к модулю…');
      const server = await device.gatt.connect();
      if (epoch !== this.epoch && this.device !== device) server.disconnect();
      this.checkEpoch(epoch);
      const service = await server.getPrimaryService(UUID.service);
      this.checkEpoch(epoch);
      this.reader = await service.getCharacteristic(UUID.notify);
      this.checkEpoch(epoch);
      this.writer = await service.getCharacteristic(UUID.write);
      this.checkEpoch(epoch);
      if (!this.reader.properties.notify && !this.reader.properties.indicate) throw new Error('FFE1 не поддерживает уведомления');
      const props = this.writer.properties;
      if (props.writeWithoutResponse && typeof this.writer.writeValueWithoutResponse === 'function') this.writeMethod = 'writeValueWithoutResponse';
      else if (props.write && typeof this.writer.writeValueWithResponse === 'function') this.writeMethod = 'writeValueWithResponse';
      else if ((props.write || props.writeWithoutResponse) && typeof this.writer.writeValue === 'function') this.writeMethod = 'writeValue';
      else throw new Error('FFE2 не поддерживает запись');
      this.lines = new LineDecoder();
      this.notifyListener = event => {
        if (epoch !== this.epoch) return;
        try {
          const value = event.target.value;
          for (const line of this.lines.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))) this.onLine(line);
        } catch (error) { this.disconnect(error.message); }
      };
      this.reader.addEventListener('characteristicvaluechanged', this.notifyListener);
      await this.reader.startNotifications();
      this.checkEpoch(epoch);
      this.connected = true; this.connecting = false;
      this.log('info', `${device.name || 'BLE-модуль'} · ${this.writeMethod}`);
      this.state('connected', device.name || 'BLE-модуль');
      await this.requestStatus();
      return device;
    } catch (error) {
      if (epoch === this.epoch) this.disconnect(error.message);
      throw error;
    }
  }

  checkEpoch(epoch) {
    if (epoch !== this.epoch) throw new Error('Подключение закрыто');
  }
  disconnect(reason = 'Отключено') {
    ++this.epoch;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    if (this.reader && this.notifyListener) this.reader.removeEventListener('characteristicvaluechanged', this.notifyListener);
    if (this.device && this.disconnectListener) this.device.removeEventListener('gattserverdisconnected', this.disconnectListener);
    const device = this.device;
    this.connected = false; this.connecting = false; this.reader = null; this.writer = null; this.device = null;
    this.statusPromise = null;
    if (device?.gatt?.connected) device.gatt.disconnect();
    this.state('disconnected', reason);
    this.log('info', reason);
  }

  enqueue(task) {
    if (!this.connected) return Promise.reject(new Error('Необходимо подключить устройство'));
    const epoch = this.epoch;
    this.queued++; this.cb.onBusy?.(true);
    const result = this.tail.then(async () => { this.checkEpoch(epoch); return task(epoch); });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.queued--; this.cb.onBusy?.(this.busy); });
  }

  requestStatus() {
    if (this.statusPromise) return this.statusPromise;
    const promise = this.enqueue(epoch => this.readStatus(epoch));
    this.statusPromise = promise;
    promise.finally(() => { if (this.statusPromise === promise) this.statusPromise = null; }).catch(() => {});
    return promise;
  }
  async readStatus(epoch) {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.checkEpoch(epoch);
      try {
        const snapshot = await this.exchange('STATUS', epoch);
        this.cb.onSnapshot?.(snapshot);
        return snapshot;
      } catch (error) {
        last = error;
        if (epoch !== this.epoch || error.fatal) throw error;
        this.log('info', `STATUS ${attempt}/3: ${error.message}`);
      }
    }
    const error = new Error(`Не удалось получить полный STATUS после 3 запросов: ${last?.message ?? 'нет ответа'}`);
    this.disconnect(error.message);
    throw error;
  }

  /** Пакет настроек выполняется целиком, без опросов между FINDCFG, FC и FINDCOMMIT. */
  batch(commands, { refresh = true, transaction = false, onProgress, onTransmitted } = {}) {
    if (!Array.isArray(commands) || commands.some(c => typeof c !== 'string' || !c || /[\r\n]/.test(c) || c.length > 37)) {
      return Promise.reject(new Error('Некорректная команда Bluetooth'));
    }
    return this.enqueue(async epoch => {
      let accepted = 0;
      try {
        for (const command of commands) {
          await this.exchange(command, epoch, onTransmitted);
          accepted++;
          onProgress?.(accepted, commands.length);
        }
      } catch (error) {
        if (this.connected && epoch === this.epoch) {
          if (transaction) { try { await this.exchange('FINDABORT', epoch); } catch {} }
          if (this.connected) { try { await this.readStatus(epoch); } catch {} }
        }
        error.accepted = accepted;
        throw error;
      }
      if (refresh) {
        try { return await this.readStatus(epoch); }
        catch (error) { error.commandsAccepted = true; throw error; }
      }
    });
  }

  exchange(command, epoch, onTransmitted) {
    this.checkEpoch(epoch);
    if (!this.connected || !this.writer) return Promise.reject(new Error('Связь Bluetooth закрыта'));
    if (this.pending) throw new Error('Предыдущая команда ещё не завершена');
    return new Promise((resolve, reject) => {
      const pending = { command, epoch, resolve, reject, writeDone: false, replyDone: false, reply: null, error: null,
        collector: command === 'STATUS' ? new StatusCollector() : null };
      this.pending = pending;
      pending.timer = setTimeout(() => {
        const error = new Error(pending.lastError || `Нет ответа на ${command.split(' ')[0]}`);
        // При потере ACK результат команды неизвестен; изменяющая команда не повторяется.
        error.fatal = command !== 'STATUS' || !pending.writeDone;
        if (error.fatal) error.message += '. Результат команды неизвестен. Необходимо повторно подключиться и обновить состояние.';
        this.finish(pending, error);
        if (error.fatal && epoch === this.epoch) this.disconnect(error.message);
      }, command === 'STATUS' ? this.statusTimeout : this.commandTimeout);
      this.log('tx', command);
      const bytes = new TextEncoder().encode(`${command}\r\n`);
      (async () => {
        try {
          for (let i = 0; i < bytes.length; i += 20) {
            this.checkEpoch(epoch);
            if (i === 0) onTransmitted?.(command, Date.now());
            await this.writer[this.writeMethod](bytes.slice(i, i + 20));
          }
          if (this.pending !== pending) return;
          pending.writeDone = true;
          if (pending.replyDone) this.finish(pending, pending.error, pending.reply);
        } catch (error) {
          error.fatal = true;
          this.finish(pending, error);
          if (epoch === this.epoch) this.disconnect(error.message);
        }
      })();
    });
  }

  finish(pending, error, value) {
    if (this.pending !== pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (error) pending.reject(error); else pending.resolve(value);
  }
  onLine(line) {
    this.log('rx', line);
    const p = this.pending;
    if (!p || p.epoch !== this.epoch || p.replyDone) return;
    if (p.collector) {
      if (line.startsWith('ERR ')) { p.lastError = line; return; }
      try {
        const snapshot = p.collector.accept(line);
        if (!snapshot) return;
        p.reply = snapshot;
      } catch (error) { p.error = error; }
      p.replyDone = true;
    } else {
      const name = p.command.split(' ')[0];
      const expected = name === 'START' ? 'ACK START' : `OK ${name}`;
      if (line.startsWith('ERR ')) p.error = new Error(line);
      else if (line !== expected) return;
      p.reply = line; p.replyDone = true;
    }
    // Ответ прошивки может поступить до завершения ATT-записи.
    if (p.writeDone) this.finish(p, p.error, p.reply);
  }
}

