// Where a party goes, from whatever screen is up: open your party (ONLINE), join one, visit a room together (a quick
// match, a friend's party), come home, and carry on when the leader leaves (the next member takes the party over).
// The lobby shows the party; this is the plumbing between rooms. main.ts wires clientRoom.onParty / onLost here.
import type { App } from './app';
import { allBlades, findBlade } from '../core/blade';
import { settings } from '../core/settings';
import { joinAny } from '../net/transport';
import { parseJoinInput } from '../net/relay';
import { clientRoom, hostRoom } from '../net/room';
import { homePartyCode, party, type PartyHome, type RoomOpts } from '../net/party';
import { findMyRoom } from '../net/myRooms';

const PREF_KEY = 'bitblade.roomPrefs';
export type PartyPrefs = { name: string; open: boolean };
export function loadPartyPrefs(): PartyPrefs {
  const d: PartyPrefs = { name: '', open: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return d; }
}
export function savePartyPrefs(p: Partial<PartyPrefs>) { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPartyPrefs(), ...p })); } catch { /* ignore */ } }

/** the party ONLINE opens: your kept party (same code every time) if you have one, else a fresh private one */
export function myPartyOpts(): RoomOpts {
  const saved = homePartyCode() ? findMyRoom(homePartyCode()) : null;
  if (saved) return { name: saved.name, public: false, persistent: true, code: saved.code, key: saved.key, openControl: saved.openControl, password: saved.password ?? '' };
  const p = loadPartyPrefs();
  return { name: p.name, public: false, persistent: false, openControl: p.open };
}

/** ONLINE (main menu): back to the party you're in, or open yours */
export function goOnline(app: App) {
  if (clientRoom.t) { app.go('lobby', { guest: true }); return; }
  if (hostRoom.t) { app.go('lobby', { keep: true }); return; }
  app.go('lobby', { keep: true, online: true, room: myPartyOpts() });
}

function myBlade() { try { return findBlade(localStorage.getItem('bitblade.lastBlade') || ''); } catch { return allBlades()[0]; } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** answers that won't change by trying again */
const FINAL = new Set(['password', 'wrong password', 'blocked', 'removed']);

export const DENIED_TEXT: Record<string, string> = {
  password: 'This party needs a password',
  'wrong password': 'Wrong password',
  blocked: 'You can\'t join this party',
  removed: 'You were removed from this party',
};

/**
 * Join a party's room. `member`: it becomes your party (you leave the one you had). `visit`: your party is going
 * there together — a quick match, a friend's party — and stays your party. Retries while the room isn't open yet (a
 * matched room opening, a leader reopening the party) for up to `retryMs`. Returns '' once in, else why not.
 */
export async function joinParty(app: App, input: string, o: { as?: 'member' | 'visit'; retryMs?: number; alive?: () => boolean; onIn?: () => void } = {}): Promise<string> {
  let code: string;
  try { code = parseJoinInput(input).code; } catch (e) { return String((e as Error).message || e); }
  const as = o.as ?? 'member';
  if (as === 'member' && hostRoom.t?.code === code) { app.go('lobby', { keep: true }); return ''; } // (that's your own party)
  const until = performance.now() + (o.retryMs ?? 0);
  let last = '';
  for (;;) {
    if (o.alive && !o.alive()) return 'cancelled';
    try {
      const name = settings.playerName || 'Guest';
      const t = await joinAny(input, name);
      if (o.alive && !o.alive()) { t.close(); return 'cancelled'; }
      clientRoom.attach(t);
      const wait = clientRoom.waitAccepted(8000);
      clientRoom.send(party.hello(code, as === 'visit' && party.home ? party.home.code : code, { name, blade: myBlade() }));
      const r = await wait;
      if (r.ok) {
        o.onIn?.();
        // (the room you hosted closes — a moment later, so a 'travel' just sent to your party goes out first)
        const old = hostRoom.t;
        if (old) setTimeout(() => { if (hostRoom.t === old) hostRoom.close(); }, 400);
        if (as === 'member') party.home = { code, leader: false };
        clientRoom.remember(input.trim());
        app.go('lobby', { guest: true });
        return '';
      }
      clientRoom.leave();
      last = r.why;
      if (FINAL.has(r.why)) return r.why;
    } catch (e) { last = String((e as Error).message || e); }
    if (performance.now() >= until) return last;
    await sleep(1200);
  }
}

/** a leader back from a visit: reopen the party (same code, same settings) — the members come back to it */
function reopenHome(app: App, home: PartyHome) {
  app.go('lobby', { keep: true, online: true, room: home.opts ?? { name: '', public: false, persistent: false, code: home.code } });
}

/** leaving the room you're in, as a guest: a leader visiting with the party takes everyone home; anyone else leaves the party */
export function leaveRoom(app: App) {
  const home = party.home;
  if (home?.leader && party.away(clientRoom.t?.code)) {
    clientRoom.send({ t: 'home', party: home.code });
    setTimeout(() => { clientRoom.leave(); app.toast('Back to your party'); reopenHome(app, home); }, 200);
    return;
  }
  clientRoom.leave();
  party.home = null;
  app.toast('You left the party');
  app.go('menu');
}

/** a visit's leader in a match / results: what LEAVE does there (same as the lobby) */
export function leaveLabel() {
  return party.home?.leader && party.away(clientRoom.t?.code) ? 'Back to Your Party' : 'Leave Party';
}

/** party traffic, whatever screen is showing */
export function onPartyMsg(app: App, m: any) {
  if (m.t === 'travel' && typeof m.code === 'string') {
    // the leader's taking the party somewhere (a match, a friend's party): go too
    if (typeof m.pw === 'string' && m.pw) party.pw.set(m.code, m.pw);
    clientRoom.leave();
    app.toast(m.why === 'match' ? 'Match found — your party is heading there' : 'Your party is heading to another room');
    app.go('online', { match: m.code });
  } else if (m.t === 'gohome' && typeof m.code === 'string') {
    clientRoom.leave();
    app.toast('Back to your party');
    app.go('online', { rejoin: m.code, wait: 30 });
  } else if (m.t === 'promote') {
    const who = clientRoom.lobby?.members?.find((x: any) => x.peer === m.heir)?.name;
    app.toast(m.heir === clientRoom.myId ? 'You\'re the party leader now' : `${who ?? 'Someone'} leads the party now`);
  }
}

/** the room went away under a guest: home after a visit, the next member takes over, or wait for it to come back */
export function roomLost(app: App, why: string, code: string) {
  const snap = clientRoom.lobby;
  const home = party.home;
  if (why === 'removed' || why === 'blocked') {
    if (home?.code === code) party.home = null;
    app.toast(why === 'blocked' ? 'You were removed from the party' : DENIED_TEXT[why]);
    app.go('menu');
    return;
  }
  if (home && code !== home.code) {
    // a visit's room is gone: everyone home (the leader reopens the party, the others rejoin it)
    app.toast('That room closed — back to your party');
    if (home.leader) reopenHome(app, home);
    else app.go('online', { rejoin: home.code, wait: 30 });
    return;
  }
  if (why === 'Host left' && snap && !snap.persistent) {
    const heir = clientRoom.heir ?? snap.heir;
    if (heir === clientRoom.myId) { takeOver(app, snap, code); return; }
    const name = snap.members?.find((x: any) => x.peer === heir)?.name;
    app.toast(name ? `${snap.leader} left — ${name} leads the party now` : `${snap.leader} left the party`);
    if (heir === undefined || heir === null || heir < 0) { if (home?.code === code) party.home = null; app.go('menu'); return; }
    app.go('online', { rejoin: code, wait: 30 });
    return;
  }
  app.toast(why === 'Host left' ? `${snap?.leader ?? 'The leader'} left — waiting for the party to come back` : `Disconnected: ${why}`);
  app.go('online', { rejoin: code, wait: snap?.persistent ? 180 : 30 });
}

/** the leader left and I'm next: open the party again under its code, with its settings — the others rejoin */
function takeOver(app: App, snap: any, code: string) {
  const opts: RoomOpts = { name: snap.roomName ?? '', public: false, persistent: false, code, openControl: snap.control === 'all', password: clientRoom.partyPw };
  party.home = { code, leader: true, opts };
  app.toast('The leader left — you lead the party now');
  app.go('lobby', { keep: true, online: true, room: opts, takeover: snap });
}
