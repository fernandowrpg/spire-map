/**
 * Gerador de números pseudoaleatórios determinístico (mulberry32).
 * A mesma seed sempre produz o mesmo mapa — essencial para reproduzir mapas em mesa.
 * @module spire-map/rng
 */

/**
 * Converte uma string arbitrária em um inteiro de 32 bits (FNV-1a-ish / cyrb53 simplificado).
 * @param {string} str
 * @returns {number} inteiro de 32 bits sem sinal
 */
export function hashSeed(str) {
  const s = String(str ?? "");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Mistura final para espalhar bits de seeds curtas ("1", "2", "a"...)
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Gera uma seed legível e curta, ex.: "K7F-2QD-91X". */
export function randomSeedString() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from({ length: 3 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

export class Rng {
  /** @param {string|number} seed */
  constructor(seed) {
    this.seed = seed;
    this._state = (typeof seed === "number" ? seed >>> 0 : hashSeed(seed)) || 0x9e3779b9;
  }

  /** @returns {number} float em [0, 1) */
  float() {
    let t = (this._state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Inteiro em [min, max] inclusivo. Com um argumento: [0, min-1].
   * @param {number} min
   * @param {number} [max]
   */
  int(min, max) {
    if (max === undefined) return Math.floor(this.float() * min);
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** Float em [min, max). */
  range(min, max) {
    return min + this.float() * (max - min);
  }

  /** @template T @param {T[]} arr @returns {T|undefined} */
  pick(arr) {
    if (!arr?.length) return undefined;
    return arr[this.int(arr.length)];
  }

  /** Embaralhamento Fisher-Yates in-place determinístico. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Sorteio ponderado.
   * @template T
   * @param {T[]} items
   * @param {(item: T) => number} weightFn
   * @returns {T|null}
   */
  weighted(items, weightFn) {
    const pool = items.filter((i) => weightFn(i) > 0);
    if (!pool.length) return null;
    const total = pool.reduce((sum, i) => sum + weightFn(i), 0);
    let roll = this.float() * total;
    for (const item of pool) {
      roll -= weightFn(item);
      if (roll <= 0) return item;
    }
    return pool[pool.length - 1];
  }
}
