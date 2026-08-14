/**
 * Estado de revelação e progresso do grupo.
 *
 * Toda a lógica aqui é **pura** (nenhuma API do Foundry): recebe o mapa e um objeto
 * de progresso e devolve um novo objeto de progresso. Quem persiste isso na flag da
 * cena e sincroniza os desenhos é o `scene-painter.js`.
 *
 * Conceitos:
 *  - `visited`  — nós por onde o grupo já passou.
 *  - `current`  — onde o grupo está agora (o último visitado).
 *  - `available`— nós que o grupo pode escolher a seguir (filhos do atual; no início,
 *                 os nós do primeiro andar).
 *  - `revealed` — nós cujo conteúdo os jogadores conhecem. A revelação é **monotônica**:
 *                 nunca se retira informação por acidente (só com uma ação explícita).
 *
 * @module spire-map/progress
 */

import { NODE_STATE } from "./constants.js";

/**
 * @typedef {object} Progress
 * @property {string}   mapId
 * @property {string[]} revealed
 * @property {string[]} visited
 * @property {string[]} available
 * @property {string|null} current
 * @property {string}   mode      "onChoice" | "manual"
 * @property {number}   lookahead
 */

/** Índice id -> nó. */
export function indexNodes(map) {
  return new Map(map.nodes.map((n) => [n.id, n]));
}

/** Ordena ids de forma estável (andar, coluna) para armazenamento previsível. */
function sortIds(map, ids) {
  const index = indexNodes(map);
  return [...new Set(ids)]
    .filter((id) => index.has(id))
    .sort((a, b) => {
      const na = index.get(a);
      const nb = index.get(b);
      return na.floor - nb.floor || na.col - nb.col;
    });
}

/**
 * Nós que o grupo pode escolher a partir da posição atual.
 * @param {import("./generator.js").SpireMap} map
 * @param {string|null} current
 * @returns {string[]}
 */
export function availableFrom(map, current) {
  if (!current) return (map.byFloor[0] ?? []).map((n) => n.id);
  const node = indexNodes(map).get(current);
  return node ? [...node.children] : [];
}

/**
 * Expande um conjunto de sementes por `depth` níveis de filhos.
 * `depth = 0` devolve apenas as sementes.
 * @returns {Set<string>}
 */
export function expandForward(map, seeds, depth) {
  const index = indexNodes(map);
  const out = new Set(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      for (const child of index.get(id)?.children ?? []) {
        if (!out.has(child)) {
          out.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

/**
 * Cria o progresso inicial de um mapa recém-desenhado.
 * @param {import("./generator.js").SpireMap} map
 * @param {object} config
 * @param {string} mapId
 * @returns {Progress}
 */
export function createProgress(map, config, mapId) {
  const progress = {
    mapId,
    revealed: [],
    visited: [],
    available: availableFrom(map, null),
    current: null,
    mode: config.revealMode ?? "onChoice",
    lookahead: Number(config.revealLookahead ?? 1)
  };

  if (!config.secretNodes) {
    progress.revealed = map.nodes.map((n) => n.id);
    return progress;
  }
  if (config.revealFirstFloor) progress.revealed = applyLookahead(map, progress);
  return progress;
}

/**
 * Revelação automática derivada da posição atual (visitados + lookahead a partir das opções).
 * Devolve a lista de revelados já unida à revelação manual existente.
 * @returns {string[]}
 */
export function applyLookahead(map, progress) {
  const revealed = new Set(progress.revealed ?? []);
  for (const id of progress.visited ?? []) revealed.add(id);

  // No modo manual, nada é revelado automaticamente.
  if (progress.mode === "manual") return sortIds(map, [...revealed]);

  // lookahead 0 -> só os visitados; 1 -> as opções atuais; 2+ -> passos além delas.
  const look = Math.max(0, progress.lookahead ?? 0);
  if (look >= 1) {
    const seeds = progress.available?.length
      ? progress.available
      : availableFrom(map, progress.current);
    for (const id of expandForward(map, seeds, look - 1)) revealed.add(id);
  }
  return sortIds(map, [...revealed]);
}

/**
 * Marca o nó escolhido pelos jogadores: ele passa a ser a posição atual, entra em
 * visitados e as novas opções são calculadas (e reveladas conforme o lookahead).
 *
 * @param {import("./generator.js").SpireMap} map
 * @param {Progress} progress
 * @param {string} nodeId
 * @param {object} [options]
 * @param {boolean} [options.force] permite escolher um nó fora das opções atuais
 * @returns {{progress: Progress, revealedNow: string[], error: string|null}}
 */
export function advanceTo(map, progress, nodeId, options = {}) {
  const index = indexNodes(map);
  const node = index.get(nodeId);
  if (!node) return { progress, revealedNow: [], error: "unknownNode" };

  const allowed = new Set(progress.available ?? []);
  if (!options.force && allowed.size && !allowed.has(nodeId)) {
    return { progress, revealedNow: [], error: "notAvailable" };
  }

  const before = new Set(progress.revealed ?? []);
  const order = Array.isArray(progress._order) ? [...progress._order] : [];
  if (!order.includes(nodeId)) order.push(nodeId);

  const next = {
    ...progress,
    visited: sortIds(map, [...(progress.visited ?? []), nodeId]),
    current: nodeId,
    available: availableFrom(map, nodeId),
    _order: order
  };
  next.revealed = applyLookahead(map, next);

  return {
    progress: next,
    revealedNow: next.revealed.filter((id) => !before.has(id)),
    error: null
  };
}

/**
 * Desfaz o último avanço: volta a posição para o nó visitado anterior.
 * A informação já revelada é mantida (use `hideUnvisited` para retirá-la).
 */
export function stepBack(map, progress) {
  const visited = [...(progress.visited ?? [])];
  if (!visited.length) return progress;

  // O último visitado é o atual; remove-o e volta para o anterior.
  const order = visitOrder(map, progress);
  const removed = order.pop() ?? progress.current;
  const remaining = order;
  const current = remaining.at(-1) ?? null;

  return {
    ...progress,
    visited: sortIds(map, remaining),
    current,
    available: current ? availableFrom(map, current) : availableFrom(map, null),
    _order: remaining
  };
}

/** Ordem cronológica de visita (guardada em `_order`, com fallback por andar). */
function visitOrder(map, progress) {
  if (Array.isArray(progress._order) && progress._order.length) return [...progress._order];
  const index = indexNodes(map);
  return [...(progress.visited ?? [])].sort(
    (a, b) => (index.get(a)?.floor ?? 0) - (index.get(b)?.floor ?? 0)
  );
}

/** Revela (ou oculta) um nó específico manualmente. */
export function toggleReveal(map, progress, nodeId) {
  const revealed = new Set(progress.revealed ?? []);
  if (revealed.has(nodeId)) revealed.delete(nodeId);
  else revealed.add(nodeId);
  return { ...progress, revealed: sortIds(map, [...revealed]) };
}

/** Revela um conjunto de nós. */
export function reveal(map, progress, nodeIds) {
  return {
    ...progress,
    revealed: sortIds(map, [...(progress.revealed ?? []), ...nodeIds])
  };
}

/** Revela o mapa inteiro. */
export function revealAll(map, progress) {
  return { ...progress, revealed: map.nodes.map((n) => n.id) };
}

/** Revela um andar inteiro. */
export function revealFloor(map, progress, floor) {
  const ids = (map.byFloor[floor - 1] ?? []).map((n) => n.id);
  return reveal(map, progress, ids);
}

/** Oculta tudo que o grupo não visitou (mantém a posição atual). */
export function hideUnvisited(map, progress) {
  const keep = new Set(progress.visited ?? []);
  const next = { ...progress, revealed: sortIds(map, [...keep]) };
  next.revealed = applyLookahead(map, next);
  return next;
}

/** Zera o progresso, voltando ao estado inicial do mapa. */
export function resetProgress(map, progress, config) {
  const fresh = createProgress(map, { ...config, revealMode: progress.mode, revealLookahead: progress.lookahead }, progress.mapId);
  return { ...fresh, _order: [] };
}

/**
 * Estado de cada nó, para exibição.
 * @returns {Map<string, string>} id -> NODE_STATE
 */
export function nodeStates(map, progress) {
  const revealed = new Set(progress?.revealed ?? []);
  const visited = new Set(progress?.visited ?? []);
  const available = new Set(progress?.available ?? []);
  const out = new Map();

  for (const node of map.nodes) {
    let state = NODE_STATE.HIDDEN;
    if (revealed.has(node.id)) state = NODE_STATE.REVEALED;
    if (available.has(node.id)) state = NODE_STATE.AVAILABLE;
    if (visited.has(node.id)) state = NODE_STATE.VISITED;
    if (progress?.current === node.id) state = NODE_STATE.CURRENT;
    out.set(node.id, state);
  }
  return out;
}

/**
 * Objeto de "fog" consumido pelo renderizador SVG.
 * @param {import("./generator.js").SpireMap} map
 * @param {Progress} progress
 * @param {object} [options]
 * @param {boolean} [options.gmView] true = mostra o tipo real dos nós ocultos, esmaecido
 * @returns {object}
 */
export function toFog(map, progress, options = {}) {
  return {
    revealed: new Set(progress?.revealed ?? []),
    visited: new Set(progress?.visited ?? []),
    available: new Set(progress?.available ?? []),
    current: progress?.current ?? null,
    gmView: Boolean(options.gmView)
  };
}

/** Resumo numérico para o painel. */
export function progressSummary(map, progress) {
  const total = map.nodes.length;
  const revealed = (progress?.revealed ?? []).length;
  const visited = (progress?.visited ?? []).length;
  return {
    total,
    revealed,
    visited,
    hidden: total - revealed,
    percent: total ? Math.round((revealed / total) * 100) : 0,
    available: (progress?.available ?? []).length,
    current: progress?.current ?? null
  };
}
