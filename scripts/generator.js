/**
 * Núcleo de geração do mapa no estilo Slay the Spire.
 *
 * O algoritmo reproduz a ideia do jogo original:
 *   1. N caminhos "sobem" o mapa, andar por andar, escolhendo entre coluna-1, coluna e coluna+1.
 *   2. Arestas nunca se cruzam (regra visual mais importante do mapa original).
 *   3. Os tipos de sala são sorteados por peso, respeitando restrições de andar mínimo,
 *      repetição no caminho e andares fixos (tesouro / descanso / boss).
 *
 * O módulo é headless: não depende de nenhuma API do Foundry, o que permite testá-lo
 * fora do jogo e reutilizá-lo no preview do painel.
 *
 * @module spire-map/generator
 */

import { Rng, randomSeedString } from "./rng.js";
import { DEFAULT_CONFIG, DEFAULT_NODE_TYPES, LIMITS } from "./constants.js";

/** @typedef {import("./constants.js").NodeType} NodeType */

/**
 * @typedef {object} MapNode
 * @property {string}   id       "f{floor}c{col}"
 * @property {number}   floor    1-indexado (1 = base da torre)
 * @property {number}   col      0-indexado
 * @property {string}   typeId
 * @property {number}   x        posição em pixels da cena
 * @property {number}   y
 * @property {string[]} parents  ids dos nós do andar anterior
 * @property {string[]} children ids dos nós do andar seguinte
 * @property {boolean}  isBoss
 */

/**
 * @typedef {object} SpireMap
 * @property {string}       seed
 * @property {object}       config
 * @property {number}       totalFloors
 * @property {MapNode[]}    nodes
 * @property {MapNode[][]}  byFloor      índice 0 = andar 1
 * @property {{from:string,to:string}[]} edges
 * @property {{width:number,height:number}} bounds
 * @property {Record<string,number>} counts contagem por typeId
 * @property {string[]}     warnings
 */

const clamp = (v, [min, max]) => Math.min(max, Math.max(min, v));
const toInt = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};
const toNum = (v, fallback) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};
const toBool = (v) => v === true || v === "true" || v === 1 || v === "1" || v === "on";

/** Chave de um nó. */
export const nodeId = (floor, col) => `f${floor}c${col}`;

/**
 * Sanitiza e completa uma configuração parcial vinda do painel/settings.
 * Nunca lança: valores inválidos caem no padrão.
 * @param {object} [partial]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function normalizeConfig(partial = {}) {
  const c = { ...DEFAULT_CONFIG, ...(partial ?? {}) };

  c.floors = clamp(toInt(c.floors, DEFAULT_CONFIG.floors), LIMITS.floors);
  c.paths = clamp(toInt(c.paths, DEFAULT_CONFIG.paths), LIMITS.paths);
  c.columns = clamp(toInt(c.columns, DEFAULT_CONFIG.columns), LIMITS.columns);
  c.act = clamp(toInt(c.act, 1), [1, 99]);

  c.treasureFloor = clamp(toInt(c.treasureFloor, 0), [0, c.floors]);
  c.restFloor = clamp(toInt(c.restFloor, 0), [0, c.floors]);
  if (c.treasureFloor === 1 && c.firstFloorFixed) c.treasureFloor = 0;
  if (c.restFloor === c.treasureFloor && c.restFloor !== 0) c.restFloor = 0;

  c.nodeRadius = clamp(toNum(c.nodeRadius, DEFAULT_CONFIG.nodeRadius), LIMITS.nodeRadius);
  c.spacingX = clamp(toNum(c.spacingX, DEFAULT_CONFIG.spacingX), LIMITS.spacingX);
  c.spacingY = clamp(toNum(c.spacingY, DEFAULT_CONFIG.spacingY), LIMITS.spacingY);
  c.edgeWidth = clamp(toNum(c.edgeWidth, DEFAULT_CONFIG.edgeWidth), LIMITS.edgeWidth);
  c.fontSize = clamp(toNum(c.fontSize, DEFAULT_CONFIG.fontSize), LIMITS.fontSize);
  c.jitterX = clamp(toNum(c.jitterX, 0), [0, c.spacingX / 2]);
  c.jitterY = clamp(toNum(c.jitterY, 0), [0, c.spacingY / 2]);
  c.marginX = clamp(toNum(c.marginX, 120), [0, 4000]);
  c.marginY = clamp(toNum(c.marginY, 120), [0, 4000]);
  c.edgeAlpha = clamp(toNum(c.edgeAlpha, 1), [0, 1]);
  c.nodeStrokeWidth = clamp(toNum(c.nodeStrokeWidth, 4), [0, 40]);

  c.maskSymbol = String(c.maskSymbol ?? "?").slice(0, 4) || "?";
  c.maskFill = normalizeColor(c.maskFill, DEFAULT_CONFIG.maskFill);
  c.maskColor = normalizeColor(c.maskColor, DEFAULT_CONFIG.maskColor);
  c.markerColor = normalizeColor(c.markerColor, DEFAULT_CONFIG.markerColor);
  c.revealLookahead = clamp(toInt(c.revealLookahead, 1), [0, 5]);
  if (!["onChoice", "manual"].includes(c.revealMode)) c.revealMode = "onChoice";

  for (const key of [
    "firstFloorFixed",
    "bossEnabled",
    "preventCrossing",
    "preventSmallLoops",
    "noSameTypeAsSoleParent",
    "distinctStarts",
    "forceReachableExit",
    "drawBackground",
    "showSymbols",
    "showLabels",
    "showFloorNumbers",
    "clearPrevious",
    "lockDrawings",
    "createNotes",
    "createJournal",
    "notifyChat",
    "secretNodes",
    "revealFirstFloor",
    "hideEdgesUntilRevealed",
    "showPartyMarker",
    "announceReveal"
  ]) {
    c[key] = toBool(c[key]);
  }

  if (!["up", "down"].includes(c.orientation)) c.orientation = "up";
  if (!["curved", "straight"].includes(c.edgeStyle)) c.edgeStyle = "curved";
  if (!["active", "new"].includes(c.target)) c.target = "active";

  c.nodeTypes = normalizeNodeTypes(c.nodeTypes);

  const ids = new Set(c.nodeTypes.map((t) => t.id));
  const firstRandom = c.nodeTypes.find((t) => !t.reserved && t.weight > 0);
  if (!ids.has(c.firstFloorType)) c.firstFloorType = firstRandom?.id ?? c.nodeTypes[0].id;
  if (!ids.has(c.bossType)) c.bossType = c.nodeTypes[c.nodeTypes.length - 1].id;

  c.seed = String(c.seed ?? "").trim();
  return c;
}

/**
 * Sanitiza a lista de tipos de nó, garantindo ids únicos e campos completos.
 * @param {any[]} list
 * @returns {NodeType[]}
 */
export function normalizeNodeTypes(list) {
  const source = Array.isArray(list) && list.length ? list : DEFAULT_NODE_TYPES;
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object") continue;
    let id = String(raw.id ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) id = `type-${out.length + 1}`;
    let unique = id;
    let n = 2;
    while (seen.has(unique)) unique = `${id}-${n++}`;
    seen.add(unique);

    out.push({
      id: unique,
      label: String(raw.label ?? unique),
      symbol: String(raw.symbol ?? "•").slice(0, 4),
      color: normalizeColor(raw.color, "#f0e6d2"),
      fill: normalizeColor(raw.fill, "#5a4632"),
      icon: String(raw.icon ?? "").trim(),
      weight: Math.max(0, toNum(raw.weight, 0)),
      minFloor: Math.max(1, toInt(raw.minFloor, 1)),
      maxPerFloor: Math.max(0, toInt(raw.maxPerFloor, 0)),
      maxTotal: Math.max(0, toInt(raw.maxTotal, 0)),
      noRepeatOnPath: toBool(raw.noRepeatOnPath),
      reserved: toBool(raw.reserved)
    });
  }
  return out.length ? out : DEFAULT_NODE_TYPES.map((t) => ({ ...t }));
}

/** Garante uma cor hexadecimal `#rrggbb`. */
export function normalizeColor(value, fallback) {
  const v = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return fallback;
}

/**
 * Gera um mapa completo.
 * @param {object} [inputConfig] configuração parcial (será normalizada)
 * @returns {SpireMap}
 */
export function generateMap(inputConfig = {}) {
  const config = normalizeConfig(inputConfig);
  const seed = config.seed || randomSeedString();
  const rng = new Rng(seed);
  const warnings = [];

  const lattice = buildLattice(config, rng, warnings);
  const totalFloors = config.floors + (config.bossEnabled ? 1 : 0);

  if (config.bossEnabled) attachBoss(lattice, config, totalFloors);

  const nodes = [...lattice.nodes.values()];
  assignTypes(nodes, lattice, config, rng, totalFloors);
  const bounds = layout(nodes, config, rng, totalFloors);

  const byFloor = Array.from({ length: totalFloors }, () => []);
  for (const node of nodes) byFloor[node.floor - 1].push(node);
  for (const floorNodes of byFloor) floorNodes.sort((a, b) => a.col - b.col);

  const counts = {};
  for (const node of nodes) counts[node.typeId] = (counts[node.typeId] ?? 0) + 1;

  return {
    seed,
    config,
    totalFloors,
    nodes,
    byFloor,
    edges: lattice.edges,
    bounds,
    counts,
    warnings
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Estrutura (caminhos e arestas)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Constrói a treliça de nós/arestas percorrendo `config.paths` caminhos de baixo para cima.
 * @returns {{nodes: Map<string, MapNode>, edges: {from:string,to:string}[], edgesByFloor: Map<number, {a:number,b:number}[]>}}
 */
function buildLattice(config, rng, warnings) {
  /** @type {Map<string, MapNode>} */
  const nodes = new Map();
  /** @type {{from:string,to:string}[]} */
  const edges = [];
  /** arestas agrupadas pelo andar de origem, guardando apenas as colunas */
  const edgesByFloor = new Map();
  const edgeKeys = new Set();

  const ensureNode = (floor, col) => {
    const id = nodeId(floor, col);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id,
        floor,
        col,
        typeId: null,
        x: 0,
        y: 0,
        parents: [],
        children: [],
        isBoss: false
      };
      nodes.set(id, node);
    }
    return node;
  };

  const addEdge = (floor, a, b) => {
    const from = nodeId(floor, a);
    const to = nodeId(floor + 1, b);
    const key = `${from}>${to}`;
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    edges.push({ from, to });
    nodes.get(from).children.push(to);
    nodes.get(to).parents.push(from);
    if (!edgesByFloor.has(floor)) edgesByFloor.set(floor, []);
    edgesByFloor.get(floor).push({ a, b });
    return true;
  };

  const usedStarts = new Set();

  for (let p = 0; p < config.paths; p++) {
    let col = pickStartColumn(config, rng, usedStarts, p);
    usedStarts.add(col);
    ensureNode(1, col);

    for (let floor = 1; floor < config.floors; floor++) {
      let candidates = legalMoves(config, nodes, edgesByFloor, floor, col);
      if (!candidates.length && config.preventSmallLoops) {
        // Relaxa primeiro a regra estética (loops curtos), preservando o anti-cruzamento.
        candidates = legalMoves({ ...config, preventSmallLoops: false }, nodes, edgesByFloor, floor, col);
      }
      if (!candidates.length && config.preventCrossing) {
        candidates = legalMoves(
          { ...config, preventSmallLoops: false, preventCrossing: false },
          nodes,
          edgesByFloor,
          floor,
          col
        );
        if (candidates.length) warnings.push(`path:${p} floor:${floor} anti-cruzamento relaxado`);
      }
      if (!candidates.length) {
        // Fallback final: segue reto (só acontece em grades degeneradas).
        warnings.push(`path:${p} floor:${floor} sem movimento legal`);
        ensureNode(floor + 1, col);
        addEdge(floor, col, col);
        continue;
      }
      // Prefere criar arestas novas para diversificar o traçado, como no jogo original.
      const fresh = candidates.filter((c) => !edgeKeys.has(`${nodeId(floor, col)}>${nodeId(floor + 1, c)}`));
      const next = rng.pick(fresh.length ? fresh : candidates);
      ensureNode(floor + 1, next);
      addEdge(floor, col, next);
      col = next;
    }
  }

  if (config.forceReachableExit) pruneDeadEnds(nodes, edges, edgesByFloor, config);

  return { nodes, edges, edgesByFloor };
}

/** Escolhe a coluna inicial de um caminho, forçando inícios distintos quando possível. */
function pickStartColumn(config, rng, usedStarts, pathIndex) {
  const all = Array.from({ length: config.columns }, (_, i) => i);
  if (config.distinctStarts && usedStarts.size < config.columns) {
    // Os dois primeiros caminhos sempre começam em colunas diferentes (regra do jogo).
    const free = all.filter((c) => !usedStarts.has(c));
    if (pathIndex < 2 || rng.float() < 0.7) return rng.pick(free);
  }
  return rng.pick(all);
}

/**
 * Movimentos legais de (floor, col) para o andar seguinte.
 * Aplica anti-cruzamento e anti-loop-curto.
 * @returns {number[]} colunas válidas
 */
function legalMoves(config, nodes, edgesByFloor, floor, col) {
  const existing = edgesByFloor.get(floor) ?? [];
  const out = [];

  for (const delta of [-1, 0, 1]) {
    const next = col + delta;
    if (next < 0 || next >= config.columns) continue;

    // (a) Anti-cruzamento: duas arestas do mesmo intervalo de andares não podem trocar de ordem.
    if (config.preventCrossing) {
      const crosses = existing.some((e) => (e.a - col) * (e.b - next) < 0);
      if (crosses) continue;
    }

    // (b) Anti-loop-curto: evita "diamantes" de 4 nós entre andares consecutivos.
    if (config.preventSmallLoops && floor > 1) {
      const target = nodes.get(nodeId(floor + 1, next));
      const self = nodes.get(nodeId(floor, col));
      if (target && self) {
        const selfGrandparents = new Set(self.parents);
        const conflict = target.parents.some((pid) => {
          if (pid === self.id) return false;
          const sibling = nodes.get(pid);
          return sibling?.parents.some((gp) => selfGrandparents.has(gp));
        });
        if (conflict) continue;
      }
    }

    out.push(next);
  }
  return out;
}

/**
 * Remove nós órfãos (sem pais acima do andar 1) ou sem filhos antes do último andar.
 * Necessário apenas em configurações extremas; mantém o mapa sempre percorrível.
 */
function pruneDeadEnds(nodes, edges, edgesByFloor, config) {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    for (const node of [...nodes.values()]) {
      const orphan = node.floor > 1 && node.parents.length === 0;
      const dead = node.floor < config.floors && node.children.length === 0;
      if (!orphan && !dead) continue;
      removeNode(nodes, edges, edgesByFloor, node);
      changed = true;
    }
  }
}

function removeNode(nodes, edges, edgesByFloor, node) {
  for (const pid of node.parents) {
    const parent = nodes.get(pid);
    if (parent) parent.children = parent.children.filter((c) => c !== node.id);
  }
  for (const cid of node.children) {
    const child = nodes.get(cid);
    if (child) child.parents = child.parents.filter((p) => p !== node.id);
  }
  for (let i = edges.length - 1; i >= 0; i--) {
    if (edges[i].from === node.id || edges[i].to === node.id) edges.splice(i, 1);
  }
  const below = edgesByFloor.get(node.floor - 1);
  if (below) {
    edgesByFloor.set(
      node.floor - 1,
      below.filter((e) => e.b !== node.col)
    );
  }
  const above = edgesByFloor.get(node.floor);
  if (above) {
    edgesByFloor.set(
      node.floor,
      above.filter((e) => e.a !== node.col)
    );
  }
  nodes.delete(node.id);
}

/** Cria o nó do boss no topo e liga todos os nós do último andar a ele. */
function attachBoss(lattice, config, totalFloors) {
  const col = Math.floor((config.columns - 1) / 2);
  const boss = {
    id: nodeId(totalFloors, col),
    floor: totalFloors,
    col,
    typeId: config.bossType,
    x: 0,
    y: 0,
    parents: [],
    children: [],
    isBoss: true
  };
  lattice.nodes.set(boss.id, boss);

  for (const node of lattice.nodes.values()) {
    if (node.floor !== config.floors || node.isBoss) continue;
    node.children.push(boss.id);
    boss.parents.push(node.id);
    lattice.edges.push({ from: node.id, to: boss.id });
  }
}

/* -------------------------------------------------------------------------- */
/*  2. Atribuição de tipos                                                     */
/* -------------------------------------------------------------------------- */

function assignTypes(nodes, lattice, config, rng, totalFloors) {
  const types = config.nodeTypes;
  const byId = new Map(types.map((t) => [t.id, t]));
  const totalCount = {};
  const floorCount = {};
  const restType = types.find((t) => t.id === "rest") ?? null;

  const bump = (typeId, floor) => {
    totalCount[typeId] = (totalCount[typeId] ?? 0) + 1;
    const key = `${floor}:${typeId}`;
    floorCount[key] = (floorCount[key] ?? 0) + 1;
  };

  // Processa de baixo para cima: os pais já têm tipo quando o filho é sorteado.
  const ordered = [...nodes].sort((a, b) => a.floor - b.floor || a.col - b.col);

  for (const node of ordered) {
    if (node.isBoss) {
      node.typeId = config.bossType;
      bump(node.typeId, node.floor);
      continue;
    }
    if (config.firstFloorFixed && node.floor === 1) {
      node.typeId = config.firstFloorType;
      bump(node.typeId, node.floor);
      continue;
    }
    if (config.treasureFloor && node.floor === config.treasureFloor) {
      node.typeId = byId.has("treasure") ? "treasure" : fallbackType(types).id;
      bump(node.typeId, node.floor);
      continue;
    }
    if (config.restFloor && node.floor === config.restFloor) {
      node.typeId = restType ? restType.id : fallbackType(types).id;
      bump(node.typeId, node.floor);
      continue;
    }

    const parentTypes = node.parents
      .map((pid) => lattice.nodes.get(pid)?.typeId)
      .filter(Boolean);

    const legal = types.filter((type) => {
      if (type.reserved || type.weight <= 0) return false;
      if (node.floor < type.minFloor) return false;
      if (type.maxTotal && (totalCount[type.id] ?? 0) >= type.maxTotal) return false;
      if (type.maxPerFloor && (floorCount[`${node.floor}:${type.id}`] ?? 0) >= type.maxPerFloor) {
        return false;
      }
      if (type.noRepeatOnPath && parentTypes.includes(type.id)) return false;
      if (config.noSameTypeAsSoleParent && parentTypes.length === 1 && parentTypes[0] === type.id) {
        return false;
      }
      // Regra do jogo: não colocar descanso imediatamente antes do andar de descanso/boss.
      if (
        type.id === "rest" &&
        config.restFloor &&
        node.floor === config.restFloor - 1 &&
        config.restFloor > 1
      ) {
        return false;
      }
      return true;
    });

    const chosen =
      rng.weighted(legal, (t) => t.weight) ??
      // Relaxa as restrições em cascata para nunca deixar um nó sem tipo.
      rng.weighted(
        types.filter((t) => !t.reserved && t.weight > 0 && node.floor >= t.minFloor),
        (t) => t.weight
      ) ??
      fallbackType(types);

    node.typeId = chosen.id;
    bump(node.typeId, node.floor);
  }
}

function fallbackType(types) {
  return (
    types.find((t) => !t.reserved && t.weight > 0) ??
    types.find((t) => !t.reserved) ??
    types[0]
  );
}

/* -------------------------------------------------------------------------- */
/*  3. Layout (pixels)                                                         */
/* -------------------------------------------------------------------------- */

function layout(nodes, config, rng, totalFloors) {
  const width = Math.round(config.marginX * 2 + (config.columns - 1) * config.spacingX);
  const height = Math.round(config.marginY * 2 + (totalFloors - 1) * config.spacingY);

  for (const node of nodes) {
    const jx = config.jitterX ? rng.range(-config.jitterX, config.jitterX) : 0;
    const jy = config.jitterY ? rng.range(-config.jitterY, config.jitterY) : 0;
    const rowIndex = config.orientation === "up" ? totalFloors - node.floor : node.floor - 1;

    node.x = Math.round(config.marginX + node.col * config.spacingX + (node.isBoss ? 0 : jx));
    node.y = Math.round(config.marginY + rowIndex * config.spacingY + (node.isBoss ? 0 : jy));
  }

  return { width, height };
}

/* -------------------------------------------------------------------------- */
/*  Utilidades expostas                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pontos de uma aresta, já em coordenadas absolutas.
 * Curvas são amostradas como uma Bézier quadrática suave.
 * @param {MapNode} from
 * @param {MapNode} to
 * @param {object} config
 * @returns {{x:number,y:number}[]}
 */
export function edgePoints(from, to, config) {
  const r = config.nodeRadius / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const start = { x: from.x + ux * r, y: from.y + uy * r };
  const end = { x: to.x - ux * r, y: to.y - uy * r };

  if (config.edgeStyle === "straight") return [start, end];

  // Controle deslocado perpendicularmente, proporcional ao desvio horizontal.
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const bend = Math.min(Math.abs(dx) * 0.28, config.spacingY * 0.35);
  const sign = dx === 0 ? 0 : Math.sign(dx);
  const ctrl = { x: mid.x - sign * bend * 0.35, y: mid.y + (uy > 0 ? -bend : bend) * 0.5 };

  const steps = 10;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * start.x + 2 * mt * t * ctrl.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * ctrl.y + t * t * end.y
    });
  }
  return pts;
}

/**
 * Verifica se existe pelo menos um caminho do andar 1 até o topo.
 * @param {SpireMap} map
 * @returns {boolean}
 */
export function isTraversable(map) {
  const index = new Map(map.nodes.map((n) => [n.id, n]));
  const start = map.byFloor[0] ?? [];
  const target = map.totalFloors;
  const stack = [...start];
  const seen = new Set(stack.map((n) => n.id));
  while (stack.length) {
    const node = stack.pop();
    if (node.floor === target) return true;
    for (const cid of node.children) {
      if (seen.has(cid)) continue;
      seen.add(cid);
      const child = index.get(cid);
      if (child) stack.push(child);
    }
  }
  return false;
}
