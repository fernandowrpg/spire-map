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
 * documentos duplicados. Ícones (Tile) e rótulos de nós ocultos ficam `hidden`; as notas
 * de mapa, que não têm campo de visibilidade no schema do Foundry, só existem enquanto o
 * nó está revelado (criadas ao revelar, removidas ao ocultar).
 *
 * Todos os documentos criados recebem a flag `spire-map.mapId`, o que permite
 * limpar/regenerar o mapa sem tocar no resto da cena.
 *
 * @module spire-map/scene-painter
 */

import { MODULE_ID, FLAG } from "./constants.js";
import { edgePoints } from "./generator.js";
import { createProgress, applyLookahead, advanceTo, toFog } from "./progress.js";

/**
 * Códigos de forma e enums lidos do próprio Foundry em tempo de execução, com os valores
 * históricos como reserva. Assim o módulo não quebra se uma versão futura mexer nas
 * constantes (v13 e v14 usam os mesmos códigos).
 */
let _enums = null;
function enums() {
  if (_enums) return _enums;
  const shapes = globalThis.foundry?.data?.ShapeData?.TYPES ?? {};
  const fills = globalThis.CONST?.DRAWING_FILL_TYPES ?? {};
  _enums = {
    shape: {
      RECTANGLE: shapes.RECTANGLE ?? "r",
      ELLIPSE: shapes.ELLIPSE ?? "e",
      POLYGON: shapes.POLYGON ?? "p"
    },
    fill: { NONE: fills.NONE ?? 0, SOLID: fills.SOLID ?? 1 },
    textAnchorBottom: globalThis.CONST?.TEXT_ANCHOR_POINTS?.BOTTOM ?? 1,
    gridless: globalThis.CONST?.GRID_TYPES?.GRIDLESS ?? 0,
    ownershipNone: globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.NONE ?? 0
  };
  return _enums;
}

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
    padding: config.scenePadding,
    backgroundColor: config.backgroundColor,
    grid: { type: enums().gridless, size: 100 },
    tokenVision: false,
    fogExploration: false,
    environment: { globalLight: { enabled: true } },
    flags: { [MODULE_ID]: { generated: true } }
  };

  try {
    return await Scene.create(data);
  } catch (err) {
    console.warn(`${MODULE_ID} | falha ao criar cena com dados completos, tentando modo simples`, err);
    return await Scene.create({
      name,
      width: bounds.width,
      height: bounds.height,
      padding: config.scenePadding
    });
  }
}

/**
 * Onde o mapa deve ser desenhado dentro da cena.
 *
 * No Foundry, a origem `(0, 0)` de um documento é o canto do **canvas**, e o canvas inclui a
 * margem (padding) da cena: o retângulo visível começa em `(sceneX, sceneY)`. Desenhar em
 * `(0, 0)` joga o mapa dentro da margem, deslocado para cima e para a esquerda do retângulo.
 * Por isso o mapa é posicionado a partir do retângulo da cena e **centralizado** nele — o que
 * também resolve o caso da cena ser maior que o mapa.
 *
 * @param {Scene} scene
 * @param {{width:number,height:number}} bounds
 * @returns {{x:number,y:number}}
 */
export function sceneOrigin(scene, bounds) {
  let dims = null;
  try {
    dims = scene?.dimensions ?? scene?.getDimensions?.() ?? null;
  } catch (err) {
    console.warn(`${MODULE_ID} | não foi possível ler as dimensões da cena`, err);
  }

  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  const sceneX = num(dims?.sceneX, 0);
  const sceneY = num(dims?.sceneY, 0);
  const sceneWidth = num(dims?.sceneWidth, num(scene?.width, bounds.width));
  const sceneHeight = num(dims?.sceneHeight, num(scene?.height, bounds.height));

  return {
    x: Math.round(sceneX + Math.max(0, (sceneWidth - bounds.width) / 2)),
    y: Math.round(sceneY + Math.max(0, (sceneHeight - bounds.height) / 2))
  };
}

/** Desloca uma lista de dados de documento para a origem do mapa. */
function offsetDocs(list, origin) {
  for (const doc of list) {
    doc.x = Math.round((doc.x ?? 0) + origin.x);
    doc.y = Math.round((doc.y ?? 0) + origin.y);
  }
  return list;
}

/**
 * Enquadramento inicial da cena: centro do mapa (já com o deslocamento) e uma escala que
 * mostra o mapa inteiro numa janela de referência de 1600×900.
 */
function frameFor(bounds, origin = { x: 0, y: 0 }) {
  const scale = Math.min(1600 / bounds.width, 900 / bounds.height);
  return {
    x: Math.round(origin.x + bounds.width / 2),
    y: Math.round(origin.y + bounds.height / 2),
    scale: Math.round(Math.max(0.25, Math.min(3, scale)) * 100) / 100
  };
}

/**
 * Ajusta as dimensões da cena ao mapa, conforme `config.resizeScene`:
 *
 *  - `exact` — a cena passa a ter exatamente o tamanho do mapa (reduz **e** aumenta) e
 *    recebe a margem de `config.scenePadding`;
 *  - `grow`  — só aumenta, nunca reduz (comportamento até a 1.2.0);
 *  - `none`  — não mexe nas dimensões.
 *
 * Em `exact` e `grow` o enquadramento inicial também é gravado, para a cena abrir
 * mostrando o mapa inteiro.
 *
 * @returns {Promise<{changed: boolean, from: {width:number,height:number}, to: object}>}
 */
async function applySceneSize(scene, bounds, config) {
  const mode = config.resizeScene ?? "exact";
  const from = { width: scene.width, height: scene.height };
  if (mode === "none") return { changed: false, from, to: {} };

  const updates = {};
  if (mode === "exact") {
    if (scene.width !== bounds.width) updates.width = bounds.width;
    if (scene.height !== bounds.height) updates.height = bounds.height;
    if (Number(scene.padding) !== Number(config.scenePadding)) updates.padding = config.scenePadding;
  } else {
    if (scene.width < bounds.width) updates.width = bounds.width;
    if (scene.height < bounds.height) updates.height = bounds.height;
  }

  if (!Object.keys(updates).length) return { changed: false, from, to: {} };

  try {
    await scene.update(updates);
    return { changed: true, from, to: updates };
  } catch (err) {
    console.warn(`${MODULE_ID} | não foi possível redimensionar a cena`, err);
    ui.notifications?.warn(t("SPIREMAP.notify.resizeFailed", { error: err.message }));
    return { changed: false, from, to: {}, error: err.message };
  }
}

/**
 * Grava o enquadramento inicial da cena. Roda **depois** do redimensionamento, porque a
 * origem do mapa depende das dimensões e da margem já atualizadas.
 */
async function applySceneFraming(scene, bounds, origin, config) {
  if ((config.resizeScene ?? "exact") === "none") return;
  const frame = frameFor(bounds, origin);
  const current = scene.initial ?? null;
  if (current?.x === frame.x && current?.y === frame.y && Number(current?.scale) === frame.scale) {
    return;
  }
  try {
    await scene.update({ initial: frame });
  } catch (err) {
    console.warn(`${MODULE_ID} | não foi possível gravar o enquadramento inicial`, err);
  }
}

/**
 * Move a câmera do Mestre para o mapa, quando a cena ajustada é a que está aberta.
 * Puramente visual e tolerante a falhas.
 */
async function panToMap(scene, bounds, origin) {
  try {
    if (canvas?.scene?.id !== scene.id || typeof canvas.animatePan !== "function") return;
    const frame = frameFor(bounds, origin);
    await canvas.animatePan({ x: frame.x, y: frame.y, scale: frame.scale });
  } catch (err) {
    console.debug(`${MODULE_ID} | não foi possível reposicionar a câmera`, err);
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
        type: enums().shape.POLYGON,
        width: Math.round(width),
        height: Math.round(height),
        points: pts.flatMap((p) => [Math.round(p.x - minX), Math.round(p.y - minY)])
      },
      strokeWidth: config.edgeWidth,
      strokeColor: config.edgeColor,
      strokeAlpha: config.edgeAlpha,
      fillType: enums().fill.NONE,
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
      shape: { type: enums().shape.ELLIPSE, width: diameter, height: diameter },
      fillType: enums().fill.SOLID,
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
          type: enums().shape.RECTANGLE,
          width: labelWidth,
          height: Math.round(config.fontSize * 0.9)
        },
        fillType: enums().fill.NONE,
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
      shape: { type: enums().shape.ELLIPSE, width: size, height: size },
      fillType: enums().fill.NONE,
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
      shape: { type: enums().shape.RECTANGLE, width: boxW, height: boxH },
      fillType: enums().fill.NONE,
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
      shape: { type: enums().shape.RECTANGLE, width: map.bounds.width, height: map.bounds.height },
      fillType: enums().fill.SOLID,
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
      shape: { type: enums().shape.RECTANGLE, width: boxW, height: boxH },
      fillType: enums().fill.NONE,
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

/**
 * Cria uma entrada de diário por nó, **restrita ao Mestre**.
 *
 * O nome da entrada revela o tipo da sala, então ela nasce com posse `NONE` para os
 * jogadores: eles não a veem na barra lateral nem por busca.
 *
 * @returns {Promise<Record<string,string>>} mapa nó -> id da entrada
 */
async function createJournalEntries(map, mapId, localize) {
  const config = map.config;
  const typeById = new Map(config.nodeTypes.map((ty) => [ty.id, ty]));

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
      ownership: { default: enums().ownershipNone },
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
  const byNode = {};
  created.forEach((entry, i) => {
    byNode[map.nodes[i].id] = entry.id;
  });
  return byNode;
}

/**
 * Dados de uma nota de mapa para um nó.
 *
 * `Note` **não tem campo `hidden`** em nenhuma versão do Foundry (conferido nos schemas
 * v13 e v14), por isso a nota de um nó oculto simplesmente **não é criada** — e é
 * removida se o nó voltar a ficar oculto. É o que garante que o nome da sala não apareça
 * no canvas antes da hora.
 */
function buildNoteData(node, map, mapId, localize, entryId) {
  const config = map.config;
  const type = config.nodeTypes.find((ty) => ty.id === node.typeId);
  const label = localize(type?.label ?? node.typeId);
  return {
    entryId: entryId ?? null,
    x: Math.round(node.x),
    y: Math.round(node.y),
    texture: { src: type?.icon || "icons/svg/book.svg" },
    iconSize: Math.max(32, Math.round(config.nodeRadius * 0.7)),
    text: `${label} (${node.floor})`,
    fontSize: Math.max(8, Math.round(config.fontSize * 0.5)),
    textAnchor: enums().textAnchorBottom,
    textColor: type?.color ?? "#ffffff",
    global: true,
    flags: flags(mapId, { [FLAG.KIND]: "note", node: node.id })
  };
}

/** Quais nós devem ter nota agora. */
function notesWanted(map, revealed) {
  const config = map.config;
  if (!config.createNotes) return new Set();
  if (!config.secretNodes) return new Set(map.nodes.map((n) => n.id));
  return new Set(map.nodes.filter((n) => revealed.has(n.id)).map((n) => n.id));
}

/* -------------------------------------------------------------------------- */
/*  Pintura                                                                   */
/* -------------------------------------------------------------------------- */

/** Versão enxuta do mapa, guardada na flag da cena para o controle de revelação. */
export function trimMap(map, mapId, journal = {}, origin = { x: 0, y: 0 }) {
  return {
    mapId,
    journal,
    origin,
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
    mapId: stored.mapId,
    origin: stored.origin ?? { x: 0, y: 0 },
    seed: stored.seed,
    config: stored.config,
    journal: stored.journal ?? {},
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
  const resize = config.target === "active" ? await applySceneSize(scene, map.bounds, config) : null;

  if (config.clearPrevious) await clearSceneMap(scene);

  const mapId = makeMapId();
  const authorId = game.user.id;
  const progress = createProgress(map, config, mapId);
  const revealed = new Set(progress.revealed);
  /** @type {Record<string,string>} nó -> id da entrada de diário */
  let journalByNode = {};

  const origin = sceneOrigin(scene, map.bounds);

  const drawings = [
    ...buildBackdrop(map, mapId, authorId),
    ...buildFloorLabels(map, mapId, authorId),
    ...buildEdgeDrawings(map, mapId, authorId, revealed),
    ...buildMarker(map, mapId, authorId, progress),
    ...buildNodeDrawings(map, mapId, authorId, localize, revealed)
  ];
  const tiles = buildIconTiles(map, mapId, revealed);

  // Tudo é construído em coordenadas do mapa (0,0 no canto do mapa) e só então deslocado
  // para a origem calculada dentro do retângulo da cena.
  offsetDocs(drawings, origin);
  offsetDocs(tiles, origin);

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
    if (config.createJournal) journalByNode = await createJournalEntries(map, mapId, localize);
    const wanted = notesWanted(map, revealed);
    const notes = offsetDocs(
      map.nodes
        .filter((n) => wanted.has(n.id))
        .map((n) => buildNoteData(n, map, mapId, localize, journalByNode[n.id])),
      origin
    );
    if (notes.length) {
      const made = await scene.createEmbeddedDocuments("Note", notes);
      created += made.length;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | erro ao pintar o mapa`, err);
    ui.notifications?.error(t("SPIREMAP.notify.paintError", { error: err.message }));
    return null;
  }

  await scene.setFlag(MODULE_ID, FLAG.MAP, trimMap(map, mapId, journalByNode, origin));
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
  if (resize?.changed && (resize.to.width || resize.to.height)) {
    ui.notifications?.info(
      t("SPIREMAP.notify.resized", {
        from: `${resize.from.width}×${resize.from.height}`,
        to: `${scene.width}×${scene.height}`
      })
    );
  }

  await applySceneFraming(scene, map.bounds, origin, config);
  await panToMap(scene, map.bounds, origin);

  return { scene, mapId, created, progress, resize, origin };
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
export async function applyProgressToScene(scene, map, progress, options = {}) {
  if (!scene || !map) return { updated: 0 };
  const localizeFn =
    options.localize ?? ((k) => (game.i18n?.has?.(k) ? game.i18n.localize(k) : k));
  const config = map.config;
  const revealed = new Set(progress?.revealed ?? []);
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  // A mesma origem usada ao pintar, para o marcador e as notas novas caírem no lugar.
  const origin = map.origin ?? sceneOrigin(scene, map.bounds);

  const drawingUpdates = [];
  const tileUpdates = [];

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
          x: Math.round(current.x - size / 2 + origin.x),
          y: Math.round(current.y - size / 2 + origin.y),
          shape: { type: enums().shape.ELLIPSE, width: size, height: size }
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

  /* Notas: como o documento Note não tem campo de visibilidade, a nota de um nó oculto
     não existe — é criada ao revelar e removida ao ocultar. */
  const wanted = notesWanted(map, revealed);
  const existingNotes = new Map();
  for (const doc of scene.getEmbeddedCollection("Note")) {
    const f = moduleFlags(doc);
    if (f[FLAG.KIND] === "note" && f[FLAG.MAP_ID]) existingNotes.set(f.node, doc.id);
  }
  const notesToCreate = offsetDocs(
    [...wanted]
      .filter((id) => !existingNotes.has(id) && nodeById.has(id))
      .map((id) =>
        buildNoteData(nodeById.get(id), map, map.mapId ?? progress?.mapId ?? "", localizeFn, map.journal?.[id])
      ),
    origin
  );
  const notesToDelete = [...existingNotes]
    .filter(([nodeId]) => !wanted.has(nodeId))
    .map(([, docId]) => docId);

  let touched = drawingUpdates.length + tileUpdates.length;
  try {
    if (drawingUpdates.length) await scene.updateEmbeddedDocuments("Drawing", drawingUpdates);
    if (tileUpdates.length) await scene.updateEmbeddedDocuments("Tile", tileUpdates);
    if (notesToDelete.length) {
      await scene.deleteEmbeddedDocuments("Note", notesToDelete);
      touched += notesToDelete.length;
    }
    if (notesToCreate.length) {
      await scene.createEmbeddedDocuments("Note", notesToCreate);
      touched += notesToCreate.length;
    }
    await scene.setFlag(MODULE_ID, FLAG.PROGRESS, progress);
  } catch (err) {
    console.error(`${MODULE_ID} | erro ao sincronizar a revelação`, err);
    ui.notifications?.error(t("SPIREMAP.notify.revealError", { error: err.message }));
  }

  return { updated: touched };
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
