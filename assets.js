(() => {
  const base = new URL('.', document.currentScript.src);
  let manifest = {};
  self.prepareAssets = async () => {
    const response = await fetch(new URL('assets.json', base));
    if (!response.ok) throw new Error('Asset list: ' + response.status);
    manifest = await response.json();
  };
  self.fetchAsset = async (name, onProgress = () => {}) => {
    const entry = manifest[name];
    const parts = entry?.parts || [{ name, size: null }];
    const chunks = [];
    let received = 0;
    for (const part of parts) {
      const response = await fetch(new URL(part.name, base));
      if (!response.ok) throw new Error(part.name + ': ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (part.size !== null && bytes.length !== part.size) throw new Error(part.name + ': truncated');
      chunks.push(bytes);
      received += bytes.length;
      onProgress(received, entry?.size || received);
    }
    if (entry && received !== entry.size) throw new Error(name + ': truncated');
    const result = new Uint8Array(received);
    let offset = 0;
    for (const bytes of chunks) {
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return result;
  };
  self.fetchAssetSync = name => {
    const entry = manifest[name];
    const chunks = (entry?.parts || [{ name, size: null }]).map(part => {
      const request = new XMLHttpRequest();
      request.open('GET', new URL(part.name, base), false);
      request.overrideMimeType('text/plain; charset=x-user-defined');
      request.send(null);
      if (request.status !== 200) throw new Error(part.name + ': ' + request.status);
      const text = request.responseText;
      if (part.size !== null && text.length !== part.size) throw new Error(part.name + ': truncated');
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 255;
      return bytes;
    });
    const size = chunks.reduce((total, bytes) => total + bytes.length, 0);
    if (entry && size !== entry.size) throw new Error(name + ': truncated');
    const result = new Uint8Array(size);
    let offset = 0;
    for (const bytes of chunks) {
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return result;
  };
})();
