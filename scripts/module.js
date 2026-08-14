/**
 * Spire Map — gerador de mapas estilo Slay the Spire para Foundry VTT v13.
 *
 * Ponto de entrada: registra settings, o botão de controles de cena, o atalho de
 * teclado e a API pública usada por macros.
 *
 * @module spire-map
 */

import { MODULE_ID, SETTINGS, DEFAULT_CONFIG, DEFAULT_NODE_TYPES, BUILTIN_PRESETS } from "./constants.js";
import { generateMap, normalizeConfig, normalizeNodeTypes, isTraversable, edgePoints } from "./generator.js";
import { renderSvg } from "./renderer.js";
import {
  paintMap,
  clearSceneMap,
  chooseNode,
  setProgress,
  readSceneMap,
  applyProgressToScene
} from "./scene-painter.js";
import * as ProgressLib from "./progress.js";
import { SpireMapPanel } from "./apps/map-panel.js";
import { SpireRevealTracker } from "./apps/reveal-tracker.js";
import { smartLocalize } from "./i18n.js";
import { registerSettings, getStoredConfig } from "./settings.js";
import { Rng, randomSeedString } from "./rng.js";

const log = (...args) => console.log(`${MODULE_ID} |`, ...args);

/* -------------------------------------------------------------------------- */
/*  init                                                                      */
/* -------------------------------------------------------------------------- */

Hooks.once("init", async () => {
  registerSettings();

  const loader =
    foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates ?? null;
  if (loader) {
    try {
      await loader([
        `modules/${MODULE_ID}/templates/map-panel.hbs`,
        `modules/${MODULE_ID}/templates/reveal-tracker.hbs`
      ]);
    } catch (err) {
      console.warn(`${MODULE_ID} | falha ao pré-carregar templates`, err);
    }
  }

  game.keybindings.register(MODULE_ID, "openPanel", {
    name: "SPIREMAP.keybindings.openPanel",
    editable: [{ key: "KeyM", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => {
      SpireMapPanel.open();
      return true;
    }
  });

  game.keybindings.register(MODULE_ID, "openTracker", {
    name: "SPIREMAP.keybindings.openTracker",
    editable: [{ key: "KeyR", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => {
      SpireRevealTracker.open();
      return true;
    }
  });

  /* ----------------------------- API pública ----------------------------- */
  const api = {
    /** Abre o painel de configuração. */
    open: (config) => SpireMapPanel.open(config),

    /** Gera um mapa (sem desenhar). */
    generate: (config) => generateMap({ ...getStoredConfig(), ...(config ?? {}) }),

    /** Gera e desenha na cena de uma vez. */
    async generateAndPaint(config) {
      const map = generateMap({ ...getStoredConfig(), ...(config ?? {}) });
      const result = await paintMap(map, { localize: smartLocalize });
      return { map, result };
    },

    /** Desenha um mapa já gerado. */
    paint: (map) => paintMap(map, { localize: smartLocalize }),

    /** Limpa os desenhos do módulo de uma cena. */
    clear: (scene = game.scenes?.active, mapId = null) => clearSceneMap(scene, mapId),

    /** Renderiza um mapa como string SVG. */
    toSvg: (map, options) => renderSvg(map, { localize: smartLocalize, ...(options ?? {}) }),

    /* ------------------------- revelação / progresso ------------------------ */

    /** Abre o controle de revelação (Mestre). */
    openTracker: () => SpireRevealTracker.open(),

    /** Mapa + progresso guardados em uma cena. */
    read: (scene = canvas?.scene ?? game.scenes?.active) => readSceneMap(scene),

    /** Marca a escolha dos jogadores e revela o que for devido. */
    choose: (nodeId, options = {}) =>
      chooseNode(options.scene ?? canvas?.scene ?? game.scenes?.active, nodeId, options),

    /** Revela nós específicos. */
    async revealNodes(nodeIds, scene = canvas?.scene ?? game.scenes?.active) {
      const data = readSceneMap(scene);
      if (!data) return { ok: false, error: "noMap" };
      const progress = data.progress ?? ProgressLib.createProgress(data.map, data.map.config, data.mapId);
      return setProgress(scene, ProgressLib.reveal(data.map, progress, [].concat(nodeIds)));
    },

    /** Revela o mapa inteiro. */
    async revealAll(scene = canvas?.scene ?? game.scenes?.active) {
      const data = readSceneMap(scene);
      if (!data) return { ok: false, error: "noMap" };
      return setProgress(scene, ProgressLib.revealAll(data.map, data.progress ?? {}));
    },

    /** Oculta tudo o que o grupo não visitou. */
    async hideUnvisited(scene = canvas?.scene ?? game.scenes?.active) {
      const data = readSceneMap(scene);
      if (!data) return { ok: false, error: "noMap" };
      const progress = data.progress ?? ProgressLib.createProgress(data.map, data.map.config, data.mapId);
      return setProgress(scene, ProgressLib.hideUnvisited(data.map, progress));
    },

    /** Zera o progresso do grupo. */
    async resetProgress(scene = canvas?.scene ?? game.scenes?.active) {
      const data = readSceneMap(scene);
      if (!data) return { ok: false, error: "noMap" };
      const progress = data.progress ?? ProgressLib.createProgress(data.map, data.map.config, data.mapId);
      return setProgress(scene, ProgressLib.resetProgress(data.map, progress, data.map.config));
    },

    /** Reaplica o estado atual aos documentos da cena. */
    async resync(scene = canvas?.scene ?? game.scenes?.active) {
      const data = readSceneMap(scene);
      if (!data) return { ok: false, error: "noMap" };
      return applyProgressToScene(scene, data.map, data.progress ?? {});
    },

    /** Biblioteca pura de progresso (funções sem efeito colateral). */
    progress: ProgressLib,

    /** Utilidades expostas para macros avançadas. */
    utils: {
      normalizeConfig,
      normalizeNodeTypes,
      isTraversable,
      edgePoints,
      randomSeedString,
      Rng,
      getStoredConfig
    },

    /** Constantes. */
    DEFAULT_CONFIG,
    DEFAULT_NODE_TYPES,
    BUILTIN_PRESETS,
    PANEL: SpireMapPanel,
    TRACKER: SpireRevealTracker
  };

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  globalThis.SpireMap = api;

  log("inicializado");
});

/* -------------------------------------------------------------------------- */
/*  ready                                                                     */
/* -------------------------------------------------------------------------- */

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  log(`pronto — abra o painel com Alt+M ou pelo botão na barra de ferramentas.`);
});

/* -------------------------------------------------------------------------- */
/*  Botão na barra de controles de cena                                       */
/* -------------------------------------------------------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;
  try {
    if (!game.settings.get(MODULE_ID, SETTINGS.SHOW_SCENE_BUTTON)) return;
  } catch (err) {
    /* settings ainda não registradas — segue com o botão visível */
  }

  const tools = [
    {
      name: "spire-map-open",
      title: "SPIREMAP.panel.title",
      icon: "fa-solid fa-diagram-project",
      order: 98,
      button: true,
      visible: true,
      toggle: false,
      onClick: () => SpireMapPanel.open(),
      onChange: () => SpireMapPanel.open()
    },
    {
      name: "spire-map-reveal",
      title: "SPIREMAP.reveal.title",
      icon: "fa-solid fa-eye",
      order: 99,
      button: true,
      visible: true,
      toggle: false,
      onClick: () => SpireRevealTracker.open(),
      onChange: () => SpireRevealTracker.open()
    }
  ];

  // v13 usa um registro (objeto); versões anteriores usavam array.
  const group = Array.isArray(controls)
    ? (controls.find((c) => c.name === "drawings" || c.layer === "drawings") ?? controls[0])
    : (controls.drawings ?? controls.tokens ?? Object.values(controls)[0]);
  if (!group) return;

  for (const tool of tools) {
    if (Array.isArray(group.tools)) group.tools.push(tool);
    else group.tools[tool.name] = tool;
  }
});

/* -------------------------------------------------------------------------- */
/*  Contexto do nó ao clicar em um desenho do mapa (informativo)              */
/* -------------------------------------------------------------------------- */

Hooks.on("renderDrawingConfig", (app, html) => {
  const node = app.document?.getFlag?.(MODULE_ID, "node");
  if (!node) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const target = root?.querySelector(".window-content, form");
  if (!target) return;
  const info = document.createElement("p");
  info.className = "notification info";
  info.textContent = game.i18n.format("SPIREMAP.notify.nodeInfo", {
    label: node.label ?? node.typeId,
    floor: node.floor,
    column: (node.col ?? 0) + 1
  });
  target.prepend(info);
});
