const RELAY_INTERVAL = 125;
const HEARTBEAT_INTERVAL = 4_000;
const WAIT_INTERVAL = 1_000;

/**
 * Host-authoritative room transport. D1 is the guaranteed relay; WebRTC upgrades
 * motion to an unordered channel and commands to an ordered reliable channel.
 * Commands are numbered and acknowledged across both transports, so an upgrade
 * or network change cannot silently lose a serve, restart, or pause.
 */
export class RoomConnection {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.closed = true;
    this.version = 0;
    this.status = "disconnected";
    this.room = null;
    this.token = null;
    this.timer = null;
    this.pc = null;
    this.fast = null;
    this.control = null;
    this.peerConnected = false;
    this.session = null;
    this.syncing = false;
    this.errors = 0;
    this.lastSuccess = 0;
    this.signal = null;
    this.signalDirty = false;
    this.remoteSignalId = null;
    this.offerId = null;
    this.rtcTask = false;
    this._resetMessages();
    this.pagehide = () => this.close();
  }

  async create() { return this._enter("create"); }
  async join(code) { return this._enter("join", String(code).trim().toUpperCase()); }

  async _enter(action, code) {
    this.close();
    this.closed = false;
    this.errors = 0;
    this.signal = null;
    this.signalDirty = false;
    this.remoteSignalId = null;
    this.offerId = null;
    this.session = null;
    this.peerConnected = false;
    this._resetMessages();
    const version = this.version;
    this._status("connecting");
    try {
      const result = await this._request({ action, code });
      if (this.closed || version !== this.version) {
        this._request({ action: "leave", code: result.room.code, token: result.token }).catch(() => {});
        return null;
      }
      this.room = result.room;
      this.token = result.token;
      this.lastSuccess = performance.now();
      this.callbacks.onRoom?.(this.room);
      if (typeof window !== "undefined") window.addEventListener("pagehide", this.pagehide);
      this._handleSync(result);
      if (this.room.role === "host") this._makeOffer();
      this._schedule(0);
      return this.room;
    } catch (error) {
      if (version !== this.version) return null;
      this.closed = true;
      this._status("disconnected");
      this.callbacks.onError?.(error);
      throw error;
    }
  }

  send(message) {
    if (this.closed || !this.room || !this.peerConnected || !message || typeof message !== "object") return;
    const motion = message.type === "input" || message.type === "state";
    if (!motion && !["serve", "restart", "pause"].includes(message.type)) return;
    // Clone here: the game mutates its state every frame.
    let data;
    try { data = JSON.parse(JSON.stringify(message)); } catch { return; }
    if (motion) {
      const packet = { kind: "realtime", session: this.session, seq: ++this.motionSeq, data };
      this.realtime = { seq: packet.seq, data };
      this._channelSend(this.fast, packet);
    } else {
      if (this.reliable.length >= 32) {
        this.callbacks.onError?.(new Error("连接繁忙，请等待操作同步后再试"));
        return;
      }
      const packet = { kind: "reliable", session: this.session, seq: ++this.commandSeq, data };
      this.reliable.push({ seq: packet.seq, data });
      this._channelSend(this.control, packet);
      this._schedule(0);
    }
  }

  close() {
    const room = this.room;
    const token = this.token;
    this.closed = true;
    this.version += 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.room = null;
    this.token = null;
    this.peerConnected = false;
    this.syncing = false;
    this._dropRtc();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.pagehide);
    if (room && token) {
      fetch("/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "leave", code: room.code, token }), keepalive: true,
      }).catch(() => {});
    }
    this._status("disconnected");
  }

  _resetMessages() {
    this.motionSeq = 0;
    this.commandSeq = 0;
    this.motionReceived = 0;
    this.commandReceived = 0;
    this.realtime = null;
    this.reliable = [];
    this.incomingCommands = new Map();
  }

  _status(value) {
    if (value === this.status) return;
    this.status = value;
    this.callbacks.onStatus?.(value);
  }

  async _request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || "连接失败，请重试");
        error.status = response.status;
        throw error;
      }
      return result;
    } finally { clearTimeout(timeout); }
  }

  _schedule(delay) {
    if (this.closed || !this.room) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._sync(), delay);
  }

  async _sync() {
    if (this.closed || !this.room) return;
    if (this.syncing) { this._schedule(50); return; }
    this.syncing = true;
    const version = this.version;
    const start = performance.now();
    const signal = this.signalDirty ? this.signal : undefined;
    const body = { action: "sync", code: this.room.code, token: this.token, signal };
    if (this.session) body.mailbox = {
      session: this.session,
      realtime: this.realtime,
      reliable: this.reliable,
      ack: this.commandReceived,
    };
    try {
      const result = await this._request(body);
      if (this.closed || version !== this.version) return;
      this.lastSuccess = performance.now();
      this.errors = 0;
      if (signal === this.signal) this.signalDirty = false;
      if (!this._rtcOpen()) this.callbacks.onLatency?.(Math.round(performance.now() - start));
      this._handleSync(result);
      if (this._rtcOpen()) this._channelSend(this.control, { kind: "ping", t: performance.now(), session: this.session });
    } catch (error) {
      if (this.closed || version !== this.version) return;
      this.errors += 1;
      if ([401, 403, 404, 410].includes(error.status)) {
        this.callbacks.onError?.(error);
        this.close();
        return;
      }
      if (performance.now() - this.lastSuccess > 12_000) this._status("connecting");
      if (this.errors === 3) this.callbacks.onError?.(new Error("网络不稳定，正在重新连接…"));
    } finally {
      if (version === this.version) {
        this.syncing = false;
        const interval = this.errors ? Math.min(4_000, 500 * this.errors) : this.peerConnected ? (this._rtcOpen() ? HEARTBEAT_INTERVAL : RELAY_INTERVAL) : WAIT_INTERVAL;
        this._schedule(Math.max(0, interval - (performance.now() - start)));
      }
    }
  }

  _handleSync(result) {
    const wasConnected = this.peerConnected;
    const previousSession = this.session;
    this.peerConnected = Boolean(result.peerConnected);
    this.session = result.session || null;
    if (previousSession !== this.session) {
      if (previousSession && this.session && this.room.role === "host") this._status("waiting");
      this._resetMessages();
    }
    if (!this.peerConnected) {
      this._status("waiting");
      if (wasConnected) this._dropRtc();
      if (previousSession && this.room.role === "host") this._makeOffer();
      return;
    }
    if (previousSession && previousSession !== this.session && this.room.role === "host") this._makeOffer();
    this._status("connected");
    this._consumeMailbox(result.mailbox);
    this._handleSignal(result.signal);
  }

  _consumeMailbox(mailbox) {
    if (!mailbox || mailbox.session !== this.session) return;
    if (Number.isSafeInteger(mailbox.ack)) this.reliable = this.reliable.filter((entry) => entry.seq > mailbox.ack);
    if (mailbox.realtime) this._receive({ kind: "realtime", session: mailbox.session, ...mailbox.realtime });
    for (const message of mailbox.reliable || []) this._receive({ kind: "reliable", session: mailbox.session, ...message });
  }

  _receive(packet) {
    if (!packet || packet.session !== this.session || this.closed) return;
    if (packet.kind === "ping") {
      this._channelSend(this.control, { kind: "pong", t: packet.t, session: this.session });
      return;
    }
    if (packet.kind === "pong") {
      this.callbacks.onLatency?.(Math.round(performance.now() - packet.t));
      return;
    }
    if (!Number.isSafeInteger(packet.seq) || packet.seq < 1) return;
    if (packet.kind === "ack") {
      this.reliable = this.reliable.filter((entry) => entry.seq > packet.seq);
      return;
    }
    if (packet.kind === "realtime") {
      if (packet.seq <= this.motionReceived) return;
      this.motionReceived = packet.seq;
      this.callbacks.onMessage?.(packet.data);
    } else if (packet.kind === "reliable") {
      if (packet.seq > this.commandReceived && packet.seq <= this.commandReceived + 32) this.incomingCommands.set(packet.seq, packet.data);
      while (this.incomingCommands.has(this.commandReceived + 1)) {
        const sequence = ++this.commandReceived;
        const data = this.incomingCommands.get(sequence);
        this.incomingCommands.delete(sequence);
        this.callbacks.onMessage?.(data);
      }
      this._channelSend(this.control, { kind: "ack", session: this.session, seq: this.commandReceived });
    }
  }

  _rtcOpen() { return this.pc?.connectionState === "connected" && this.fast?.readyState === "open" && this.control?.readyState === "open"; }

  _channelSend(channel, packet) {
    if (channel?.readyState !== "open" || channel.bufferedAmount > 65_536) return false;
    try { channel.send(JSON.stringify(packet)); return true; } catch { return false; }
  }

  _attachChannel(channel) {
    if (channel.label === "motion") this.fast = channel;
    else if (channel.label === "control") this.control = channel;
    else { channel.close(); return; }
    channel.onmessage = (event) => {
      if (typeof event.data !== "string" || event.data.length > 40_000) return;
      try { this._receive(JSON.parse(event.data)); } catch { /* Ignore malformed packets. */ }
    };
    channel.onopen = () => {
      if (channel.label === "control") for (const message of this.reliable) this._channelSend(channel, { kind: "reliable", session: this.session, ...message });
      this._schedule(0);
    };
    channel.onclose = () => this._schedule(0);
    channel.onerror = () => this._schedule(0);
  }

  _newRtc() {
    this._dropRtc();
    if (typeof RTCPeerConnection === "undefined") return null;
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ] });
    this.pc = pc;
    pc.ondatachannel = (event) => this._attachChannel(event.channel);
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) this._schedule(0);
    };
    return pc;
  }

  _dropRtc() {
    const pc = this.pc;
    this.pc = null;
    this.fast = null;
    this.control = null;
    this.rtcTask = false;
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.ondatachannel = null;
      pc.close();
    }
  }

  async _gatherIce(pc) {
    if (pc.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const timeout = setTimeout(finish, 3_000);
      function finish() { clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", check); resolve(); }
      function check() { if (pc.iceGatheringState === "complete") finish(); }
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  async _makeOffer() {
    if (this.closed || this.room?.role !== "host") return;
    try {
      const pc = this._newRtc();
      if (!pc) return;
      this.rtcTask = true;
      this.remoteSignalId = null;
      this.offerId = crypto.randomUUID();
      this._attachChannel(pc.createDataChannel("motion", { ordered: false, maxRetransmits: 0 }));
      this._attachChannel(pc.createDataChannel("control", { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      await this._gatherIce(pc);
      if (this.closed || pc !== this.pc) return;
      this.signal = { type: "offer", sdp: pc.localDescription.sdp, id: this.offerId };
      this.signalDirty = true;
      this.rtcTask = false;
      this._schedule(0);
    } catch { this.rtcTask = false; /* The HTTP relay remains active. */ }
  }

  async _handleSignal(signal) {
    if (!signal || this.closed || signal.id === this.remoteSignalId || this.rtcTask) return;
    if (this.room.role === "host") {
      if (signal.type !== "answer" || signal.id !== this.offerId || !this.pc || this.pc.remoteDescription) return;
      this.rtcTask = true;
      const pc = this.pc;
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        if (pc === this.pc) this.remoteSignalId = signal.id;
      } catch { /* The HTTP relay remains active. */ }
      finally { if (pc === this.pc) this.rtcTask = false; }
    } else {
      if (signal.type !== "offer") return;
      let pc;
      try {
        pc = this._newRtc();
        if (!pc) return;
        this.rtcTask = true;
        this.remoteSignalId = signal.id;
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await this._gatherIce(pc);
        if (this.closed || pc !== this.pc) return;
        this.signal = { type: "answer", sdp: pc.localDescription.sdp, id: signal.id };
        this.signalDirty = true;
        this._schedule(0);
      } catch { /* The HTTP relay remains active. */ }
      finally { if (pc === this.pc) this.rtcTask = false; }
    }
  }
}
