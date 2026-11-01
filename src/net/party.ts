// Parties. All online play is a party — of one or more: your party IS your online room. Its leader hosts it (the
// lobby shows it, with every room control: name, public / private, password, shared control, a code you keep), the
// others are in it as members. The party plays private games on its own, queues for QUICK MATCH, or visits a
// public room — and comes back home together afterwards.
//
// This module is just the bookkeeping that outlives screens and rooms: which party you belong to (`home`), how to
// reopen it when you lead it, passwords you've typed, this browser's id, and who you've blocked.
//
// Home vs away: you're HOME when the room you're in is your party's room (or you host it). You're AWAY when your
// party went to someone else's room (a quick match, a public room): the leader leaving that room brings everyone
// home — they reopen the party, the others are sent back to it.

/** how the lobby opens a party room: its name, listing, the code you keep, password, shared control */
export interface RoomOpts { name: string; public: boolean; persistent: boolean; code?: string; key?: string; openControl?: boolean; password?: string;
  /** a quick match's own room (not a party): its players' parties go home after it */
  match?: boolean }

/** the party you belong to: its code, whether you lead it, and (leader) how to reopen it after a visit */
export interface PartyHome { code: string; leader: boolean; opts?: RoomOpts }

const DEV_KEY = 'bitblade.deviceId';
const PUB_KEY = 'bitblade.publicId';
const BLOCK_KEY = 'bitblade.blocked';

export interface Blocked { id: string; name: string; at: number }

class Party {
  home: PartyHome | null = null;
  /** passwords you've typed, by party code (sent with every hello to that party, so rejoining just works) */
  pw = new Map<string, string>();
  private ids: Record<string, string> = {};

  /** a random id kept forever in this browser */
  private id(key: string) {
    if (this.ids[key]) return this.ids[key];
    let v = '';
    try { v = localStorage.getItem(key) || ''; } catch { /* ignore */ }
    if (!v) {
      v = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
      try { localStorage.setItem(key, v); } catch { /* ignore */ }
    }
    return (this.ids[key] = v);
  }
  /** this browser, as the server knows it (admin bans / whitelist) — only ever sent to the server, never to players */
  get deviceId() { return this.id(DEV_KEY); }
  /** this browser, as party leaders see it (their BLOCK list) — a different id, so it can't be used to pose as you */
  get publicId() { return this.id(PUB_KEY); }

  /** in someone else's room with your party (a match, a public room) — not in your party's own room */
  away(roomCode: string | undefined | null) { return !!this.home && !!roomCode && roomCode !== this.home.code; }

  /** what you send arriving in room `code` (and again when your name changes): `partyCode` is the party you belong to */
  hello(code: string, partyCode: string, extra: Record<string, unknown> = {}) {
    return { t: 'hello', dev: this.publicId, party: partyCode, pw: this.pw.get(code) || undefined, ...extra };
  }

  // ---- blocking (each leader's own list, on this browser)
  blocked(): Blocked[] { try { const v = JSON.parse(localStorage.getItem(BLOCK_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  isBlocked(id: string | undefined) { return !!id && this.blocked().some((b) => b.id === id); }
  block(id: string, name: string) { if (!id || this.isBlocked(id)) return; this.saveBlocked([...this.blocked(), { id, name, at: Date.now() }]); }
  unblock(id: string) { this.saveBlocked(this.blocked().filter((b) => b.id !== id)); }
  private saveBlocked(v: Blocked[]) { try { localStorage.setItem(BLOCK_KEY, JSON.stringify(v.slice(-200))); } catch { /* ignore */ } }
}

export const party = new Party();

/** the party you open from ONLINE: your home party (a kept code) if you have one, else a fresh private one */
const HOME_KEY = 'bitblade.homeParty';
export function homePartyCode(): string { try { return localStorage.getItem(HOME_KEY) || ''; } catch { return ''; } }
export function setHomePartyCode(code: string) { try { if (code) localStorage.setItem(HOME_KEY, code); else localStorage.removeItem(HOME_KEY); } catch { /* ignore */ } }
