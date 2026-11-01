// WebRTC: a direct link between a party member and their party leader, so match traffic skips the server.
//
// The room's WebSocket (through the relay) stays: it's how the two find each other — the member sends an offer, the
// leader answers, each with its network addresses (found with Google's public STUN servers; there is no TURN relay).
// If they can't reach each other directly (some home routers, most mobile networks), the link just never opens and
// everything keeps going through the relay, exactly as before.
//
// Two channels once open: `fast` (unordered, no resends — a lost snapshot or input is replaced by the next one
// anyway) for match traffic, `rel` (ordered, reliable) for everything else.

export const STUN: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** messages that ride the fast channel: they're sent many times a second and each one replaces the last */
const FAST = new Set(['in', 'snap']);
/** how long a link may take to open before it's given up on (the relay carries on) */
export const LINK_TIMEOUT = 10_000;

export class PeerLink {
  private pc: RTCPeerConnection;
  private rel: RTCDataChannel | null = null;
  private fast: RTCDataChannel | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  closed = false;
  /** both channels are open: traffic goes direct */
  get open() { return this.rel?.readyState === 'open' && this.fast?.readyState === 'open'; }
  /** gave up (timed out, or the connection failed) */
  failed = false;

  /**
   * initiator: the member (it makes the offer). signal: send a {t:'rtc'} message to the other side through the relay.
   * onMsg: a message that came in directly. onChange: opened / failed / closed.
   */
  constructor(private initiator: boolean, private signalOut: (m: unknown) => void, private onMsg: (m: any) => void, private onChange: () => void) {
    this.pc = new RTCPeerConnection({ iceServers: STUN });
    this.pc.onconnectionstatechange = () => { const s = this.pc.connectionState; if (s === 'failed' || s === 'closed') this.fail(); };
    if (initiator) {
      this.wire(this.pc.createDataChannel('rel', { ordered: true }));
      this.wire(this.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    } else {
      this.pc.ondatachannel = (e) => this.wire(e.channel);
    }
    this.timer = setTimeout(() => { if (!this.open) this.fail(); }, LINK_TIMEOUT);
  }

  private wire(ch: RTCDataChannel) {
    if (ch.label === 'rel') this.rel = ch; else if (ch.label === 'fast') this.fast = ch; else return;
    ch.onopen = () => { if (this.open) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.onChange(); } };
    ch.onclose = () => { if (!this.closed) this.fail(); };
    ch.onmessage = (e) => { let m: unknown; try { m = JSON.parse(String(e.data)); } catch { return; } this.onMsg(m); };
  }

  /** wait for the address search to finish (or 2.5s), so one message carries the whole offer / answer */
  private gathered() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((res) => {
      const t = setTimeout(res, 2500);
      this.pc.addEventListener('icegatheringstatechange', () => { if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }

  /** the member starts it: an offer, through the relay */
  async start() {
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      await this.gathered();
      if (!this.closed) this.signalOut({ t: 'rtc', sdp: this.pc.localDescription });
    } catch { this.fail(); }
  }

  /** the other side's offer / answer arrived through the relay */
  async signal(m: any) {
    if (this.closed || !m?.sdp) return;
    try {
      await this.pc.setRemoteDescription(m.sdp);
      if (m.sdp.type === 'offer' && !this.initiator) {
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.gathered();
        if (!this.closed) this.signalOut({ t: 'rtc', sdp: this.pc.localDescription });
      }
    } catch { this.fail(); }
  }

  /** send directly if the link is open (true); otherwise the caller uses the relay */
  send(m: { t?: string }): boolean {
    if (!this.open) return false;
    const ch = FAST.has(m.t ?? '') ? this.fast! : this.rel!;
    try { ch.send(JSON.stringify(m)); return true; } catch { return false; }
  }

  private fail() {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.close();
    this.onChange();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    try { this.pc.close(); } catch { /* ignore */ }
  }
}
