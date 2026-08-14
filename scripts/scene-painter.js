/**
 * Pinta um mapa gerado na cena do Foundry VTT e mantém o estado de revelação.
 *
 * Estratégia de desenho:
 *  - arestas   -> Drawing (polígono aberto, sem preenchimento)
 *  - nós       -> Drawing (elipse com preenchimento + símbolo como texto)
 *  - ícones    -> Tile (opcional, quando o tipo de nó define uma imagem)
 *  - rótulos   -> Drawing de texto (opcional)
 *  - marcador  -> Drawing de anel na posição atual do grupo (opcional)
 *  - notas     -> Note (opcional, com JournalEntry por nó, opcional)
 *
 * Segredo: um nó oculto é o **mesmo documento**, apenas com a aparência de máscara
 * (cor neutra + símbolo "?"). Revelar é uma atualização em lote da aparência — não há
 * documentos duplicados nem risco de os jogadores lerem o tipo real pelo canvas.
 * Ícones, rótulos e notas de nós ocultos ficam `hidden`.
 *
 * Todos os documentos criados recebem a flag `spire-map.mapId`, o que permite
 * limpar/regenerar o mapa sem tocar no resto da cena.
 *
 * @module spire-map/scene-painter
 */

import { MODULE_ID, FLAG } from "./constants.js";
import { edgePoints } from "./generator.js";
import { createProgress, applyLookahead, advanceTo, toFog } from "./progress.js";

const DRAW_TYPES = {
  RECTANGLE: "r",
  ELLIPSE: "e",
  POLYGON: "p"
};

const FILL = { NONE: 0, SOLID: 1 };

/** Tradução curta. */
const t = (key, data) => game.i18n.format(key, data ?? {});

/** Gera um id único e curto para o mapa pintado. */
function makeMapId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Helper de flags para todos os documentos do módulo. */
function flags(mapId, extra = {}) {
  return { [MODULE_ID]: { [FLAG.MAP_ID]: mapId, ...extra } };
}

/** Lê o namespace de flags do módulo em um documento. */
function moduleFlags(doc) {
  return doc?.flags?.[MODULE_ID] ?? {};
}

/**
 * Compara uma cor de documento com uma string hexadecimal.
 * Campos de cor do Foundry podem chegar como string ou como instância de `Color`,
 * então a comparação normaliza os dois lados antes de decidir se houve mudança.
 */
function sameColor(docValue, hex) {
  if (docValue === null || docValue === undefined) return hex === null || hex === undefined;
  const asString =
    typeof docValue === "string" ? docValue : (docValue.css ?? String(docValue));
  return asString.toLowerCase() === String(hex).toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Aparência de um nó (revelado x oculto)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Campos de aparência de um nó, dependendo de estar revelado ou não.
 * É a única fonte de verdade — usada ao pintar e ao revelar.
 *
 * @param {import("./generator.js").MapNode} node
 * @param {object} config
 * @param {boolean} revealed
 * @returns {{fillColor:string,strokeColor:string,text:string,textColor:string,fontSize:number}}
 */
export function nodeAppearance(node, config, revealed) {
  const type = config.nodeTypes.find((ty) => ty.id === node.typeId);
  const secret = config.secretNodes && !revealed;
  const fill = secret ? config.maskFill : (type?.fill ?? "#555555");
  const stroke = secret ? config.maskColor : (type?.color ?? "#ffffff");
  const symbol = secret ? config.maskSymbol : (type?.symbol ?? "?");
  const showText = secret || (config.showSymbols && !type?.icon);
  const base = node.isBoss ? config.fontSize * 1.3 : config.fontSize;

  return {
    fillColor: fill,
    strokeColor: stroke,
    text: showText ? symbol : "",
    textColor: stroke,
    fontSize: Math.max(8, Math.round(base * 0.92))
  };
}

/* -------------------------------------------------------------------------- */
/*  Limpeza                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Remove tudo que o módulo já desenhou na cena.
 * @param {Scene} scene
 * @param {string|null} [mapId] se informado, remove apenas aquele mapa
 * @returns {Promise<number>} quantidade de documentos removidos
 */
export async function clearSceneMap(scene, mapId = null) {
  if (!scene) return 0;
  let removed = 0;
  const matches = (doc) => {
    const id = moduleFlags(doc)[FLAG.MAP_ID] ?? doc.getFlag?.(MODULE_ID, FLAG.MAP_ID);
    return id && (!mapId || id === mapId);
  };

  for (const type of ["Drawing", "Tile", "Note"]) {
    const ids = scene
      .getEmbeddedCollection(type)
      .filter(matches)
      .map((d) => d.id);
    if (ids.length) {
      await scene.deleteEmbeddedDocuments(type, ids);
      removed += ids.length;
    }
  }

  await scene.unsetFlag?.(MODULE_ID, FLAG.MAP);
  await scene.unsetFlag?.(MODULE_ID, FLAG.PROGRESS);
  return removed;
}

/* -------------------------------------------------------------------------- */
/*  Cena de destino                                                           */
/* -------------------------------------------------------------------------- */

async function resolveScene(config, bounds) {
  if (config.target === "active") {
    const scene = game.scenes?.active ?? canvas?.scene ?? null;
    if (!scene) ui.notifications?.error(t("SPIREMAP.notify.noActiveScene"));
    return scene;
  }

  const name = String(config.newSceneName || "Spire Map").replace("{act}", String(config.act));
  const data = {
    name,
    width: bounds.width,
    height: bounds.height,
    padding: 0.05,
    backgroundColor: config.backgroundColor,
    grid: { type: CONST.GRID_TYPES.GRIDLESS, size: 100 },
    tokenVision: false,
    fogExploration: false,
    initial: { x: Math.round(bounds.width / 2), y: Math.round(bounds.height / 2), scale: 0.3 },
    environment: { globalLight: { enabled: true } },
    flags: { [MODULE_ID]: { generated: true } }
  };

  try {
    return await Scene.create(data);
  } catch (err) {
    console.warn(`${MODULE_ID} | falha ao criar cena com dados completos, tentando modo simples`, err);
    return await Scene.create({ name, width: bounds.width, height: bounds.height, padding: 0.05 });
  }
}

async function ensureSceneFits(scene, bounds) {
  const updates = {};
  if (scene.width < bounds.width) updates.width = bounds.width;
  if (scene.height < bounds.height) updates.height = bounds.height;
  if (Object.keys(updates).length) {
    try {
      await scene.update(updates);
    } catch (err) {
      console.warn(`${MODULE_ID} | não foi possível redimensionar a cena`, err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Construção dos documentos                                                 */
/* -------------------------------------------------------------------------- */

function buildEdgeDrawings(map, mapId, authorId, revealed) {
  const config = map.config;
  const index = new Map(map.nodes.map((n) => [n.id, n]));
  const out = [];

  for (const edge of map.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) continue;

    const pts = edgePoints(from, to, config);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const width = Math.max(1, Math.max(...xs) - minX);
    const height = Math.max(1, Math.max(...ys) - minY);

    out.push({
      author: authorId,
      x: Math.round(minX),
      y: Math.round(minY),
      shape: {
        type: DRAW_TYPES.POLYGON,
        width: Math.round(width),
        height: Math.round(height),
        points: pts.flatMap((p) => [Math.round(p.x - minX), Math.round(p.y - minY)])
      },
      strokeWidth: config.edgeWidth,
      strokeColor: config.edgeColor,
      strokeAlpha: config.edgeAlpha,
      fillType: FILL.NONE,
      fillAlpha: 0,
      bezierFactor: 0,
      elevation: 0,
      sort: 0,
      hidden: edgeHidden(config, revealed, edge),
      locked: config.lockDrawings,
      interface: false,
      flags: flags(mapId, {
        [FLAG.KIND]: "edge",
        edge: `${edge.from}>${edge.to}`,
        from: edge.from,
        to: edge.to
      })
    });
  }
  return out;
}

/** Uma aresta só é escondida quando o Mestre pediu para esconder o traçado. */
function edgeHidden(config, revealed, edge) {
  if (!config.secretNodes || !config.hideEdgesUntilRevealed) return false;
  return !(revealed.has(edge.from) && revealed.has(edge.to));
}

function buildNodeDrawings(map, mapId, authorId, localize, revealed) {
  const config = map.config;
  const typeById = new Map(config.nodeTypes.map((ty) => [ty.id, ty]));
  const out = [];

  for (const node of map.nodes) {
    const type = typeById.get(node.typeId);
    if (!type) continue;
    const isRevealed = revealed.has(node.id);
    const look = nodeAppearance(node, config, isRevealed);
    const diameter = Math.round(config.nodeRadius * (node.isBoss ? 1.45 : 1));

    out.push({
      author: authorId,
      x: Math.round(node.x - diameter / 2),
      y: Math.round(node.y - diameter / 2),
      shape: { type: DRAW_TYPES.ELLIPSE, width: diameter, height: diameter },
      fillType: FILL.SOLID,
      fillColor: look.fillColor,
      fillAlpha: 1,
      strokeWidth: config.nodeStrokeWidth,
      strokeColor: look.strokeColor,
      strokeAlpha: 1,
      text: look.text,
      fontFamily: config.fontFamily,
      fontSize: look.fontSize,
      textColor: look.textColor,
      textAlpha: 1,
      elevation: 0,
      sort: 10,
      hidden: false,
      locked: config.lockDrawings,
      interface: false,
      flags: flags(mapId, {
        [FLAG.KIND]: "node",
        [FLAG.NODE]: {
          id: node.id,
          floor: node.floor,
          col: node.col,
          typeId: node.typeId,
          label: localize(type.label),
          isBoss: node.isBoss,
          parents: node.parents,
          children: node.children
        }
      })
    });

    if (config.showLabels) {
      const labelWidth = Math.round(config.spacingX * 0.9);
      out.push({
        author: authorId,
        x: Math.round(node.x - labelWidth / 2),
        y: Math.round(node.y + diameter / 2 + 2),
        shape: {
          type: DRAW_TYPES.RECTANGLE,
          width: labelWidth,
          height: Math.round(config.fontSize * 0.9)
        },
        fillType: FILL.NONE,
        fillAlpha: 0,
        strokeWidth: 0,
        strokeAlpha: 0,
        text: localize(type.label),
        fontFamily: config.fontFamily,
        fontSize: Math.max(8, Math.round(config.fontSize * 0.52)),
        textColor: type.color,
        textAlpha: 0.95,
        elevation: 0,
        sort: 12,
        hidden: config.secretNodes && !isRevealed,
        locked: config.lockDrawings,
        interface: false,
        flags: flags(mapId, { [FLAG.KIND]: "label", node: node.id })
      });
    }
  }
  return out;
}

/** Anel que marca onde o grupo está. */
function buildMarker(map, mapId, authorId, progress) {
  const config = map.config;
  if (!config.showPartyMarker) return [];
  const current = map.nodes.find((n) => n.id === progress.current) ?? null;
  const base = current ?? map.nodes[0];
  if (!base) return [];
  const size = Math.round(config.nodeRadius * (base.isBoss ? 1.45 : 1) * 1.7);

  return [
    {
      author: authorId,
      x: Math.round(base.x - size / 2),
      y: Math.round(base.y - size / 2),
      shape: { type: DRAW_TYPES.ELLIPSE, width: size, height: size },
      fillType: FILL.NONE,
      fillAlpha: 0,
      strokeWidth: Math.max(3, Math.round(config.nodeStrokeWidth * 1.4)),
      strokeColor: config.markerColor,
      strokeAlpha: 0.95,
      text: "",
      elevation: 0,
      sort: 8,
      hidden: !current,
      locked: true,
      interface: false,
      flags: flags(mapId, { [FLAG.KIND]: "marker" })
    }
  ];
}

function buildFloorLabels(map, mapId, authorId) {
  const config = map.config;
  if (!config.showFloorNumbers) return [];
  const out = [];
  const boxW = Math.round(Math.max(48, config.marginX * 0.7));
  const boxH = Math.round(config.fontSize);

  for (let floor = 1; floor <= map.totalFloors; floor++) {
    if (!map.byFloor[floor - 1]?.length) continue;
    const rowIndex = config.orientation === "up" ? map.totalFloors - floor : floor - 1;
    const y = config.marginY + rowIndex * config.spacingY;
    const label = floor === map.totalFloors && config.bossEnabled ? "★" : String(floor);

    out.push({
      author: authorId,
      x: Math.round(Math.max(0, config.marginX * 0.4 - boxW / 2)),
      y: Math.round(y - boxH / 2),
      shape: { type: DRAW_TYPES.RECTANGLE, width: boxW, height: boxH },
      fillType: FILL.NONE,
      fillAlpha: 0,
      strokeWidth: 0,
      strokeAlpha: 0,
      text: label,
      fontFamily: config.fontFamily,
      fontSize: Math.max(8, Math.round(config.fontSize * 0.66)),
      textColor: config.edgeColor,
      textAlpha: 0.7,
      elevation: 0,
      sort: 5,
      hidden: false,
      locked: config.lockDrawings,
      interface: false,
      flags: flags(mapId, { [FLAG.KIND]: "floor", floor })
    });
  }
  return out;
}

function buildBackdrop(map, mapId, authorId) {
  const config = map.config;
  const out = [];

  if (config.drawBackground) {
    out.push({
      author: authorId,
      x: 0,
      y: 0,
      shape: { type: DRAW_TYPES.RECTANGLE, width: map.bounds.width, height: map.bounds.height },
      fillType: FILL.SOLID,
      fillColor: config.backgroundColor,
      fillAlpha: 1,
      strokeWidth: 0,
      strokeAlpha: 0,
      elevation: 0,
      sort: -10,
      hidden: false,
      locked: true,
      interface: false,
      flags: flags(mapId, { [FLAG.KIND]: "background" })
    });
  }

  if (config.titleText) {
    const text = config.titleText.replace("{act}", String(config.act)).replace("{seed}", map.seed);
    const boxW = Math.round(map.bounds.width * 0.8);
    const boxH = Math.round(config.fontSize * 2);
    const y =
      config.orientation === "up"
        ? Math.round(config.marginY * 0.35 - boxH / 2)
        : Math.round(map.bounds.height - config.marginY * 0.5 - boxH / 2);
    out.push({
      author: authorId,
      x: Math.round((map.bounds.width - boxW) / 2),
      y: Math.max(0, y),
      shape: { type: DRAW_TYPES.RECTANGLE, width: boxW, height: boxH },
      fillType: FILL.NONE,
      fillAlpha: 0,
      strokeWidth: 0,
      strokeAlpha: 0,
      text,
      fontFamily: config.fontFamily,
      fontSize: Math.round(config.fontSize * 1.35),
      textColor: config.edgeColor,
      textAlpha: 1,
      elevation: 0,
      sort: 20,
      hidden: false,
      locked: true,
      interface: false,
      flags: flags(mapId, { [FLAG.KIND]: "title" })
    });
  }

  return out;
}

function buildIconTiles(map, mapId, revealed) {
  const config = map.config;
  const typeById = new Map(config.nodeTypes.map((ty) => [ty.id, ty]));
  const out = [];

  for (const node of map.nodes) {
    const type = typeById.get(node.typeId);
    if (!type?.icon) continue;
    const size = Math.round(config.nodeRadius * (node.isBoss ? 1.45 : 1) * 0.78);
    out.push({
      texture: { src: type.icon },
      x: Math.round(node.x - size / 2),
      y: Math.round(node.y - size / 2),
      width: size,
      height: size,
      elevation: 1,
      sort: 30,
      hidden: config.secretNodes && !revealed.has(node.id),
      locked: config.lockDrawings,
      flags: flags(mapId, { [FLAG.KIND]: "icon", node: node.id })
    });
  }
  return out;
}

async function buildNotes(map, mapId, localize, revealed) {
  const config = map.config;
  if (!config.createNotes) return [];

  const typeById = new Map(config.nodeTypes.map((ty) => [ty.id, ty]));
  let entriesByNode = new Map();

  if (config.createJournal) {
    let folder = game.folders?.find(
      (f) => f.type === "JournalEntry" && f.name === config.journalFolderName
    );
    if (!folder) {
      folder = await Folder.create({ name: config.journalFolderName, type: "JournalEntry" });
    }

    const entryData = map.nodes.map((node) => {
      const type = typeById.get(node.typeId);
      const label = localize(type?.label ?? node.typeId);
      const name = `${label} — ${t("SPIREMAP.preview.floor")} ${node.floor}`;
      return {
        name,
        folder: folder?.id ?? null,
        pages: [
          {
            name,
            type: "text",
            title: { show: false, level: 1 },
            text: {
              format: 1,
              content:
                `<p><strong>${label}</strong></p>` +
                `<p>${t("SPIREMAP.journal.floor")}: ${node.floor} · ${t("SPIREMAP.journal.column")}: ${node.col + 1}</p>` +
                `<p>${t("SPIREMAP.journal.seed")}: <code>${map.seed}</code></p>` +
                `<hr><p>${t("SPIREMAP.journal.placeholder")}</p>`
            }
          }
        ],
        flags: flags(mapId, { [FLAG.KIND]: "journal", node: node.id })
      };
    });

    const created = await JournalEntry.createDocuments(entryData);
    created.forEach((entry, i) => entriesByNode.set(map.nodes[i].id, entry.id));
  }

  return map.nodes.map((node) => {
    const type = typeById.get(node.typeId);
    const label = localize(type?.label ?? node.typeId);
    return {
      entryId: entriesByNode.get(node.id) ?? null,
      x: Math.round(node.x),
      y: Math.round(node.y),
      texture: { src: type?.icon || "icons/svg/book.svg" },
      iconSize: Math.max(32, Math.round(config.nodeRadius * 0.7)),
      text: `${label} (${node.floor})`,
      fontSize: Math.max(8, Math.round(config.fontSize * 0.5)),
      textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM,
      textColor: type?.color ?? "#ffffff",
      global: true,
      hidden: config.secretNodes && !revealed.has(node.id),
      flags: flags(mapId, { [FLAG.KIND]: "note", node: node.id })
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Pintura                                                                   */
/* -------------------------------------------------------------------------- */

/** Versão enxuta do mapa, guardada na flag da cena para o controle de revelação. */
export function trimMap(map, mapId) {
  return {
    mapId,
    seed: map.seed,
    totalFloors: map.totalFloors,
    bounds: map.bounds,
    config: map.config,
    edges: map.edges,
    nodes: map.nodes.map((n) => ({
      id: n.id,
      floor: n.floor,
      col: n.col,
      typeId: n.typeId,
      x: n.x,
      y: n.y,
      parents: n.parents,
      children: n.children,
      isBoss: n.isBoss
    }))
  };
}

/** Reconstrói um objeto de mapa utilizável a partir da flag da cena. */
export function inflateMap(stored) {
  if (!stored?.nodes?.length) return null;
  const totalFloors = stored.totalFloors;
  const byFloor = Array.from({ length: totalFloors }, () => []);
  for (const node of stored.nodes) byFloor[node.floor - 1]?.push(node);
  for (const floorNodes of byFloor) floorNodes.sort((a, b) => a.col - b.col);

  const counts = {};
  for (const node of stored.nodes) counts[node.typeId] = (counts[node.typeId] ?? 0) + 1;

  return {
    seed: stored.seed,
    config: stored.config,
    totalFloors,
    nodes: stored.nodes,
    byFloor,
    edges: stored.edges ?? [],
    bounds: stored.bounds,
    counts,
    warnings: []
  };
}

/** Lê mapa + progresso guardados em uma cena. */
export function readSceneMap(scene) {
  const stored = scene?.getFlag?.(MODULE_ID, FLAG.MAP);
  const progress = scene?.getFlag?.(MODULE_ID, FLAG.PROGRESS);
  const map = inflateMap(stored);
  if (!map) return null;
  return { map, progress: progress ?? null, mapId: stored.mapId };
}

/**
 * Pinta o mapa na cena.
 *
 * @param {import("./generator.js").SpireMap} map
 * @param {object} [options]
 * @param {(key:string) => string} [options.localize]
 * @returns {Promise<{scene: Scene, mapId: string, created: number, progress: object}|null>}
 */
export async function paintMap(map, options = {}) {
  const localize = options.localize ?? ((k) => (game.i18n?.has?.(k) ? game.i18n.localize(k) : k));
  const config = map.config;

  if (!game.user?.isGM) {
    ui.notifications?.warn(t("SPIREMAP.notify.gmOnly"));
    return null;
  }

  const scene = await resolveScene(config, map.bounds);
  if (!scene) return null;
  if (config.target === "active") await ensureSceneFits(scene, map.bounds);

  if (config.clearPrevious) await clearSceneMap(scene);

  const mapId = makeMapId();
  const authorId = game.user.id;
  const progress = createProgress(map, config, mapId);
  const revealed = new Set(progress.revealed);

  const drawings = [
    ...buildBackdrop(map, mapId, authorId),
    ...buildFloorLabels(map, mapId, authorId),
    ...buildEdgeDrawings(map, mapId, authorId, revealed),
    ...buildMarker(map, mapId, authorId, progress),
    ...buildNodeDrawings(map, mapId, authorId, localize, revealed)
  ];
  const tiles = buildIconTiles(map, mapId, revealed);

  let created = 0;
  try {
    if (drawings.length) {
      const made = await scene.createEmbeddedDocuments("Drawing", drawings);
      created += made.length;
    }
    if (tiles.length) {
      const made = await scene.createEmbeddedDocuments("Tile", tiles);
      created += made.length;
    }
    const notes = await buildNotes(map, mapId, localize, revealed);
    if (notes.length) {
      const made = await scene.createEmbeddedDocuments("Note", notes);
      created += made.length;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | erro ao pintar o mapa`, err);
    ui.notifications?.error(t("SPIREMAP.notify.paintError", { error: err.message }));
    return null;
  }

  await scene.setFlag(MODULE_ID, FLAG.MAP, trimMap(map, mapId));
  await scene.setFlag(MODULE_ID, FLAG.PROGRESS, progress);
  await scene.setFlag(MODULE_ID, "lastMap", {
    mapId,
    seed: map.seed,
    floors: map.totalFloors,
    nodes: map.nodes.length,
    createdAt: Date.now()
  });

  if (config.notifyChat) {
    await ChatMessage.create({
      content:
        `<div class="spire-map-chat"><h3>${t("SPIREMAP.chat.title")}</h3>` +
        `<p>${t("SPIREMAP.chat.body", {
          seed: map.seed,
          floors: map.totalFloors,
          nodes: map.nodes.length
        })}</p></div>`,
      whisper: config.target === "active" ? [] : ChatMessage.getWhisperRecipients("GM").map((u) => u.id)
    });
  }

  ui.notifications?.info(
    t("SPIREMAP.notify.painted", { scene: scene.name, count: created, seed: map.seed })
  );

  return { scene, mapId, created, progress };
}

/* -------------------------------------------------------------------------- */
/*  Sincronização do estado de revelação                                      */
/* -------------------------------------------------------------------------- */

/**
 * Aplica um estado de progresso à cena: atualiza a aparência dos nós, a visibilidade
 * de rótulos/ícones/notas/arestas e a posição do marcador. Só toca no que mudou.
 *
 * @param {Scene} scene
 * @param {import("./generator.js").SpireMap} map
 * @param {object} progress
 * @returns {Promise<{updated:number}>}
 */
export async function applyProgressToScene(scene, map, progress) {
  if (!scene || !map) return { updated: 0 };
  const config = map.config;
  const revealed = new Set(progress?.revealed ?? []);
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));

  const drawingUpdates = [];
  const tileUpdates = [];
  const noteUpdates = [];

  for (const doc of scene.getEmbeddedCollection("Drawing")) {
    const f = moduleFlags(doc);
    if (!f[FLAG.MAP_ID]) continue;

    switch (f[FLAG.KIND]) {
      case "node": {
        const node = nodeById.get(f[FLAG.NODE]?.id);
        if (!node) break;
        const look = nodeAppearance(node, config, revealed.has(node.id));
        const change = {};
        if (!sameColor(doc.fillColor, look.fillColor)) change.fillColor = look.fillColor;
        if (!sameColor(doc.strokeColor, look.strokeColor)) change.strokeColor = look.strokeColor;
        if ((doc.text ?? "") !== look.text) change.text = look.text;
        if (!sameColor(doc.textColor, look.textColor)) change.textColor = look.textColor;
        if (Object.keys(change).length) drawingUpdates.push({ _id: doc.id, ...change });
        break;
      }
      case "label": {
        const hidden = config.secretNodes && !revealed.has(f.node);
        if (doc.hidden !== hidden) drawingUpdates.push({ _id: doc.id, hidden });
        break;
      }
      case "edge": {
        const hidden = edgeHidden(config, revealed, { from: f.from, to: f.to });
        if (doc.hidden !== hidden) drawingUpdates.push({ _id: doc.id, hidden });
        break;
      }
      case "marker": {
        const current = nodeById.get(progress?.current);
        if (!config.showPartyMarker) {
          if (!doc.hidden) drawingUpdates.push({ _id: doc.id, hidden: true });
          break;
        }
        if (!current) {
          if (!doc.hidden) drawingUpdates.push({ _id: doc.id, hidden: true });
          break;
        }
        const size = Math.round(config.nodeRadius * (current.isBoss ? 1.45 : 1) * 1.7);
        const change = {
          hidden: false,
          x: Math.round(current.x - size / 2),
          y: Math.round(current.y - size / 2),
          shape: { type: DRAW_TYPES.ELLIPSE, width: size, height: size }
        };
        if (
          doc.hidden !== false ||
          doc.x !== change.x ||
          doc.y !== change.y ||
          doc.shape?.width !== size
        ) {
          drawingUpdates.push({ _id: doc.id, ...change });
        }
        break;
      }
      default:
        break;
    }
  }

  for (const doc of scene.getEmbeddedCollection("Tile")) {
    const f = moduleFlags(doc);
    if (f[FLAG.KIND] !== "icon") continue;
    const hidden = config.secretNodes && !revealed.has(f.node);
    if (doc.hidden !== hidden) tileUpdates.push({ _id: doc.id, hidden });
  }

  for (const doc of scene.getEmbeddedCollection("Note")) {
    const f = moduleFlags(doc);
    if (f[FLAG.KIND] !== "note") continue;
    const hidden = config.secretNodes && !revealed.has(f.node);
    if (doc.hidden !== hidden) noteUpdates.push({ _id: doc.id, hidden });
  }

  try {
    if (drawingUpdates.length) await scene.updateEmbeddedDocuments("Drawing", drawingUpdates);
    if (tileUpdates.length) await scene.updateEmbeddedDocuments("Tile", tileUpdates);
    if (noteUpdates.length) await scene.updateEmbeddedDocuments("Note", noteUpdates);
    await scene.setFlag(MODULE_ID, FLAG.PROGRESS, progress);
  } catch (err) {
    console.error(`${MODULE_ID} | erro ao sincronizar a revelação`, err);
    ui.notifications?.error(t("SPIREMAP.notify.revealError", { error: err.message }));
  }

  return { updated: drawingUpdates.length + tileUpdates.length + noteUpdates.length };
}

/**
 * Marca a escolha dos jogadores e sincroniza a cena.
 *
 * @param {Scene} scene
 * @param {string} nodeId
 * @param {object} [options]
 * @param {boolean} [options.force] aceita um nó fora das opções atuais
 * @returns {Promise<{ok:boolean, error?:string, revealedNow?:string[], progress?:object}>}
 */
export async function chooseNode(scene, nodeId, options = {}) {
  const data = readSceneMap(scene);
  if (!data) return { ok: false, error: "noMap" };

  const { map } = data;
  const progress = data.progress ?? createProgress(map, map.config, data.mapId);
  const result = advanceTo(map, progress, nodeId, options);
  if (result.error) return { ok: false, error: result.error };

  await applyProgressToScene(scene, map, result.progress);

  const node = map.nodes.find((n) => n.id === nodeId);
  const type = map.config.nodeTypes.find((ty) => ty.id === node?.typeId);
  if (map.config.announceReveal && node) {
    const label = game.i18n?.has?.(type?.label) ? game.i18n.localize(type.label) : (type?.label ?? node.typeId);
    await ChatMessage.create({
      content:
        `<div class="spire-map-chat"><h3>${t("SPIREMAP.chat.moveTitle")}</h3>` +
        `<p>${t("SPIREMAP.chat.moveBody", { label, floor: node.floor })}</p></div>`
    });
  }

  return { ok: true, revealedNow: result.revealedNow, progress: result.progress };
}

/**
 * Grava um progresso arbitrário (usado pelos botões de revelar/ocultar/reiniciar).
 * @param {Scene} scene
 * @param {object} progress
 */
export async function setProgress(scene, progress) {
  const data = readSceneMap(scene);
  if (!data) return { ok: false, error: "noMap" };
  await applyProgressToScene(scene, data.map, progress);
  return { ok: true, progress };
}

export { toFog, applyLookahead };
