(() => {
  const KEEP = 40 << 20, SMALL = 256 << 10;
  const urlOf = path => path.slice(1).split('/').map(encodeURIComponent).join('/');

  const fetchSync = url => {
    for (let tries = 0; ; tries++) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        xhr.send(null);
        if (xhr.status !== 200) throw new Error(url + ': ' + xhr.status);
        const text = xhr.responseText, bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
        return bytes;
      } catch (e) {
        if (tries === 2) throw e;
      }
    }
  };

  const makeDirs = (FS, dir) => {
    let at = '';
    for (const part of dir.split('/').filter(Boolean)) {
      at += '/' + part;
      try { FS.mkdir(at); } catch {}
    }
  };


self.fetchSmallPack = async (list, onProgress) => {
  let total = 0;
  for (const [offset, size] of Object.values(list.pack)) {
    total = Math.max(total, offset + size);
  }

  const pack = new Uint8Array(total);
  let got = 0;

  for (const file of ['small.pack.part1', 'small.pack.part2']) {
    const r = await fetch(file);
    if (!r.ok) throw new Error(file + ': ' + r.status);

    const reader = r.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (got + value.length > total) {
        throw new Error(file + ': exceeds expected pack size');
      }

      pack.set(value, got);
      got += value.length;
      onProgress(got, total);
    }
  }

  if (got !== total) {
    throw new Error('small.pack: truncated');
  }

  return pack;
};


  self.mountLazyFiles = (Module, list, pack) => {
    const FS = Module.FS, MEMFS = FS.filesystems.MEMFS, closed = new Map();
    let closedBytes = 0;
    const stats = Module.peLazyStats = { loads: 0, bytes: 0 };

    const load = node => {
      if (node.contents) return;
      let bytes;
      try { bytes = fetchSync(node.lazyUrl); } catch { throw new FS.ErrnoError(29); }
      node.contents = bytes;
      node.usedBytes = bytes.length;
      stats.loads++;
      stats.bytes += bytes.length;
    };
    const nodeOps = {
      getattr(node) {
        const attr = MEMFS.node_ops.getattr(node);
        if (!node.contents && !node.dirty) attr.size = node.lazySize;
        return attr;
      },
      setattr(node, attr) {
        if (attr.size !== undefined) load(node), node.dirty = true;
        return MEMFS.node_ops.setattr(node, attr);
      },
    };
    const streamOps = {
      open({ node }) {
        if (closed.has(node)) closedBytes -= node.usedBytes, closed.delete(node);
        load(node);
        node.opens = (node.opens || 0) + 1;
      },
      close({ node }) {
        if (--node.opens || node.dirty || node.usedBytes <= SMALL) return;
        closed.set(node, true);
        closedBytes += node.usedBytes;
        for (const [old] of closed) {
          if (closedBytes <= KEEP) break;
          closed.delete(old);
          closedBytes -= old.usedBytes;
          old.contents = null;
          old.usedBytes = 0;
        }
      },
      llseek: MEMFS.stream_ops.llseek,
      read: MEMFS.stream_ops.read,
      write(stream, ...rest) { stream.node.dirty = true; return MEMFS.stream_ops.write(stream, ...rest); },
      mmap: MEMFS.stream_ops.mmap,
      msync: MEMFS.stream_ops.msync,
    };

    for (const [path, [offset, size]] of Object.entries(list.pack)) {
      const cut = path.lastIndexOf('/');
      makeDirs(FS, path.slice(0, cut));
      FS.createDataFile(path.slice(0, cut), path.slice(cut + 1), pack.subarray(offset, offset + size), true, true, true);
    }
    for (const [path, size] of Object.entries(list.lazy)) {
      const cut = path.lastIndexOf('/');
      makeDirs(FS, path.slice(0, cut));
      const node = FS.createFile(path.slice(0, cut), path.slice(cut + 1), {}, true, true);
      node.lazyUrl = urlOf(path);
      node.lazySize = size;
      node.node_ops = nodeOps;
      node.stream_ops = streamOps;
    }
  };

  self.prefetchLazyFiles = async list => {
    const rank = p => /\/game\//.test(p) ? 0 : /\/(levels|bsps)\//.test(p) ? 1 : 2;
    const names = Object.keys(list.lazy).sort((a, b) => rank(a) - rank(b) || list.lazy[a] - list.lazy[b]);
    for (const path of names) {
      try { await (await fetch(urlOf(path), { priority: 'low' })).body.pipeTo(new WritableStream()); } catch {}
    }
  };
})();
