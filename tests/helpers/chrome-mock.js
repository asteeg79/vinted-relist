// Minimal in-memory stand-in for the subset of chrome.* APIs our lib modules use.
// Each call to installChromeMock() resets global state.
// `cookies` maps cookie name → value (for chrome.cookies.get).
export function installChromeMock(initial = {}, cookies = {}) {
  const store = structuredClone(initial);

  const local = {
    get: async (keys) => {
      if (keys == null) return structuredClone(store);
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const o = {};
        for (const k of keys) o[k] = store[k];
        return o;
      }
      // object form: keys are names, values are defaults
      const o = {};
      for (const k of Object.keys(keys)) o[k] = (k in store) ? store[k] : keys[k];
      return o;
    },
    set: async (obj) => { Object.assign(store, structuredClone(obj)); },
    remove: async (keys) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
    },
    clear: async () => { for (const k of Object.keys(store)) delete store[k]; }
  };

  globalThis.chrome = {
    storage: { local },
    runtime: { getManifest: () => ({ version: '0.29.0' }) },
    cookies: {
      get: (query, cb) => {
        const value = cookies[query?.name];
        const result = value != null ? { name: query.name, value } : null;
        if (cb) cb(result);
        return Promise.resolve(result);
      }
    }
  };

  return { store, cookies };
}
