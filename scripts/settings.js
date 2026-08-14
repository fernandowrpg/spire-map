/**
 * Registro de settings do módulo.
 * @module spire-map/settings
 */

import { MODULE_ID, SETTINGS, DEFAULT_CONFIG } from "./constants.js";
import { normalizeConfig } from "./generator.js";
import { SpireMapPanel } from "./apps/map-panel.js";

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

  game.settings.register(MODULE_ID, SETTINGS.SHOW_SCENE_BUTTON, {
    name: "SPIREMAP.settings.showSceneButton.name",
    hint: "SPIREMAP.settings.showSceneButton.hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true
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
