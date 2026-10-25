(() => {
  const CB = { created: 513, enter: 504, list: 510, data: 505, member: 506, chat: 507, session: 1202 };
  const USER_HI = 0x01100001, LOBBY_HI = 0x01840000;
  const enc = new TextEncoder(), dec = new TextDecoder();

  self.startNet = Module => {
    let myId = (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7ffffff0) + 16;
    const myName = 'Truf' + String(1000 + Math.floor(Math.random() * 9000));
    const lobbies = new Map(), names = new Map([[myId, myName]]), chats = new Map(), p2p = new Map(), peers = new Set();
    const events = [], pending = new Map();
    let filters = [], slots = 0, count = 0, listed = [], chatSeq = 1, reqSeq = 1, ws = null, ready = false, outbox = [];

    const view = n => new DataView(new ArrayBuffer(n));
    const id64 = (v, at, id, hi) => { v.setUint32(at, id >>> 0, true); v.setUint32(at + 4, id ? hi : 0, true); };
    const post = (id, v, handle = 0) => events.push({ id, bytes: new Uint8Array(v.buffer), handle });
    const remember = l => { lobbies.set(l.id, l); for (const m of l.members) names.set(m.id, m.name); return l; };

    const enter = (lobby, response, handle) => {
      const v = view(24);
      id64(v, 0, lobby, LOBBY_HI);
      v.setUint32(16, response, true);
      if (handle) post(CB.enter, v, handle);
      post(CB.enter, v);
    };
    const memberChange = (lobby, user, state) => {
      const v = view(32);
      id64(v, 0, lobby, LOBBY_HI);
      id64(v, 8, user, USER_HI);
      id64(v, 16, user, USER_HI);
      v.setUint32(24, state, true);
      post(CB.member, v);
    };
    const dataChange = (lobby, member) => {
      const v = view(24);
      id64(v, 0, lobby, LOBBY_HI);
      id64(v, 8, member || lobby, member ? USER_HI : LOBBY_HI);
      v.setUint8(16, 1);
      post(CB.data, v);
    };

    const finish = (p, msg) => {
      if (p.kind === 'list') {
        listed = msg ? msg.lobbies.map(l => remember(l).id) : [];
        const v = view(4);
        v.setUint32(0, listed.length, true);
        post(CB.list, v, p.handle);
      } else if (p.kind === 'create') {
        const v = view(16);
        v.setUint32(0, msg ? 1 : 2, true);
        if (msg) id64(v, 8, msg.lobby.id, LOBBY_HI);
        post(CB.created, v, p.handle);
        if (msg) remember(msg.lobby), enter(msg.lobby.id, 1, 0);
      } else {
        if (msg && msg.ok) remember(msg.lobby);
        enter(msg ? msg.lobby.id : p.lobby, msg && msg.ok ? 1 : msg ? msg.code || 2 : 5, p.handle);
      }
    };

    const receive = e => {
      if (typeof e.data !== 'string') {
        const d = new DataView(e.data), from = d.getUint32(0, true), channel = d.getUint8(4);
        if (!peers.has(from)) {
          peers.add(from);
          const v = view(8);
          id64(v, 0, from, USER_HI);
          post(CB.session, v);
        }
        if (!p2p.has(channel)) p2p.set(channel, []);
        const q = p2p.get(channel);
        if (q.length < 4096) q.push({ from, bytes: new Uint8Array(e.data, 5) });
        return;
      }
      Module.peNetLog?.('net <', e.data.slice(0, 300));
      const msg = JSON.parse(e.data);
      if (msg.t === 'hi') {
        if (msg.id !== myId) names.delete(myId), myId = msg.id, names.set(myId, myName);
        ready = true;
        outbox.forEach(m => ws.send(m));
        outbox = [];
        return;
      }
      if (msg.req && pending.has(msg.req)) {
        const p = pending.get(msg.req);
        pending.delete(msg.req);
        return finish(p, msg);
      }
      const l = lobbies.get(msg.lobby);
      if (msg.t === 'lobby') return remember(msg.lobby), dataChange(msg.lobby.id, 0);
      if (!l) return;
      if (msg.t === 'member') {
        if (msg.change === 1 && !l.members.some(m => m.id === msg.user)) l.members.push({ id: msg.user, name: msg.name, data: {} }), names.set(msg.user, msg.name);
        if (msg.change !== 1) l.members = l.members.filter(m => m.id !== msg.user);
        memberChange(l.id, msg.user, msg.change);
      } else if (msg.t === 'data') {
        if (msg.value === '') delete l.data[msg.key];
        else l.data[msg.key] = msg.value;
        dataChange(l.id, 0);
      } else if (msg.t === 'mdata') {
        const m = l.members.find(m => m.id === msg.user);
        if (m) m.data[msg.key] = msg.value;
        dataChange(l.id, msg.user);
      } else if (msg.t === 'chat') {
        const id = chatSeq++;
        chats.set(id, { user: msg.user, bytes: Uint8Array.from(atob(msg.msg), c => c.charCodeAt(0)) });
        if (chats.size > 256) chats.delete(chats.keys().next().value);
        const v = view(24);
        id64(v, 0, l.id, LOBBY_HI);
        id64(v, 8, msg.user, USER_HI);
        v.setUint8(16, 1);
        v.setUint32(20, id, true);
        post(CB.chat, v);
      }
    };

    const connect = () => {
      if (ws) return;
      const url = new URL('ccnet', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', id: myId, name: myName }));
      ws.onmessage = receive;
      ws.onclose = ws.onerror = () => {
        if (!ws) return;
        ws = null, ready = false, outbox = [];
        for (const p of pending.values()) finish(p, null);
        pending.clear();
        for (const l of lobbies.values()) if (l.members.some(m => m.id === myId)) memberChange(l.id, myId, 4);
      };
    };
    const send = obj => {
      connect();
      const m = JSON.stringify(obj);
      Module.peNetLog?.('net >', m.slice(0, 300));
      if (ready) ws.send(m);
      else outbox.push(m);
    };
    const request = (obj, p) => {
      const req = reqSeq++;
      pending.set(req, p);
      send({ ...obj, req });
    };

    const heap = () => Module.HEAPU8;
    const str = p => { const h = heap(); let e = p; while (h[e]) e++; return dec.decode(h.slice(p, e)); };
    const put = (s, out, size) => {
      if (!out || !size) return 0;
      const b = enc.encode(s), n = Math.min(b.length, size - 1);
      heap().set(b.subarray(0, n), out);
      heap()[out + n] = 0;
      return n + 1;
    };
    const put32 = (p, v) => { if (p) new DataView(heap().buffer).setUint32(p, v >>> 0, true); };
    const mine = id => { const l = lobbies.get(id); return l && l.members.some(m => m.id === myId) ? l : null; };
    const memberOf = (l, id) => l && l.members.find(m => m.id === id);

    const op = (code, a, b, c, d, e, f) => {
      const l = lobbies.get(a);
      switch (code) {
        case 1: filters.push({ key: str(a), value: str(b), cmp: c | 0, kind: 's' }); return 1;
        case 2: filters.push({ key: str(a), value: b | 0, cmp: c | 0, kind: 'n' }); return 1;
        case 3: slots = a; return 1;
        case 4: count = a; return 1;
        case 5: request({ t: 'list', filters, slots, count }, { kind: 'list', handle: a }); filters = [], slots = 0, count = 0; return 1;
        case 6: return listed[a] || 0;
        case 7: request({ t: 'create', type: b, max: c }, { kind: 'create', handle: a }); return 1;
        case 8: request({ t: 'join', lobby: b }, { kind: 'join', handle: a, lobby: b }); return 1;
        case 9: if (l) send({ t: 'leave', lobby: a }), lobbies.delete(a); return 1;
        case 10: return l ? l.members.length : 0;
        case 11: return l && l.members[b] ? l.members[b].id : 0;
        case 12: { const v = l && l.data[str(b)]; return v === undefined ? (put('', c, d), 0) : put(v, c, d); }
        case 13: if (!mine(a)) return 0; l.data[str(b)] = str(c); send({ t: 'data', lobby: a, key: str(b), value: str(c) }); dataChange(a, 0); return 1;
        case 14: return l ? Object.keys(l.data).length : 0;
        case 15: { const k = l && Object.keys(l.data)[b]; if (k === undefined) return 0; put(k, c, d); put(l.data[k], e, f); return 1; }
        case 16: if (!mine(a)) return 0; delete l.data[str(b)]; send({ t: 'data', lobby: a, key: str(b), value: '' }); dataChange(a, 0); return 1;
        case 17: { const m = memberOf(l, b), v = m && m.data[str(c)]; return v === undefined ? (put('', d, e), 0) : put(v, d, e); }
        case 18: { const m = mine(a) && memberOf(l, myId); if (m) m.data[str(b)] = str(c), send({ t: 'mdata', lobby: a, key: str(b), value: str(c) }), dataChange(a, myId); return 1; }
        case 19: { if (!mine(a)) return 0; let s = ''; for (const x of heap().subarray(b, b + c)) s += String.fromCharCode(x); send({ t: 'chat', lobby: a, msg: btoa(s) }); return 1; }
        case 20: { const ch = chats.get(b); if (!ch) return 0; const n = Math.min(ch.bytes.length, d); heap().set(ch.bytes.subarray(0, n), c); put32(e, ch.user); put32(f, 1); return n; }
        case 21: if (l) dataChange(a, 0); return l ? 1 : 0;
        case 22: if (!mine(a)) return 0; l.max = b; send({ t: 'set', lobby: a, max: b }); dataChange(a, 0); return 1;
        case 23: return l ? l.max : 0;
        case 24: if (!mine(a)) return 0; l.type = b; send({ t: 'set', lobby: a, type: b }); dataChange(a, 0); return 1;
        case 25: if (!mine(a)) return 0; l.joinable = !!b; send({ t: 'set', lobby: a, joinable: !!b }); dataChange(a, 0); return 1;
        case 26: return l ? l.owner : 0;
        case 27: if (!mine(a) || l.owner !== myId) return 0; send({ t: 'set', lobby: a, owner: b }); return 1;
        case 28: if (mine(a)) l.server = b, send({ t: 'data', lobby: a, key: '__server', value: String(b) }); return 1;
        case 29: return l ? +(l.server || l.data.__server || l.owner) || 0 : 0;
        case 30: {
          connect();
          if (!ready) return 1;
          const out = new Uint8Array(5 + c), v = new DataView(out.buffer);
          v.setUint32(0, a, true);
          v.setUint8(4, d & 255);
          out.set(heap().subarray(b, b + c), 5);
          ws.send(out);
          peers.add(a);
          return 1;
        }
        case 31: { const q = p2p.get(a); return q && q.length ? q[0].bytes.length + 1 : 0; }
        case 32: {
          const q = p2p.get(a);
          if (!q || !q.length) return 0;
          const pkt = q.shift(), n = Math.min(pkt.bytes.length, c);
          heap().set(pkt.bytes.subarray(0, n), b);
          put32(d, pkt.bytes.length);
          put32(e, pkt.from);
          return 1;
        }
        case 33: return peers.has(a) ? 1 : 0;
        case 40: {
          const ev = events.shift();
          if (!ev) return 0;
          heap().set(ev.bytes.subarray(0, 64), a);
          put32(b, ev.id);
          put32(c, ev.bytes.length);
          put32(d, ev.handle);
          return 1;
        }
        case 41: return myId;
        case 42: return put(names.get(a) || 'Truf', b, c);
        case 43: return pending.size;
        case 44: Module.peInvite?.(a); return 1;
      }
      return 0;
    };
    Module.peNet = { op };
  };
})();
