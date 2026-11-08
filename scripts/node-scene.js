/**
 * Cena do mundo associada a um nó.
 *
 * Qualquer nó do mapa pode apontar para uma cena (o combate, a loja, o acampamento...). Ao
 * ativá-la, o módulo coloca nela os tokens dos personagens dos jogadores — os que ainda não
 * estão lá — e ativa a cena para todos. Voltar ao mapa é ativar de novo a cena do mapa.
 *
 * Um **tipo** de sala também pode ter uma cena (a Loja sempre abre a mesma cena, por exemplo).
 * Ela fica num setting do mundo, vale para todo mapa e para todo nó desse tipo — inclusive a
 * sala "?" que o Mestre definiu como desse tipo. A cena do próprio nó, quando existe, tem
 * prioridade sobre a do tipo.
 *
 * @module spire-map/node-scene
 */

import { MODULE_ID, SETTINGS } from "./constants.js";
import { sceneOf, indexNodes } from "./progress.js";

/* -------------------------------------------------------------------------- */
/*  Cena por tipo de sala                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cenas associadas aos tipos de sala.
 * @returns {{typeId:string, uuid:string, name:string, img:string}[]}
 */
export function typeScenes() {
  try {
    const list = game.settings.get(MODULE_ID, SETTINGS.TYPE_SCENES);
    return Array.isArray(list) ? list.filter((e) => e?.typeId && e?.uuid) : [];
  } catch (err) {
    return [];
  }
}

/** Cena associada a um tipo de sala, ou `null`. */
export function typeSceneOf(typeId, list = typeScenes()) {
  return list.find((e) => e.typeId === typeId) ?? null;
}

/**
 * Associa uma cena a um tipo de sala (`scene` vazio desfaz).
 * @param {string} typeId
 * @param {{uuid:string, name:string, img?:string}|null} scene
 */
export async function setTypeScene(typeId, scene) {
  if (!typeId) return;
  const list = typeScenes().filter((e) => e.typeId !== typeId);
  if (scene?.uuid) {
    list.push({
      typeId: String(typeId),
      uuid: String(scene.uuid),
      name: String(scene.name ?? "").trim().slice(0, 120) || "?",
      img: String(scene.img ?? "")
    });
  }
  await game.settings.set(MODULE_ID, SETTINGS.TYPE_SCENES, list);
}

/**
 * Tipo efetivo de um nó para escolher a cena: o tipo definido da sala "?", se houver.
 * @returns {string|null}
 */
export function effectiveTypeId(map, progress, node) {
  if (!node) return null;
  const resolution = (progress?.resolved ?? []).find((r) => r.id === node.id);
  if (resolution && map?.config?.nodeTypes?.some((t) => t.id === resolution.typeId)) return resolution.typeId;
  return node.typeId ?? null;
}

/**
 * Cena que o nó abre: a do próprio nó ou, sem ela, a do tipo da sala.
 * @param {object} map
 * @param {object} progress
 * @param {string} nodeId
 * @param {object[]} [list] cenas por tipo (para não reler o setting a cada nó)
 * @returns {{uuid:string, name:string, img:string, source:"node"|"type", typeId?:string}|null}
 */
export function nodeSceneEntry(map, progress, nodeId, list = typeScenes()) {
  const own = sceneOf(progress, nodeId);
  if (own) return { ...own, source: "node" };
  const node = map ? indexNodes(map).get(nodeId) : null;
  const typeId = effectiveTypeId(map, progress, node);
  const byType = typeId ? typeSceneOf(typeId, list) : null;
  return byType ? { ...byType, source: "type" } : null;
}

/**
 * Personagens dos jogadores: o personagem atribuído a cada jogador conectado. Sem nenhum
 * jogador conectado (o Mestre preparando sozinho), vale o de todos os jogadores.
 * @returns {Actor[]}
 */
export function partyActors() {
  const players = game.users.filter((u) => !u.isGM && u.character);
  const online = players.filter((u) => u.active);
  const actors = (online.length ? online : players).map((u) => u.character);
  return [...new Map(actors.map((a) => [a.id, a])).values()];
}

/**
 * Coloca os tokens dos personagens dos jogadores em uma cena, em formação ao redor do ponto
 * inicial da cena (ou do centro, se ela não tiver um). Quem já tem token na cena fica onde está.
 * @param {Scene} scene
 * @returns {Promise<{placed:number, skipped:number}>}
 */
export async function placePartyTokens(scene) {
  const actors = partyActors();
  const missing = actors.filter((a) => !scene.tokens.some((t) => t.actorId === a.id));
  if (!missing.length) return { placed: 0, skipped: actors.length };

  const size = scene.grid?.size ?? 100;
  const rect = scene.dimensions?.sceneRect ?? { x: 0, y: 0, width: size * 10, height: size * 10 };
  const initial = scene.initial;
  const cx = Number.isFinite(initial?.x) ? initial.x : rect.x + rect.width / 2;
  const cy = Number.isFinite(initial?.y) ? initial.y : rect.y + rect.height / 2;

  // Grade quadrada; cada célula comporta o maior token do grupo.
  const span = Math.max(1, ...missing.map((a) => Number(a.prototypeToken?.width) || 1)) * size;
  const cols = Math.ceil(Math.sqrt(missing.length));
  const rows = Math.ceil(missing.length / cols);
  const snap = (v) => Math.round(v / size) * size;
  const left = snap(cx - (cols * span) / 2);
  const top = snap(cy - (rows * span) / 2);

  const data = [];
  for (const [i, actor] of missing.entries()) {
    const x = left + (i % cols) * span;
    const y = top + Math.floor(i / cols) * span;
    const doc = await actor.getTokenDocument({ x, y, hidden: false });
    data.push(doc.toObject());
  }
  await scene.createEmbeddedDocuments("Token", data);
  return { placed: data.length, skipped: actors.length - data.length };
}

/**
 * Ativa a cena associada a um nó (a dele ou a do tipo da sala), levando os tokens dos
 * jogadores para ela.
 * @param {object} progress progresso do mapa (de onde sai a associação)
 * @param {string} nodeId
 * @param {object} [map] mapa — sem ele, só vale a cena do próprio nó
 * @returns {Promise<{ok:boolean, error?:string, scene?:Scene, placed?:number}>}
 */
export async function activateNodeScene(progress, nodeId, map = null) {
  if (!game.user.isGM) return { ok: false, error: "notGM" };
  const entry = nodeSceneEntry(map, progress, nodeId);
  if (!entry) return { ok: false, error: "noScene" };

  let scene = null;
  try {
    scene = await fromUuid(entry.uuid);
  } catch (err) {
    scene = null;
  }
  if (!(scene instanceof Scene)) return { ok: false, error: "missingScene" };

  const { placed } = await placePartyTokens(scene);
  await scene.activate();
  return { ok: true, scene, placed };
}

/** A cena do nó deve ser ativada sozinha quando o grupo entra nele? */
export function autoActivateEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, SETTINGS.AUTO_NODE_SCENE));
  } catch (err) {
    return false;
  }
}
