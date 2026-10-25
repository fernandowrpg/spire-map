/**
 * Cena do mundo associada a um nó.
 *
 * Qualquer nó do mapa pode apontar para uma cena (o combate, a loja, o acampamento...). Ao
 * ativá-la, o módulo coloca nela os tokens dos personagens dos jogadores — os que ainda não
 * estão lá — e ativa a cena para todos. Voltar ao mapa é ativar de novo a cena do mapa.
 *
 * @module spire-map/node-scene
 */

import { MODULE_ID, SETTINGS } from "./constants.js";
import { sceneOf } from "./progress.js";

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
 * Ativa a cena associada a um nó, levando os tokens dos jogadores para ela.
 * @param {object} progress progresso do mapa (de onde sai a associação)
 * @param {string} nodeId
 * @returns {Promise<{ok:boolean, error?:string, scene?:Scene, placed?:number}>}
 */
export async function activateNodeScene(progress, nodeId) {
  if (!game.user.isGM) return { ok: false, error: "notGM" };
  const entry = sceneOf(progress, nodeId);
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
