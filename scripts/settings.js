/**
 * Registro de settings do módulo.
 * @module spire-map/settings
 */

import { MODULE_ID, SETTINGS, DEFAULT_CONFIG } from "./constants.js";
import { normalizeConfig } from "./generator.js";
import { SpireMapPanel } from "./apps/map-panel.js";
import { SpireRevealTracker } from "./apps/reveal-tracker.js";

export function registerSettings() {
  /* Configuração padrão persistida (editada pelo próprio painel). */
  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_CONFIG, {
    name: "Default config",
    scope: "world",
    config: false,
    type: Object,
    default: DEFAULT_CONFIG,
    onChange: () => {}
  });

  /* Presets salvos pelo usuário (reservado para uso futuro / macros). */
  game.settings.register(MODULE_ID, SETTINGS.PRESETS, {
    name: "Saved presets",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  /* Histórico de adversários derrotados nos nós de boss (mostrado no controle de revelação). */
  game.settings.register(MODULE_ID, SETTINGS.BOSS_HISTORY, {
    name: "Boss history",
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  /* Cena associada a cada tipo de sala — vale para todos os mapas do mundo. */
  game.settings.register(MODULE_ID, SETTINGS.TYPE_SCENES, {
    name: "Type scenes",
    scope: "world",
    config: false,
    type: Array,
    default: [],
    onChange: () => SpireRevealTracker.refreshIfOpen()
  });

  game.settings.register(MODULE_ID, SETTINGS.SHOW_SCENE_BUTTON, {
    name: "SPIREMAP.settings.showSceneButton.name",
    hint: "SPIREMAP.settings.showSceneButton.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_VOTE, {
    name: "SPIREMAP.settings.autoVote.name",
    hint: "SPIREMAP.settings.autoVote.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_NODE_SCENE, {
    name: "SPIREMAP.settings.autoNodeScene.name",
    hint: "SPIREMAP.settings.autoNodeScene.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTINGS.AUTO_PREVIEW, {
    name: "SPIREMAP.settings.autoPreview.name",
    hint: "SPIREMAP.settings.autoPreview.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  /* Botão "Abrir painel" dentro das configurações do módulo. */
  game.settings.registerMenu(MODULE_ID, "openPanel", {
    name: "SPIREMAP.settings.openPanel.name",
    label: "SPIREMAP.settings.openPanel.label",
    hint: "SPIREMAP.settings.openPanel.hint",
    icon: "fa-solid fa-diagram-project",
    type: SpireMapPanel,
    restricted: true
  });
}

/** Lê a configuração padrão do mundo, já sanitizada. */
export function getStoredConfig() {
  try {
    return normalizeConfig(game.settings.get(MODULE_ID, SETTINGS.DEFAULT_CONFIG));
  } catch (err) {
    console.warn(`${MODULE_ID} | configuração salva inválida, usando padrão`, err);
    return normalizeConfig({});
  }
}
