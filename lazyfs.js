(() => {
  const KEEP = 40 << 20, SMALL = 256 << 10;
  const urlOf = path => path.slice(1).split('/').map(encodeURIComponent).join('/');
  const fetchSync = url => fetchAssetSync(url);
  const makeDirs = (FS, dir) => {
    let at = '';
    for (const part of dir.split('/').filter(Boolean)) {
      at += '/' + part;
      try { FS.mkdir(at); } catch {}
    }
  };
  self.fetchSmallPack = async (list, onProgress) => {
    let total = 0;
    for (const [offset, size] of Object.values(list.pack)) total = Math.max(total, offset + size);
    const pack = await fetchAsset('small.pack', onProgress);
    if (pack.length !== total) throw new Error('small.pack: truncated');
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
})();
