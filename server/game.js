// 🏟️ Buckets game server: the SERVER runs every online game (not a player's iPad).
// Every iPad is just a player: one trip to the server and back, the same for red and blue.
// The rules/physics/bots are the game's own code (sim.js is built from index.html by build.mjs).
//
// GameRoom (one per room code):  /g/<CODE>   messages are the same ones a host iPad used to send,
//   so the game on the iPads barely changes: welcome, roster, s (snapshot), ev, pong, migrate...
// Matchmaker (one for everyone):  /mm        ranked 1v1 queue, 2v2 queue, team-up duo search.
import { makeSim } from './sim.js';
const S = makeSim();
const TICK_MS = 1000 / 60;                 // 60 updates a second = one game step each (smoothest, smallest buffer)                 // 50 updates a second to every player (less waiting, smaller buffer on iPads)
const GRACE_MS = 15000;
// 💸 Cloudflare bills every second a room has players connected, so rooms don't sit open doing nothing:
const RESULTS_STEP_MS = 6000;               // ranked/queue games: stop simulating this long after the final buzzer
const RESULTS_CLOSE_MS = 25000;             // ...and hang up here (the iPad keeps showing the results; it already has them)
const LOBBY_IDLE_MS = 4 * 60000;            // a private lobby with no game and nobody doing anything for 4 minutes closes
const SILENT_MS = 40000;                    // an iPad pings every second (even on bad Wi-Fi, just late): 40s of total silence = it's gone (app closed / screen locked): hang up                    // a player whose Wi-Fi drops keeps their spot this long
const NO_GEAR = new Set(['t','name','pk','duo','r2','q','exp','create','party','rr','id','rejoin','c','tok']);
import CAT from './catalog.js';
import { walGear } from './wallet.js';
// what each play pays (the same numbers the iPads show): [coins, gems, trophy counter]
const PAY = { green: [3, 1, 'greens'], block: [4, 1, 'lock'], steal: [4, 1, 'lock'], pick: [4, 1, 'lock'], tip: [2, 0, ''], charge: [5, 1, 'lock'], shook: [5, 1, 'ankles'], froze: [4, 1, 'ankles'] };
const tierOf = rr => { let ti = 0; CAT.tiers.forEach((m, i) => { if (rr >= m) ti = i; }); const T = CAT.tiers; let div = 0;
  if (ti < T.length - 3) { const step = (T[ti + 1] - T[ti]) / 3; div = Math.min(2, Math.floor((rr - T[ti]) / step)); } return { ti, div }; };
const FB = 'https://buckets-37d04-default-rtdb.firebaseio.com';   // cheat reports land here (admin panel shows them)
const nyDay = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rid = n => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)]; return s; };

export class GameRoom {
  constructor(state, env) { this.state = state; this.env = env; this.simT = 0; this.reset(); }
  reset() {
    this.G = { phase: 'lobby', players: new Map(), toWin: 11, diff: 'pro', winBy2: false, ranked: false, ranked2: false, party: false, srch: false };
    this.socks = new Map();      // id -> { ws, away }
    this.owner = null; this.RM = null; this.q = null; this.code = ''; this.emAt = new Map(); this.prAt = new Map(); this.ac = this.ac || new Map(); this.tok = new Map(); this.rk = null;
    if (this.loop) clearInterval(this.loop); this.loop = null;
    if (this.qTimer) clearTimeout(this.qTimer); this.qTimer = null;
    if (this.endT) clearTimeout(this.endT); this.endT = null; if (this.idleT) clearTimeout(this.idleT); this.idleT = null;
    if (this.reapT) clearInterval(this.reapT); this.reapT = null; this.seen = new Map(); this.overAt = 0; this.lastAct = Date.now();
  }
  // say goodbye to everyone and empty the room (nothing left running = nothing billed)
  closeAll(note) {
    for (const [, s] of this.socks) { try { if (note) this.send(s.ws, { t: note }); this.send(s.ws, { t: 'bye' }); s.ws.close(1000, 'done'); } catch (e) {} }
    this.reset();
  }
  idleCheck() {
    if (this.idleT) clearTimeout(this.idleT);
    this.idleT = setTimeout(() => { this.idleT = null; if (!this.humans()) return;
      if (this.G.phase === 'lobby' && Date.now() - (this.lastAct || 0) >= LOBBY_IDLE_MS - 1000) this.closeAll('idle'); else this.idleCheck(); }, 60000);
  }
  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
    this.code = decodeURIComponent(new URL(req.url).pathname.split('/').pop() || '').slice(0, 16);
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    let id = null;
    ws.addEventListener('message', ev => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;
      this.seen.set(ws, Date.now());
      try { if (!id) id = this.hello(ws, d); else this.onMsg(id, d, ws); } catch (e) { console.log('room error', e && e.stack); }
    });
    const gone = () => { if (id) this.lost(id, ws); };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- helpers
  humans(team) { let n = 0; for (const p of this.G.players.values()) if (!p.bot && (team === undefined || p.team === team)) n++; return n; }
  count(team) { let n = 0; for (const p of this.G.players.values()) if (p.team === team) n++; return n; }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  to(id, o) { const s = this.socks.get(id); if (s && !s.away) this.send(s.ws, o); }
  all(o) { const str = JSON.stringify(o); for (const s of this.socks.values()) if (!s.away) { try { s.ws.send(str); } catch (e) {} } }
  roster() {
    const G = this.G;
    return { t: 'roster', code: this.code, phase: G.phase, toWin: G.toWin, diff: G.diff, winBy2: !!G.winBy2, ranked: !!G.ranked, ranked2: !!G.ranked2,
      party: !!G.party, srch: !!G.srch, owner: this.owner, players: [...G.players.values()].map(({ want, conf, gq, ...p }) => p) };   // (want/conf: the wallet check, server-only)
  }
  pushRoster() { this.all(this.roster()); }
  newNum() { const used = new Set([...this.G.players.values()].map(p => p.num)); let n; do { n = 1 + Math.floor(Math.random() * 45); } while (used.has(n)); return n; }
  addPlayer(id, name, bot, team) {
    if (team === undefined) team = this.count(0) <= this.count(1) ? 0 : 1;
    const r = { id, name: S.cleanName(name), team, bot: !!bot, num: this.newNum() };
    this.G.players.set(id, r); return r;
  }
  setGear(r, d) {
    r.want = r.want || {}; for (const k in d) if (!NO_GEAR.has(k) && /^[a-z][a-zA-Z0-9]{0,11}$/.test(k) && typeof d[k] === 'string' && d[k].length <= 64) r.want[k] = d[k];
    if (r.bot) { Object.assign(r, r.want); return; }
    const tmp = walGear(null, r.want), C = r.conf; if (C) for (const k in tmp) if (C.ask[k] === r.want[k] && C.res[k] !== undefined) tmp[k] = C.res[k];
    Object.assign(r, r.want, tmp);     // shown right away: only what's free (or what the wallet already confirmed)
    this.checkGear(r);
  }
  // ask the wallet what this player may really wear online (a hacked iPad can claim anything)
  async checkGear(r) {
    const P = this.prof(), t = this.tok.get(r.id); if (!P || !t) return;
    const ask = { ...r.want }; r.gq = (r.gq || 0) + 1; const q = r.gq;
    try { const d = await P.fetch('https://x/w/gear', { method: 'POST', body: JSON.stringify({ list: [{ tok: t, gear: ask }] }) }).then(x => x.json());
      const g = d.gear && d.gear[t]; if (!g || q !== r.gq || !this.G.players.has(r.id)) return;
      r.conf = { ask, res: g }; Object.assign(r, r.want, g); this.pushRoster(); } catch (e) {} }
  addBot(team) {
    if (this.count(team) >= S.MAX_PER_TEAM) return;
    const used = new Set([...this.G.players.values()].map(p => p.name)); const nm = S.BOT_NAMES.find(n => !used.has(S.cleanName(n + ' 🤖'))) || 'Bot';
    this.addPlayer('bot-' + rid(6), nm + ' 🤖', true, team);
  }
  addRival(R, team) { const b = this.addPlayer('rv-' + R.k, R.n, true, team); b.rv = R.k; b.rr = S.rivalRR(R); b.num = R.num; return b; }
  // fill empty spots with Ranked Rivals near a rating
  fillRivals(near) {
    const used = new Set([...this.G.players.keys()]);
    const pool = S.RIVALS.filter(R => !used.has('rv-' + R.k)).map(R => ({ R, rr: S.rivalRR(R) })).sort((a, b) => Math.abs(a.rr - near) - Math.abs(b.rr - near)).slice(0, 6);
    for (const t of [0, 1]) while (this.count(t) < 2 && pool.length) { const o = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; this.addRival(o.R, t); }
  }
  clearBots() { for (const [id, r] of [...this.G.players]) if (r.bot) this.G.players.delete(id); }

  // ---------------------------------------------------------------- joining
  hello(ws, d) {
    let G = this.G; this.lastAct = Date.now(); if (!this.idleT) this.idleCheck(); if (!this.reapT) this.reapT = setInterval(() => this.reap(), 10000);
    if (d.t !== 'hello') { ws.close(1000); return null; }
    const empty = this.humans() === 0;
    // coming back after a Wi-Fi drop: same id, same spot
    if (d.rejoin && typeof d.id === 'string' && G.players.has(d.id) && !G.players.get(d.id).bot) {
      const old = this.socks.get(d.id); if (old && old.ws !== ws) { try { old.ws.close(1000); } catch (e) {} }
      this.socks.set(d.id, { ws, away: 0 }); this.send(ws, { t: 'welcome', id: d.id, re: 1 }); this.send(ws, this.roster()); return d.id;
    }
    if (d.rejoin) { this.send(ws, { t: 'none' }); ws.close(1000); return null; }                        // your spot in that game is gone
    if (empty && !d.create && !d.q) { this.send(ws, { t: 'none' }); ws.close(1000); return null; }       // no such room here
    if (!empty && d.create) { this.send(ws, { t: 'taken' }); ws.close(1000); return null; }               // code already in use
    if (empty) { const code = this.code; this.reset(); this.code = code; G = this.G; if (d.create) G.party = !!d.party; if (d.q) this.q = { mode: d.q === 'rival' ? 'rival' : d.q === '2v2solo' ? '2v2solo' : d.q === '2v2' ? '2v2' : '1v1', exp: d.q === 'rival' || d.q === '2v2solo' ? 1 : Math.max(2, Math.min(4, +d.exp || 2)), t0: Date.now() }; }
    // who may join
    if ((d.duo || d.r2) && !(G.party && G.phase === 'lobby' && this.humans(1) < 2)) { this.send(ws, { t: 'busy' }); ws.close(1000); return null; }
    if (G.players.size >= S.MAX_PER_TEAM * 2) {
      const bot = [...G.players.values()].find(p => p.bot);
      if (bot && G.phase === 'lobby') G.players.delete(bot.id); else { this.send(ws, { t: 'full' }); ws.close(1000); return null; }
    }
    let id = typeof d.id === 'string' && /^[a-z0-9]{6,16}$/.test(d.id) && !G.players.has(d.id) ? d.id : 'u' + rid(9);
    let team;
    if (d.duo || d.r2) team = this.count(1) < S.MAX_PER_TEAM ? 1 : 0;
    else if (G.party) team = this.count(0) < 2 ? 0 : 1;
    const r = this.addPlayer(id, d.name, false, team);
    if (typeof d.tok === 'string' && /^[0-9a-f]{32,64}$/.test(d.tok)) { this.tok.set(id, d.tok); this.loadRR(id); }
    this.setGear(r, d); r.rr = Math.max(0, Math.min(9999, Math.round(+d.rr || 0))); if (typeof d.pk === 'string' && d.pk) r.pk = d.pk.slice(0, 80);
    this.socks.set(id, { ws, away: 0 });
    if (!this.owner || !G.players.has(this.owner)) this.owner = id;
    this.send(ws, { t: 'welcome', id });
    this.pushRoster();
    this.afterJoin();
    return id;
  }
  afterJoin() {
    const G = this.G;
    // team-up room: the other side has 2 real players (a duo, or solo queuers) -> ranked 2v2 starts
    if (G.party && G.phase === 'lobby' && this.humans(1) >= 2 && this.humans(0) >= 1) { G.srch = false; this.startRanked2(Math.max(0, ...[...G.players.values()].filter(p => !p.bot).map(p => p.rr || 0)), 'pro'); return; }
    // queue rooms: start when everyone's here, or after a short wait with whoever made it
    if (this.q && G.phase === 'lobby') {
      if (this.q.exp === 1) { if (!this.qTimer) this.qTimer = setTimeout(() => { this.qTimer = null; if (G.phase === 'lobby' && this.humans()) this.startQueue(); }, 900); return; }
      if (this.humans() >= this.q.exp) return this.startQueue();
      if (!this.qTimer) this.qTimer = setTimeout(() => { this.qTimer = null; if (G.phase !== 'lobby' || !this.q) return;
        if (this.humans() >= 2) this.startQueue();
        else { this.all({ t: 'qnone' }); for (const s of this.socks.values()) try { s.ws.close(1000); } catch (e) {} this.reset(); } }, 10000);
    }
  }
  startQueue() {
    const G = this.G; if (this.qTimer) { clearTimeout(this.qTimer); this.qTimer = null; }
    this.clearBots();
    if (this.q.mode === 'rival') {   // nobody in the queue: a Ranked Rival near your (server) rating, played on the server so it counts for real
      const me = [...G.players.values()][0]; me.team = 0; const my = me.rr || 0;
      const pool = S.RIVALS.map(R => ({ R, rr: S.rivalRR(R) })).sort((a, b) => Math.abs(a.rr - my) - Math.abs(b.rr - my)).slice(0, 4);
      const o = Math.random() < 0.7 ? pool[0] : pool[Math.floor(Math.random() * pool.length)]; this.addRival(o.R, 1);
      G.ranked = true; G.toWin = 11; G.winBy2 = true; G.diff = S.diffForRR(o.rr);
      return this.startMatch(3.6);
    }
    if (this.q.mode === '2v2solo') { const me = [...G.players.values()][0]; me.team = 0; return this.startRanked2(me.rr || 0, S.diffForRR(me.rr || 0)); }
    if (this.q.mode === '1v1') {
      const hum = [...G.players.values()]; hum.forEach((p, i) => p.team = i % 2);
      G.ranked = true; G.toWin = 11; G.winBy2 = true; G.diff = 'pro';
      this.startMatch(3.6);
    } else {
      // fair teams: snake draft by rating, Ranked Rivals fill the rest
      const hum = [...G.players.values()].sort((a, b) => (b.rr || 0) - (a.rr || 0)), pattern = [0, 1, 1, 0];
      hum.forEach((p, i) => p.team = pattern[i % 4]);
      const avg = hum.reduce((s, p) => s + (p.rr || 0), 0) / Math.max(1, hum.length);
      this.startRanked2(avg, S.diffForRR(avg));
    }
  }
  startRanked2(near, diff) {
    const G = this.G; this.fillRivals(near);
    G.ranked2 = true; G.toWin = 21; G.winBy2 = true; G.diff = diff || S.diffForRR(near);
    this.startMatch(3.6);
  }

  // ---------------------------------------------------------------- the match
  startMatch(wait) {
    const G = this.G; if (G.phase !== 'lobby') return;
    const ro = [...G.players.values()]; if (!ro.some(p => p.team === 0) || !ro.some(p => p.team === 1)) return;
    this.overAt = 0; if (this.endT) { clearTimeout(this.endT); this.endT = null; } this.matchAt = Date.now(); this.fft = false;
    this.RM = S.newMatch(ro, G.toWin, false, G.diff, G.winBy2); if (wait) this.RM.phaseT = Math.max(this.RM.phaseT, wait);
    this.RM.hum0 = this.humans(0) > 0; this.RM.hum1 = this.humans(1) > 0; this.overSeen = false; this.tl = new Map(); this.credited = new Set(); this.rc = new Map(); this.finP = null;
    // ranked results are decided here: matchmade games, Ranked Rival games and ranked 2v2s (not private 1v1 rooms: no farming)
    this.rk = (this.q || G.ranked2) ? new Map([...G.players.values()].filter(p => !p.bot && this.tok.has(p.id)).map(p => [p.id, { tok: this.tok.get(p.id), team: p.team, name: p.name, claim: p.rr || 0 }])) : null; this.rkDone = false;
    this.calcRR();
    G.phase = 'game'; this.pushRoster();
    if (this.loop) clearInterval(this.loop);
    this.last = Date.now(); this.acc = 0;
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }
  tick() {
    const RM = this.RM; if (!RM) { clearInterval(this.loop); this.loop = null; return; }
    const now = Date.now(); this.acc += Math.min(250, now - this.last) / 1000; this.last = now;
    try { while (this.acc >= 1 / 60) { this.acc -= 1 / 60; S.stepMatch(RM, 1 / 60); this.simT += 1000 / 60; } } catch (e) { console.log('sim error', e && e.stack); }
    if (RM.phase === 'over' && !this.overSeen) { this.overSeen = true; this.overAt = now; if (this.q) { RM.phaseT = 1e6; if (this.endT) clearTimeout(this.endT); this.endT = setTimeout(() => this.closeAll(), RESULTS_CLOSE_MS); } this.finish(RM.winner); }
    if (this.q && this.overAt && now - this.overAt > RESULTS_STEP_MS) { this.all(S.makeSnap(RM, true)); clearInterval(this.loop); this.loop = null; return; }   // results screen: nothing moves any more
    const snap = S.makeSnap(RM, true); snap.st = Math.round(this.simT); if (!snap.ev.length) delete snap.ev;   // st: game time of this update (60 steps/s vs 50 updates/s, so wall time would wobble)
    this.all(snap); this.tally(RM.events); RM.events = [];
    if (RM.phase === 'over' && RM.phaseT <= 0) this.toLobby();
  }
  toLobby() {
    const G = this.G; this.RM = null; if (this.loop) clearInterval(this.loop); this.loop = null;
    G.phase = 'lobby'; G.ranked2 = false;
    if (G.party) this.clearBots();                       // team-up: rivals leave after the game
    this.pushRoster();
  }
  // a player is gone for good: take them out of the roster and the match
  remove(id) {
    const G = this.G, r = G.players.get(id); if (!r) return;
    G.players.delete(id); this.socks.delete(id);
    const RM = this.RM;
    if (RM) {
      if (RM.phase !== 'over') this.credit([id], null, true);
      const i = RM.players.findIndex(p => p.id === id);
      if (i >= 0) { RM.players.splice(i, 1); if (RM.ball.holder === id) S.looseBall(RM, RM.ball.x, 80, RM.ball.z, 0, 100, 0, r.team); }
      // a whole side of real players left a ranked game: the other side wins (counts for rank)
      if ((G.ranked || G.ranked2 || this.q) && RM.phase !== 'over') {
        const left0 = RM.hum0 && this.humans(0) === 0, left1 = RM.hum1 && this.humans(1) === 0;
        if ((left0 || left1) && this.humans() > 0) { const w = left0 ? 1 : 0; RM.winner = w; RM.phase = 'over'; RM.phaseT = this.q ? 1e6 : 15; RM.events.push({ k: 'over', w, forfeit: 1 }); this.overSeen = true; this.overAt = Date.now(); if (this.q) { if (this.endT) clearTimeout(this.endT); this.endT = setTimeout(() => this.closeAll(), RESULTS_CLOSE_MS); } }
        if (left0 || left1) { this.fft = true; this.finish(left0 ? 1 : 0); }   // quitting a ranked game is a loss, decided here (refreshing can't dodge it)
      }
    }
    if (this.owner === id) { const h = [...G.players.values()].find(p => !p.bot); this.owner = h ? h.id : null; }
    if (this.humans() === 0) { this.reset(); return; }
    this.pushRoster();
  }
  // zombie connections (iPad asleep / app switched) keep a room open and billed: close them, the normal
  // dropped-Wi-Fi rules take it from there (15s to come back, then the spot is freed)
  reap() {
    const now = Date.now();
    for (const [id, s] of [...this.socks]) { if (s.away) continue; const t = this.seen.get(s.ws) || 0;
      if (now - t > SILENT_MS) { try { s.ws.close(4008, 'silent'); } catch (e) {} this.lost(id, s.ws); } }
    if (!this.socks.size && this.reapT) { clearInterval(this.reapT); this.reapT = null; }
  }
  lost(id, ws) {
    const s = this.socks.get(id); if (!s || s.ws !== ws) return;
    s.away = Date.now();
    setTimeout(() => { const t = this.socks.get(id); if (t && t.away && Date.now() - t.away >= GRACE_MS - 50) this.remove(id); }, GRACE_MS);
  }

  // ---------------------------------------------------------------- messages from players
  onMsg(id, d, ws) {
    const G = this.G, r = G.players.get(id); if (!r) return;
    const s = this.socks.get(id); if (s && s.ws !== ws) return;
    if (d.t !== 'ping' && d.t !== 'in') this.lastAct = Date.now();
    switch (d.t) {
      case 'ping': this.send(ws, { t: 'pong', ts: d.ts }); return;
      case 'bye': this.remove(id); try { ws.close(1000); } catch (e) {} return;
      case 'gear': this.setGear(r, d); this.pushRoster(); return;
      case 'team': if (G.phase !== 'lobby') return; { const t = 1 - r.team; if (this.count(t) < S.MAX_PER_TEAM) { r.team = t; this.pushRoster(); } } return;
      case 'emote': { const e = d.e | 0, now = Date.now(); if (e < 0 || e > 7 || now - (this.emAt.get(id) || 0) < 600) return; this.emAt.set(id, now);
        const ev = { k: 'emote', id, e }; if (this.RM) this.RM.events.push(ev); else this.all({ t: 'ev', e: ev }); } return;
      case 'cmd': return this.cmd(id, d);
    }
    const RM = this.RM; if (!RM) return;
    const p = S.findP(RM, id); if (!p) return;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    if (d.t === 'in') { p.inX = cl(+d.x || 0, -1, 1); p.inZ = cl(+d.z || 0, -1, 1);
      if (Number.isFinite(+d.px) && Number.isFinite(+d.pz)) {
        // a position report far from where the server has you is just ignored (no teleporting). It isn't
        // reported as cheating: after every bucket the server moves everyone back, and for a moment the iPad's
        // report is still from before that, which looks exactly like a teleport.
        const nx = cl(+d.px, 60, 1740), nz = cl(+d.pz, -S.HALF_D + 12, S.HALF_D - 12);
        if (Math.hypot(nx - p.x, nz - p.z) <= 320) { p.authX = nx; p.authZ = nz; p.authAt = performance.now(); } } }
    else if (d.t === 'a') {
      if (d.d) { p.wantA = true; p.reqW = d.w != null && Number.isFinite(+d.w) ? cl(+d.w, 0, 0.2) : null; this.prAt.set(id, Date.now()); }
      else { let m = cl(+d.m || 0, 0, 1.5);
        // the iPad times the release (so timing feels exactly the same for everyone). The server only checks the
        // claim is possible: a release time that's way off how long the button was really held (a script
        // sending a perfect number) is replaced with the real hold time. Normal lag is far inside this margin.
        const t0 = this.prAt.get(id); this.prAt.delete(id);
        if (t0) { const held = (Date.now() - t0) / 1000 / S.METER_T; if (Math.abs(m - held) > 0.75) { m = cl(held, 0, 1.5); this.strike(id, r, 'release'); } }
        p.relA = this.watchShot(id, r, m, p); }
    }
    else if (d.t === 'b') p.wantB = true;
    else if (d.t === 'c') p.wantC = true;
  }
  // ---- 💰 match rewards: the server counts what each player did and pays their wallet at the end
  tally(evs) {
    if (!evs || !evs.length || !this.tl) return;
    const add = (id, c, g, f) => { if (!id || !this.tok.has(id)) return; const t = this.tl.get(id) || { c: 0, g: 0, feat: {} }; t.c += c; t.g += g; if (f) t.feat[f] = (t.feat[f] || 0) + 1; this.tl.set(id, t); };
    for (const e of evs) {
      if (e.k === 'shot' && e.q === 'perfect') add(e.id, ...PAY.green);
      else if (e.k === 'score' && e.by) { const th = e.three || e.pts === 3; add(e.by, th ? 6 : 4, e.dunk || th ? 1 : 0, ''); }
      else if (PAY[e.k]) add(e.k === 'shook' || e.k === 'froze' ? e.by : e.id, ...PAY[e.k]);
    }
  }
  finish(w) { if (this.finP) return; const rp = this.rankResults(w); this.finP = Promise.resolve(rp).catch(() => {}).then(() => this.credit(null, w)); }
  async credit(ids, w, left) {
    const RM = this.RM, P = this.prof(); if (!RM || !P || !this.tl) return;
    const sc = RM.score || [0, 0], list = [];
    for (const p of RM.players) { if (p.bot || (ids && !ids.includes(p.id)) || this.credited.has(p.id) || !this.tok.has(p.id)) continue;
      this.credited.add(p.id); const t = this.tl.get(p.id) || { c: 0, g: 0, feat: {} }, x = { id: p.id, tok: this.tok.get(p.id), c: t.c, g: t.g, feat: { ...t.feat }, rc: this.rc.get(p.id) || 0 };
      if (!left) { const win = p.team === w; x.played = true; x.win = win; x.c += 10 + (win ? 25 : 0); x.g += CAT.gemFor.PLAYED + (win ? CAT.gemFor.WIN : 0);
        if (win) { x.feat.wins = 1; if (sc[1 - p.team] === 0 && sc[p.team] >= 7) x.zero = 1; } }
      list.push(x); }
    if (!list.length) return;
    try { const d = await P.fetch('https://x/w/game', { method: 'POST', body: JSON.stringify({ list }) }).then(r => r.json());
      for (const x of list) { const r = d.res && d.res[x.tok]; if (r) this.to(x.id, { t: 'wal', w: r.w, got: { c: r.c, g: r.g, packs: r.packs } }); } } catch (e) { console.log('wallet error', e && e.stack); }
  }
  // ---- server RR
  calcRR() { this.rkRR = [0, 1].map(t => { const o = [...this.G.players.values()].filter(p => p.team === t); return o.length ? o.reduce((s, p) => s + (p.rr || 0), 0) / o.length : 0; }); }
  prof() { return this.env && this.env.PROFILES ? this.env.PROFILES.get(this.env.PROFILES.idFromName('global')) : null; }
  async loadRR(id) { const P = this.prof(), t = this.tok.get(id); if (!P || !t) return;
    try { const r = await P.fetch('https://x/rk/get', { method: 'POST', body: JSON.stringify({ toks: [t] }) }).then(r => r.json()); const pl = this.G.players.get(id); if (pl && r.rr && r.rr[t] !== undefined) { pl.rr = r.rr[t]; if (this.rk && !this.rkDone) this.calcRR(); this.pushRoster(); } } catch (e) {} }
  async rankResults(winner) {
    if (!this.rk || this.rkDone || !this.RM) return; this.rkDone = true;
    const RM = this.RM, w = winner !== undefined ? winner : RM.winner, sc = RM.score || [0, 0], all = [...this.G.players.values()];
    const avgRR = team => (this.rkRR || [0, 0])[team] || 0;
    const pts = RM.players.map(p => p.pts || 0), avgP = pts.reduce((a, b) => a + b, 0) / Math.max(1, pts.length);
    const list = [...this.rk].map(([id, x]) => { const win = x.team === w, mp = (RM.players.find(p => p.id === id) || {}).pts || 0, ratio = avgP > 0 ? clamp(mp / avgP, 0.4, 1.8) : 1;
      return { id, tok: x.tok, name: x.name, claim: x.claim, win, opp: avgRR(1 - x.team), margin: Math.abs(sc[0] - sc[1]), perf: win ? Math.round(clamp((ratio - 1) * 8, -2, 6)) : Math.round(clamp((ratio - 1) * 6, -2, 4)),
        team: x.team, fft: this.fft ? 1 : 0, dur: Math.round((Date.now() - (this.matchAt || Date.now())) / 1000), pts: (sc[0] | 0) + (sc[1] | 0) }; });   // (for the win-trading checks)
    const P = this.prof(); if (!P || !list.length) return;
    try { const r = await P.fetch('https://x/rk/res', { method: 'POST', body: JSON.stringify({ list }) }).then(r => r.json());
      for (const x of list) { const res = r.res && r.res[x.tok]; if (!res) continue; this.to(x.id, { t: 'rk', win: x.win, ...res });
        { const a = tierOf(res.rr), b4 = tierOf(Math.max(0, res.rr - res.d)); this.rc && this.rc.set(x.id, (x.win ? 25 + a.ti * 10 : 5) + (a.ti > b4.ti ? 300 : a.ti === b4.ti && a.div > b4.div ? 50 : 0)); } const pl = this.G.players.get(x.id); if (pl) pl.rr = res.rr; } } catch (e) { console.log('rank error', e && e.stack); }
  }
  // 🛡️ auto-green watch. People are never pixel-perfect: even great shooters land within ±9ms of dead centre
  // only about 1 shot in 4. A script lands there every time. 8 in a row = flagged: their green stops being
  // automatic for the rest of the match, and it's reported to the admin panel.
  watchShot(id, r, m, p) {
    const A = this.ac.get(r.pk || id) || { e: [], flag: 0, strikes: 0, run: 0, tight: 0 };
    const e = Math.abs(m - S.SWEET), w = p && p.act === 'shoot' ? (p.meterWin || 0) : null;
    A.e.push(e); if (A.e.length > 10) A.e.shift();
    // 10 releases in a row within ~19ms of dead centre: a person's timing wobbles far more than that (greens are much
    // wider, so streaks of greens alone prove nothing); a script lands there every single time.
    if (!A.flag && A.e.length >= 10 && A.e.every(x => x <= 0.011)) { A.flag = 1; this.report(r, 'auto-green script (10 dead-centre releases in a row)'); }
    this.ac.set(r.pk || id, A);
    if (A.flag) m += (Math.random() < 0.5 ? -1 : 1) * (0.035 + Math.random() * 0.08);   // a flagged script's releases get human-sized misses
    return m;
  }
  strike(id, r, why) { const A = this.ac.get(r.pk || id) || { e: [], flag: 0, strikes: 0 }; A.strikes++; this.ac.set(r.pk || id, A); if (A.strikes === 12) this.report(r, 'fake ' + why + ' reports'); }
  async report(r, why) {
    this.reported = this.reported || new Set(); const rk = (r.pk || r.id) + '|' + why; if (this.reported.has(rk)) return; this.reported.add(rk);
    const rec = { n: String(r.name || '').slice(0, 24), pk: String(r.pk || '').slice(0, 16), why, room: this.code, ranked: !!(this.G.ranked || this.G.ranked2 || this.q), t: Date.now() };
    // add who they are on the leaderboard (the name in-game can be anything)
    try { const P = this.prof(), t = this.tok.get(r.id); if (P && t) { const d = await P.fetch('https://x/rk/get', { method: 'POST', body: JSON.stringify({ toks: [t] }) }).then(x => x.json()); const m = d.nm && d.nm[t]; if (m) { rec.lb = String(m.n || '').slice(0, 24); if (!rec.pk && m.pk) rec.pk = m.pk.slice(0, 16); rec.rr = d.rr[t]; } } } catch (e) {}
    try { fetch(FB + '/rooms/_cheat' + nyDay() + '.json', { method: 'POST', body: JSON.stringify(rec) }).catch(() => {}); } catch (e) {}
  }
  // room owner's buttons (start, bots, settings...)
  cmd(id, d) {
    const G = this.G, c = d.c, own = id === this.owner;
    if (c === 'migrate') { if (!own || typeof d.code !== 'string') return; const tag = rid(6); this.all({ t: 'migrate', code: d.code.slice(0, 16), tag }); return; }
    if (!own) return;
    switch (c) {
      case 'start': return this.startMatch();
      case 'addbot': if (G.phase === 'lobby') { this.addBot(d.team === 1 ? 1 : 0); this.pushRoster(); } return;
      case 'rmbot': { const b = G.players.get(String(d.id)); if (b && b.bot && G.phase === 'lobby') { G.players.delete(b.id); this.pushRoster(); } } return;
      case 'towin': if ([11, 15, 21].includes(+d.v) && G.phase === 'lobby') { G.toWin = +d.v; this.pushRoster(); } return;
      case 'diff': if (['rookie', 'pro', 'legend'].includes(d.d) && G.phase === 'lobby') { G.diff = d.d; this.pushRoster(); } return;
      case 'wb2': if (G.phase === 'lobby') { G.winBy2 = !G.winBy2; this.pushRoster(); } return;
      case 'ranked': if (G.phase === 'lobby') { G.ranked = !G.ranked; this.pushRoster(); } return;
      case 'rematch': if (this.RM && this.RM.phase === 'over') { this.toLobby(); this.startMatch(); } return;
      case 'tolobby': if (this.RM && this.RM.phase === 'over') this.toLobby(); return;
      case 'srch': G.srch = !!d.on; this.pushRoster(); return;
      case 'p2bots': if (G.party && G.phase === 'lobby' && this.humans(0) >= 2) {   // ranked 2v2 needs a real teammate G.srch = false; this.clearBots();
        const near = Math.max(0, ...[...G.players.values()].filter(p => !p.bot && p.team === 0).map(p => p.rr || 0)); this.startRanked2(near); } return;
    }
  }
}

// ---------------------------------------------------------------- MATCHMAKER
// q1 = ranked 1v1 searchers, q2 = ranked 2v2 solo searchers, qd = team-up duos looking for opponents
export class Matchmaker {
  constructor(state, env) { this.q1 = []; this.q2 = []; this.qd = []; this.t2 = null; }
  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ q1: this.q1.length, q2: this.q2.length, duos: this.qd.length }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    const [client, ws] = Object.values(new WebSocketPair()); ws.accept();
    const me = { ws, mode: null, t: Date.now(), sent: 0 };
    ws.addEventListener('message', ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } if (!d) return;
      try { if (d.t === 'q') this.join(me, d); else if (d.t === 'cancel') this.drop(me); } catch (e) { console.log('mm error', e && e.stack); } });
    const gone = () => this.drop(me); ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  send(e, o) { try { e.ws.send(JSON.stringify(o)); } catch (x) {} }
  drop(e) { for (const k of ['q1', 'q2', 'qd']) { const i = this[k].indexOf(e); if (i >= 0) this[k].splice(i, 1); } clearTimeout(e.timer); this.arm2(); this.wait2(); }
  // the 2v2 queue waits up to 20s from the first searcher, then plays with whoever is there
  arm2() { if (this.q2.length && !this.t2) this.t2 = setTimeout(() => { this.t2 = null; this.timeout2(); }, 25000); if (!this.q2.length && this.t2) { clearTimeout(this.t2); this.t2 = null; } }
  wait2() { for (const e of this.q2) this.send(e, { t: 'wait', n: this.q2.length }); }
  join(e, d) {
    this.drop(e); e.mode = d.mode; e.rr = +d.rr || 0; e.t = Date.now(); e.dev = typeof d.dev === 'string' ? d.dev.slice(0, 24) : '';
    // the same iPad queued twice (a second tab, a stale connection): forget the old one, never match it with itself
    if (e.dev) for (const k of ['q1', 'q2']) for (const x of [...this[k]]) if (x !== e && x.dev === e.dev) { this.drop(x); try { x.ws.close(1000); } catch (err) {} }
    if (d.mode === '1v1') {
      const oi = this.q1.findIndex(x => !e.dev || x.dev !== e.dev), other = oi >= 0 ? this.q1.splice(oi, 1)[0] : null;
      if (other) { clearTimeout(other.timer); const code = 'Q' + rid(7); for (const x of [other, e]) this.send(x, { t: 'go', code, mode: '1v1', exp: 2 }); return; }
      this.q1.push(e);
      e.timer = setTimeout(() => { const i = this.q1.indexOf(e); if (i >= 0) { this.q1.splice(i, 1); this.send(e, { t: 'none' }); } }, 25000);   // 25s for a real player before a Ranked Rival steps in
    } else if (d.mode === '2v2') {
      // a team-up duo is waiting for opponents: go play them
      const duo = this.qd.find(x => x.sent < 2);
      if (duo) { duo.sent++; this.send(e, { t: 'go', code: duo.code, mode: 'duo-solo' }); this.send(duo, { t: 'filled', n: duo.sent }); if (duo.sent >= 2) this.qd.splice(this.qd.indexOf(duo), 1); return; }
      this.q2.push(e); this.wait2();
      if (this.q2.length >= 4) return this.launch2(this.q2.splice(0, 4));
      this.arm2();
    } else if (d.mode === 'duo' && typeof d.code === 'string') {
      e.code = d.code.slice(0, 16);
      const other = this.qd.find(x => x.sent === 0 && x !== e);
      if (other) { this.qd.splice(this.qd.indexOf(other), 1); this.send(other, { t: 'filled', n: 2 }); this.send(e, { t: 'go', code: other.code, mode: 'duo-migrate' }); return; }
      while (e.sent < 2 && this.q2.length) { const s = this.q2.shift(); e.sent++; this.send(s, { t: 'go', code: e.code, mode: 'duo-solo' }); this.send(e, { t: 'filled', n: e.sent }); }
      this.arm2(); this.wait2();
      if (e.sent < 2) this.qd.push(e);
    }
  }
  timeout2() {
    if (this.q2.length >= 2) return this.launch2(this.q2.splice(0, 4));
    const e = this.q2.shift(); if (e) this.send(e, { t: 'none' });
    this.arm2();
  }
  launch2(list) { const code = 'Q' + rid(7); for (const x of list) this.send(x, { t: 'go', code, mode: '2v2', exp: list.length }); if (this.t2) { clearTimeout(this.t2); this.t2 = null; } this.arm2(); this.wait2(); }
}
