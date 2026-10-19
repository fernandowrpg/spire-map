/**
 * Votação do caminho do grupo.
 *
 * Quando há opções para o grupo escolher, o Mestre abre uma votação: um cartão no chat com
 * um botão por sala disponível. Cada jogador ativo (conectado e não-Mestre) vota clicando; o
 * voto pode ser trocado até a votação fechar. Quando todos os jogadores ativos votaram, a sala
 * mais votada é escolhida sozinha. Em caso de empate, o Mestre desempata clicando em uma das
 * salas empatadas no controle de revelação (qualquer escolha do Mestre encerra a votação).
 *
 * Jogadores não podem gravar flags da cena, então o voto vai por socket para o Mestre ativo,
 * que é o único cliente que grava o estado da votação (flag `vote` da cena) e o cartão do chat.
 *
 * @module spire-map/vote
 */

import { MODULE_ID, FLAG, SETTINGS } from "./constants.js";
import { readSceneMap, chooseNode } from "./scene-painter.js";
import { createProgress, makeDisplay } from "./progress.js";
import { smartLocalize } from "./i18n.js";

const SOCKET = `module.${MODULE_ID}`;

/**
 * @typedef {object} Vote
 * @property {string} id
 * @property {string|null} from     posição do grupo quando a votação abriu
 * @property {string[]} options     salas votáveis
 * @property {{userId:string,nodeId:string}[]} votes
 * @property {string|null} messageId
 */

const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

/** Este cliente é o Mestre que processa votos (só um, mesmo com vários Mestres conectados). */
function isActiveGM() {
  const active = game.users?.activeGM ?? game.users?.find((u) => u.isGM && u.active);
  return Boolean(game.user?.isGM) && active?.id === game.user.id;
}

/** Jogadores que contam para fechar a votação: conectados e não-Mestres. */
export function activeVoters() {
  return game.users.filter((u) => u.active && !u.isGM);
}

/** Votação aberta na cena, ou `null`. */
export function readVote(scene) {
  const vote = scene?.getFlag?.(MODULE_ID, FLAG.VOTE);
  return vote?.id ? vote : null;
}

/**
 * Contagem de votos (só de jogadores ativos).
 * @returns {{counts: Map<string, number>, voters: Map<string, string[]>, total: number, leaders: string[], max: number}}
 */
export function tally(vote) {
  const active = new Set(activeVoters().map((u) => u.id));
  const counts = new Map(vote.options.map((id) => [id, 0]));
  const voters = new Map(vote.options.map((id) => [id, []]));
  let total = 0;
  for (const { userId, nodeId } of vote.votes ?? []) {
    if (!active.has(userId) || !counts.has(nodeId)) continue;
    counts.set(nodeId, counts.get(nodeId) + 1);
    voters.get(nodeId).push(game.users.get(userId)?.name ?? "?");
    total++;
  }
  const max = Math.max(0, ...counts.values());
  const leaders = max ? [...counts].filter(([, c]) => c === max).map(([id]) => id) : [];
  return { counts, voters, total, leaders, max };
}

/** Como os jogadores veem uma opção: o tipo, se revelado; senão "?". */
function optionLabel(map, progress, nodeId) {
  const node = map.nodes.find((n) => n.id === nodeId);
  if (!node) return { label: "?", symbol: "?", fill: "#555555", color: "#ffffff", floor: "?", col: "?" };
  const where = { floor: node.floor, col: node.col + 1 };
  if (!(progress.revealed ?? []).includes(nodeId)) {
    return { label: t("SPIREMAP.vote.unknownRoom"), symbol: "?", fill: "#555555", color: "#ffffff", ...where };
  }
  const display = makeDisplay(map, progress)(node);
  const label = smartLocalize(display.type?.label ?? node.typeId);
  return {
    label: display.alias ? `${display.alias} — ${label}` : label,
    symbol: display.type?.symbol ?? "?",
    fill: display.type?.fill ?? "#555555",
    color: display.type?.color ?? "#ffffff",
    ...where
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML do cartão de votação. */
function cardHtml(scene, vote, status = "open", winner = null) {
  const data = readSceneMap(scene);
  if (!data) return "";
  const progress = data.progress ?? createProgress(data.map, data.map.config, data.mapId);
  const { counts, voters, total } = tally(vote);
  const expected = activeVoters().length;

  const rows = vote.options
    .map((id) => {
      const o = optionLabel(data.map, progress, id);
      const names = voters.get(id) ?? [];
      const cls = ["spire-vote__option", winner === id ? "is-winner" : ""].join(" ").trim();
      return (
        `<button type="button" class="${cls}" data-spire-vote="${escapeHtml(id)}"${status === "open" ? "" : " disabled"}>` +
        `<span class="spire-chip" style="background:${escapeHtml(o.fill)};color:${escapeHtml(o.color)}">${escapeHtml(o.symbol)}</span>` +
        `<span class="spire-vote__label"><strong>${escapeHtml(o.label)}</strong>` +
        `<span class="hint">${t("SPIREMAP.vote.where", { floor: o.floor, col: o.col })}` +
        (names.length ? ` · ${escapeHtml(names.join(", "))}` : "") +
        `</span></span>` +
        `<span class="spire-vote__count">${counts.get(id) ?? 0}</span>` +
        `</button>`
      );
    })
    .join("");

  let footer = t("SPIREMAP.vote.progress", { count: total, total: expected });
  if (status === "tie") footer = t("SPIREMAP.vote.tie");
  else if (status === "closed") footer = t("SPIREMAP.vote.closed");
  else if (status === "decided") footer = t("SPIREMAP.vote.decided");
  else if (status === "gm") footer = t("SPIREMAP.vote.decidedByGM");

  return (
    `<div class="spire-map-chat spire-vote" data-vote-id="${escapeHtml(vote.id)}">` +
    `<h3>${t("SPIREMAP.vote.title")}</h3>` +
    `<p class="hint">${t(status === "open" ? "SPIREMAP.vote.prompt" : "SPIREMAP.vote.promptClosed")}</p>` +
    `<div class="spire-vote__options">${rows}</div>` +
    `<p class="spire-vote__footer">${footer}</p>` +
    `</div>`
  );
}

async function updateCard(scene, vote, status, winner) {
  const message = vote.messageId ? game.messages.get(vote.messageId) : null;
  if (message) await message.update({ content: cardHtml(scene, vote, status, winner) });
}

/* -------------------------------------------------------------------------- */
/*  Ações do Mestre                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Abre uma votação com as opções atuais do grupo (substitui uma votação aberta).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function startVote(scene) {
  if (!game.user.isGM) return { ok: false, error: "notGM" };
  const data = readSceneMap(scene);
  if (!data) return { ok: false, error: "noMap" };
  const progress = data.progress ?? createProgress(data.map, data.map.config, data.mapId);
  const options = progress.available ?? [];
  if (!options.length) return { ok: false, error: "noOptions" };

  await cancelVote(scene);
  const vote = {
    id: foundry.utils.randomID(),
    from: progress.current ?? null,
    options: [...options],
    votes: [],
    messageId: null
  };
  const message = await ChatMessage.create({
    content: cardHtml(scene, vote),
    flags: { [MODULE_ID]: { vote: { sceneId: scene.id, voteId: vote.id } } }
  });
  vote.messageId = message?.id ?? null;
  await scene.setFlag(MODULE_ID, FLAG.VOTE, vote);
  return { ok: true };
}

/** Fecha a votação sem escolher nada (o cartão fica marcado como encerrado). */
export async function cancelVote(scene, status = "closed", winner = null) {
  const vote = readVote(scene);
  if (!vote) return;
  await scene.unsetFlag(MODULE_ID, FLAG.VOTE);
  await updateCard(scene, vote, status, winner);
}

/**
 * Encerra a votação: a mais votada vence. Empate (ou nenhum voto) deixa para o Mestre.
 * @returns {Promise<{ok:boolean, error?:string, winner?:string}>}
 */
export async function closeVote(scene) {
  const vote = readVote(scene);
  if (!vote) return { ok: false, error: "noVote" };
  const { leaders } = tally(vote);
  if (leaders.length !== 1) {
    await updateCard(scene, vote, "tie");
    return { ok: false, error: leaders.length ? "tie" : "noVotes" };
  }
  const winner = leaders[0];
  // Fecha antes de andar: o avanço dispara a abertura da próxima votação.
  await cancelVote(scene, "decided", winner);
  const result = await chooseNode(scene, winner);
  return result.ok ? { ok: true, winner } : result;
}

/** Fecha sozinha quando todos os jogadores ativos votaram. */
async function checkComplete(scene) {
  const vote = readVote(scene);
  if (!vote) return;
  const expected = activeVoters().length;
  const { total, leaders } = tally(vote);
  if (!expected || total < expected) return updateCard(scene, vote, "open");
  if (leaders.length === 1) return closeVote(scene);
  ui.notifications.info(t("SPIREMAP.vote.tieNotify"));
  return updateCard(scene, vote, "tie");
}

/** Registra o voto de um jogador (só no Mestre ativo). */
async function recordVote({ sceneId, voteId, nodeId, userId }) {
  const scene = game.scenes.get(sceneId);
  const vote = readVote(scene);
  if (!vote || vote.id !== voteId || !vote.options.includes(nodeId)) return;
  const user = game.users.get(userId);
  if (!user || user.isGM) return;
  const votes = (vote.votes ?? []).filter((v) => v.userId !== userId);
  votes.push({ userId, nodeId });
  await scene.setFlag(MODULE_ID, FLAG.VOTE, { ...vote, votes });
  await checkComplete(scene);
}

/* -------------------------------------------------------------------------- */
/*  Ligações                                                                  */
/* -------------------------------------------------------------------------- */

function autoVote() {
  try {
    return game.settings.get(MODULE_ID, SETTINGS.AUTO_VOTE);
  } catch (err) {
    return false;
  }
}

/** Última posição vista de cada cena (para a votação automática). */
const lastCurrent = new Map();

export function registerVoting() {
  for (const scene of game.scenes) {
    const data = readSceneMap(scene);
    if (data) lastCurrent.set(scene.id, data.progress?.current ?? null);
  }

  game.socket.on(SOCKET, (payload) => {
    if (payload?.type === "vote" && isActiveGM()) recordVote(payload);
  });

  // O grupo andou (pela votação, pelo Mestre ou por macro): a votação aberta perde o sentido.
  Hooks.on("updateScene", async (scene, changes) => {
    if (!isActiveGM()) return;
    if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG.PROGRESS}`)) return;
    const data = readSceneMap(scene);
    if (!data?.progress) return;
    const current = data.progress.current ?? null;
    const vote = readVote(scene);
    if (vote && (vote.from ?? null) !== current) await cancelVote(scene, "gm", current);

    // Votação automática: só quando a posição muda de fato (revelar/ocultar não conta).
    const moved = (lastCurrent.get(scene.id) ?? null) !== current;
    lastCurrent.set(scene.id, current);
    if (moved && autoVote() && (data.progress.available ?? []).length > 1) await startVote(scene);
  });

  // Um jogador entrou ou saiu: muda quantos votos faltam.
  Hooks.on("userConnected", () => {
    if (!isActiveGM()) return;
    for (const scene of game.scenes) if (readVote(scene)) checkComplete(scene);
  });

  const onRender = (message, html) => {
    const info = message.getFlag?.(MODULE_ID, "vote");
    if (!info) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    const scene = game.scenes.get(info.sceneId);
    const vote = readVote(scene);
    const mine = vote?.id === info.voteId ? vote.votes.find((v) => v.userId === game.user.id)?.nodeId : null;
    for (const button of root.querySelectorAll("[data-spire-vote]")) {
      if (mine && button.dataset.spireVote === mine) button.classList.add("is-mine");
      if (game.user.isGM) {
        button.disabled = true;
        continue;
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (!game.users.activeGM) return ui.notifications.warn(t("SPIREMAP.vote.noGM"));
        game.socket.emit(SOCKET, {
          type: "vote",
          sceneId: info.sceneId,
          voteId: info.voteId,
          nodeId: button.dataset.spireVote,
          userId: game.user.id
        });
        root.querySelectorAll("[data-spire-vote]").forEach((b) => b.classList.toggle("is-mine", b === button));
      });
    }
  };
  Hooks.on("renderChatMessageHTML", onRender);
}
