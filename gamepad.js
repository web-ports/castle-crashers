self.startGamepads = Module => {
  const base = Module._pe_xinput_pads ? Module._pe_xinput_pads() >>> 0 : 0;
  if (!base || !navigator.getGamepads) return;
  const bits = [0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 0x1, 0x2, 0x4, 0x8];
  const stick = (v, calibrated) => !Number.isFinite(v) || Math.abs(v) < (calibrated ? 0 : 0.15) ? 0 : Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  const trigger = b => b ? Math.round(Math.max(0, Math.min(1, Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0)) * 255) : 0;
  const settings = pad => {
    try {
      for (let host = parent; host !== self; host = host.parent) {
        if (host.__padNativeState) return host.__padNativeState(pad);
        if (host === host.parent) break;
      }
    } catch {}
    return null;
  };
  const last = ['', '', '', ''], packets = [0, 0, 0, 0], rumble = [0, 0, 0, 0];

  const poll = () => {
    requestAnimationFrame(poll);
    const mem = new DataView(Module.HEAPU8.buffer);
    const pads = [...navigator.getGamepads()].filter(p => p && p.connected);
    for (let i = 0; i < 4; i++) {
      const at = base + i * 24, pad = pads[i];
      if (!pad) {
        mem.setUint32(at, 0, true);
        last[i] = '';
        continue;
      }
      const config = settings(pad), enabled = config?.enabled !== false;
      const axes = config?.axes || pad.axes, calibrated = !!config?.axes;
      let buttons = 0;
      bits.forEach((bit, k) => { if (enabled && bit && pad.buttons[k]?.pressed) buttons |= bit; });
      const state = enabled ? [buttons, trigger(pad.buttons[6]), trigger(pad.buttons[7]), stick(axes[0], calibrated), -stick(axes[1], calibrated), stick(axes[2], calibrated), -stick(axes[3], calibrated)] : [0, 0, 0, 0, 0, 0, 0];
      const key = state.join();
      if (key !== last[i]) {
        last[i] = key;
        mem.setUint16(at + 8, state[0], true);
        mem.setUint8(at + 10, state[1]);
        mem.setUint8(at + 11, state[2]);
        for (let a = 0; a < 4; a++) mem.setInt16(at + 12 + a * 2, state[3 + a], true);
        mem.setUint32(at + 4, ++packets[i], true);
      }
      mem.setUint32(at, 1, true);
      const low = mem.getUint16(at + 20, true), high = mem.getUint16(at + 22, true), r = low * 65536 + high;
      if (r !== rumble[i] && pad.vibrationActuator) {
        rumble[i] = r;
        pad.vibrationActuator.playEffect('dual-rumble', { duration: r ? 5000 : 0, strongMagnitude: low / 65535, weakMagnitude: high / 65535 }).catch(() => {});
      }
    }
  };
  requestAnimationFrame(poll);
};
