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
 *  - `unlocked` — caminhos secretos já liberados. Enquanto o caminho está trancado, seus nós
 *                 e arestas não existem para os jogadores (nem como "?").
 *  - `resolved` — salas "?" cujo tipo real o Mestre definiu (tipo + apelido + descrição).
 *  - `adversaries` — adversário vinculado a um nó de boss, e se já foi derrotado.
 *  - `scenes`   — cena do mundo associada a um nó (qualquer nó), ativada quando o grupo chega lá.
 *
 * Os quatro últimos são **listas** de propósito: `Scene#setFlag` mescla objetos, então uma
 * entrada removida de um objeto voltaria a aparecer; listas são substituídas por inteiro.
 * Progresso gravado por versões anteriores não tem esses campos — todos valem `[]`.
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
 * @property {number[]} [unlocked]
 * @property {{id:string,typeId:string,alias:string,description:string}[]} [resolved]
 * @property {{id:string,uuid:string,name:string,img:string,defeated:boolean,defeatedAt:number|null}[]} [adversaries]
 * @property {{id:string,uuid:string,name:string,img:string}[]} [scenes]
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
 * Nós de caminhos secretos ainda trancados.
 * @param {import("./generator.js").SpireMap} map
 * @param {Progress|null} [progress]
 * @returns {Set<string>}
 */
export function lockedNodes(map, progress) {
  const unlocked = new Set(progress?.unlocked ?? []);
  const out = new Set();
  for (const node of map.nodes) {
    if (node.secretPath && !unlocked.has(node.secretPath)) out.add(node.id);
  }
  return out;
}

/**
 * Nós que o grupo pode escolher a partir da posição atual.
 * @param {import("./generator.js").SpireMap} map
 * @param {string|null} current
 * @param {Progress|null} [progress] se informado, deixa de fora os caminhos secretos trancados
 * @returns {string[]}
 */
export function availableFrom(map, current, progress = null) {
  if (!current) return (map.byFloor[0] ?? []).map((n) => n.id);
  const node = indexNodes(map).get(current);
  if (!node) return [];
  const locked = lockedNodes(map, progress);
  return node.children.filter((id) => !locked.has(id));
}

/**
 * Expande um conjunto de sementes por `depth` níveis de filhos.
 * `depth = 0` devolve apenas as sementes.
 * @param {Progress|null} [progress] se informado, não atravessa caminhos secretos trancados
 * @returns {Set<string>}
 */
export function expandForward(map, seeds, depth, progress = null) {
  const index = indexNodes(map);
  const locked = lockedNodes(map, progress);
  const out = new Set(seeds);
  let frontier = [...seeds];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) {
      for (const child of index.get(id)?.children ?? []) {
        if (locked.has(child)) continue;
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
    lookahead: Number(config.revealLookahead ?? 1),
    unlocked: [],
    resolved: [],
    adversaries: [],
    scenes: []
  };

  if (!config.secretNodes) {
    progress.revealed = map.nodes.filter((n) => !n.secretPath).map((n) => n.id);
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
      : availableFrom(map, progress.current, progress);
    for (const id of expandForward(map, seeds, look - 1, progress)) revealed.add(id);
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
 * @returns {{progress: Progress, revealedNow: string[], unlockedNow: number[], error: string|null}}
 */
export function advanceTo(map, progress, nodeId, options = {}) {
  const index = indexNodes(map);
  const node = index.get(nodeId);
  if (!node) return { progress, revealedNow: [], unlockedNow: [], error: "unknownNode" };

  const allowed = new Set(progress.available ?? []);
  if (!options.force && allowed.size && !allowed.has(nodeId)) {
    return { progress, revealedNow: [], unlockedNow: [], error: "notAvailable" };
  }

  const before = new Set(progress.revealed ?? []);
  const order = Array.isArray(progress._order) ? [...progress._order] : [];
  if (!order.includes(nodeId)) order.push(nodeId);

  // Escolher o nó-chave libera os caminhos secretos vinculados a ele. Entrar à força em um
  // nó de um caminho ainda trancado também o libera (o grupo está lá dentro).
  const unlocked = new Set(progress.unlocked ?? []);
  const unlockedNow = [];
  for (const path of map.secretPaths ?? []) {
    if (unlocked.has(path.id)) continue;
    if (path.key === nodeId || node.secretPath === path.id) {
      unlocked.add(path.id);
      unlockedNow.push(path.id);
    }
  }

  const next = {
    ...progress,
    visited: sortIds(map, [...(progress.visited ?? []), nodeId]),
    current: nodeId,
    unlocked: [...unlocked].sort((a, b) => a - b),
    _order: order
  };
  next.available = availableFrom(map, nodeId, next);
  next.revealed = applyLookahead(map, next);

  return {
    progress: next,
    revealedNow: next.revealed.filter((id) => !before.has(id)),
    unlockedNow,
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
    available: availableFrom(map, current, progress),
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

/** Revela o mapa inteiro (caminhos secretos trancados continuam trancados). */
export function revealAll(map, progress) {
  const locked = lockedNodes(map, progress);
  const keep = (progress?.revealed ?? []).filter((id) => locked.has(id));
  return {
    ...progress,
    revealed: sortIds(map, [...keep, ...map.nodes.filter((n) => !locked.has(n.id)).map((n) => n.id)])
  };
}

/** Revela um andar inteiro (menos os nós de caminhos secretos trancados). */
export function revealFloor(map, progress, floor) {
  const locked = lockedNodes(map, progress);
  const ids = (map.byFloor[floor - 1] ?? []).map((n) => n.id).filter((id) => !locked.has(id));
  return reveal(map, progress, ids);
}

/** Oculta tudo que o grupo não visitou (mantém a posição atual). */
export function hideUnvisited(map, progress) {
  const keep = new Set(progress.visited ?? []);
  const next = { ...progress, revealed: sortIds(map, [...keep]) };
  next.revealed = applyLookahead(map, next);
  return next;
}

/**
 * Zera o progresso, voltando ao estado inicial do mapa.
 *
 * Os caminhos secretos voltam a ficar trancados e os adversários deixam de constar como
 * derrotados. O que o Mestre preparou — tipo definido das salas "?", adversário vinculado ao
 * boss e cenas associadas aos nós — é mantido: só aparece para os jogadores quando o grupo chegar lá de novo.
 */
export function resetProgress(map, progress, config) {
  const fresh = createProgress(map, { ...config, revealMode: progress.mode, revealLookahead: progress.lookahead }, progress.mapId);
  return {
    ...fresh,
    resolved: [...(progress.resolved ?? [])],
    adversaries: (progress.adversaries ?? []).map((a) => ({ ...a, defeated: false, defeatedAt: null })),
    scenes: [...(progress.scenes ?? [])],
    _order: []
  };
}

/* -------------------------------------------------------------------------- */
/*  Caminhos secretos                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Libera ou tranca um caminho secreto manualmente.
 * @param {number} pathId
 * @param {boolean} [state] true = liberar, false = trancar; omitido = alternar
 */
export function setSecretPath(map, progress, pathId, state) {
  const id = Number(pathId);
  if (!(map.secretPaths ?? []).some((p) => p.id === id)) return progress;
  const unlocked = new Set(progress.unlocked ?? []);
  const open = state === undefined ? !unlocked.has(id) : Boolean(state);
  if (open) unlocked.add(id);
  else unlocked.delete(id);

  const next = { ...progress, unlocked: [...unlocked].sort((a, b) => a - b) };
  next.available = availableFrom(map, next.current, next);
  next.revealed = applyLookahead(map, next);
  return next;
}

/* -------------------------------------------------------------------------- */
/*  Salas "?" com tipo definido na hora                                       */
/* -------------------------------------------------------------------------- */

/** O tipo do nó é uma sala "?" que o Mestre resolve ao ser escolhida? */
export function isResolvable(map, node) {
  const type = map.config.nodeTypes.find((ty) => ty.id === node?.typeId);
  if (!type) return false;
  return type.resolvable === undefined ? type.id === "event" : Boolean(type.resolvable);
}

/**
 * Define o que uma sala "?" realmente é: um dos tipos do módulo, mais um apelido e uma
 * descrição livres. Os jogadores só veem isso depois que o grupo entra na sala.
 *
 * @param {string} nodeId
 * @param {{typeId:string, alias?:string, description?:string}} data
 * @returns {{progress: Progress, error: string|null}}
 */
export function setResolution(map, progress, nodeId, data = {}) {
  const node = indexNodes(map).get(nodeId);
  if (!node) return { progress, error: "unknownNode" };
  if (!map.config.nodeTypes.some((ty) => ty.id === data.typeId)) {
    return { progress, error: "unknownType" };
  }
  const entry = {
    id: nodeId,
    typeId: data.typeId,
    alias: String(data.alias ?? "").trim().slice(0, 80),
    description: String(data.description ?? "").trim().slice(0, 4000)
  };
  const resolved = (progress.resolved ?? []).filter((r) => r.id !== nodeId);
  resolved.push(entry);
  return { progress: { ...progress, resolved }, error: null };
}

/** Desfaz a definição de uma sala "?". */
export function clearResolution(map, progress, nodeId) {
  return { ...progress, resolved: (progress.resolved ?? []).filter((r) => r.id !== nodeId) };
}

/* -------------------------------------------------------------------------- */
/*  Adversário do boss                                                        */
/* -------------------------------------------------------------------------- */

/** O nó aceita um adversário vinculado? (nó de boss, ou qualquer nó do tipo de boss) */
export function isBossNode(map, node) {
  return Boolean(node) && (Boolean(node.isBoss) || node.typeId === map.config.bossType);
}

/** Adversário vinculado a um nó, ou `null`. */
export function adversaryOf(progress, nodeId) {
  return (progress?.adversaries ?? []).find((a) => a.id === nodeId) ?? null;
}

/**
 * Vincula um adversário (ator) a um nó. Substitui o anterior.
 * @param {{uuid?:string, name:string, img?:string}} actor
 */
export function setAdversary(map, progress, nodeId, actor = {}) {
  if (!indexNodes(map).has(nodeId)) return progress;
  const entry = {
    id: nodeId,
    uuid: String(actor.uuid ?? ""),
    name: String(actor.name ?? "").trim().slice(0, 120) || "?",
    img: String(actor.img ?? ""),
    defeated: false,
    defeatedAt: null
  };
  const adversaries = (progress.adversaries ?? []).filter((a) => a.id !== nodeId);
  adversaries.push(entry);
  return { ...progress, adversaries };
}

/** Remove o adversário de um nó. */
export function clearAdversary(map, progress, nodeId) {
  return { ...progress, adversaries: (progress.adversaries ?? []).filter((a) => a.id !== nodeId) };
}

/** Marca (ou desmarca) o adversário de um nó como derrotado. */
export function setAdversaryDefeated(map, progress, nodeId, defeated = true, at = Date.now()) {
  return {
    ...progress,
    adversaries: (progress.adversaries ?? []).map((a) =>
      a.id === nodeId ? { ...a, defeated: Boolean(defeated), defeatedAt: defeated ? at : null } : a
    )
  };
}

/* -------------------------------------------------------------------------- */
/*  Cena associada ao nó                                                      */
/* -------------------------------------------------------------------------- */

/** Cena do mundo associada a um nó, ou `null`. */
export function sceneOf(progress, nodeId) {
  return (progress?.scenes ?? []).find((s) => s.id === nodeId) ?? null;
}

/**
 * Associa uma cena do mundo a um nó. Substitui a anterior.
 * @param {{uuid:string, name:string, img?:string}} scene
 */
export function setNodeScene(map, progress, nodeId, scene = {}) {
  if (!indexNodes(map).has(nodeId) || !scene.uuid) return progress;
  const entry = {
    id: nodeId,
    uuid: String(scene.uuid),
    name: String(scene.name ?? "").trim().slice(0, 120) || "?",
    img: String(scene.img ?? "")
  };
  const scenes = (progress.scenes ?? []).filter((s) => s.id !== nodeId);
  scenes.push(entry);
  return { ...progress, scenes };
}

/** Remove a cena associada a um nó. */
export function clearNodeScene(map, progress, nodeId) {
  return { ...progress, scenes: (progress.scenes ?? []).filter((s) => s.id !== nodeId) };
}

/* -------------------------------------------------------------------------- */
/*  Exibição                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Devolve uma função `node -> exibição`, a única fonte de verdade sobre **como** um nó aparece:
 * o tipo efetivo (o da sala "?" resolvida, se houver), o apelido e a descrição.
 *
 * Para os jogadores, a definição de uma sala "?" e o nome do adversário só valem depois que
 * o grupo visitou o nó. Com `gmView`, valem sempre.
 *
 * @param {import("./generator.js").SpireMap} map
 * @param {Progress|null} progress
 * @param {{gmView?: boolean}} [options]
 */
export function makeDisplay(map, progress, options = {}) {
  const gmView = Boolean(options.gmView);
  const types = new Map(map.config.nodeTypes.map((ty) => [ty.id, ty]));
  const visited = new Set(progress?.visited ?? []);
  const resolved = new Map((progress?.resolved ?? []).map((r) => [r.id, r]));
  const adversaries = new Map((progress?.adversaries ?? []).map((a) => [a.id, a]));

  return (node) => {
    const baseType = types.get(node.typeId) ?? null;
    const seen = gmView || visited.has(node.id);
    const resolution = resolved.get(node.id) ?? null;
    const applied = Boolean(resolution) && types.has(resolution.typeId) && seen;
    const adversary = adversaries.get(node.id) ?? null;

    let alias = "";
    if (applied && resolution.alias) alias = resolution.alias;
    else if (adversary && seen) alias = adversary.defeated ? `☠ ${adversary.name}` : adversary.name;

    return {
      baseType,
      type: applied ? types.get(resolution.typeId) : baseType,
      resolved: applied,
      resolution,
      alias,
      description: applied ? resolution.description : "",
      adversary
    };
  };
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
    gmView: Boolean(options.gmView),
    locked: lockedNodes(map, progress),
    display: makeDisplay(map, progress, { gmView: Boolean(options.gmView) })
  };
}

/** Resumo numérico para o painel. */
export function progressSummary(map, progress) {
  // Caminhos secretos trancados ficam fora da conta: para os jogadores eles não existem.
  const locked = lockedNodes(map, progress);
  const total = map.nodes.length - locked.size;
  const revealed = (progress?.revealed ?? []).filter((id) => !locked.has(id)).length;
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
