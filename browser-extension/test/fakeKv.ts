import type { KeyValue } from '../src/storage';

/** In-memory stand-in for chrome.storage.local. */
export class FakeKv implements KeyValue {
  data: Record<string, unknown> = {};
  async get(keys: string | string[] | null) {
    const clone = (v: unknown) => (v === undefined ? undefined : structuredClone(v));
    if (keys === null) {
      return structuredClone(this.data);
    }
    const out: Record<string, unknown> = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (k in this.data) {
        out[k] = clone(this.data[k]);
      }
    }
    return out;
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, structuredClone(items));
  }
  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      delete this.data[k];
    }
  }
}
