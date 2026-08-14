/**
 * Painel de configuração e geração de mapas (ApplicationV2 — Foundry VTT v13).
 *
 * O painel é totalmente reativo: qualquer alteração em um campo atualiza o preview
 * imediatamente, sem re-renderizar o formulário (o foco do campo é preservado).
 *
 * @module spire-map/apps/map-panel
 */

import { MODULE_ID, SETTINGS, BUILTIN_PRESETS, DEFAULT_CONFIG, DEFAULT_NODE_TYPES } from "../constants.js";
import { generateMap, normalizeConfig, normalizeNodeTypes, isTraversable } from "../generator.js";
import { renderSvg } from "../renderer.js";
import { paintMap, clearSceneMap } from "../scene-painter.js";
import { randomSeedString } from "../rng.js";
import { createProgress, toFog } from "../progress.js";
import { smartLocalize } from "../i18n.js";
import { SpireRevealTracker } from "./reveal-tracker.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

export { smartLocalize };

const TABS = [
  { id: "structure", icon: "fa-solid fa-sitemap", label: "SPIREMAP.tabs.structure" },
  { id: "rules", icon: "fa-solid fa-scale-balanced", label: "SPIREMAP.tabs.rules" },
  { id: "types", icon: "fa-solid fa-shapes", label: "SPIREMAP.tabs.types" },
  { id: "secret", icon: "fa-solid fa-eye-slash", label: "SPIREMAP.tabs.secret" },
  { id: "look", icon: "fa-solid fa-palette", label: "SPIREMAP.tabs.look" },
  { id: "output", icon: "fa-solid fa-download", label: "SPIREMAP.tabs.output" }
];

export class SpireMapPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {SpireMapPanel|null} */
  static #instance = null;

  /** Abre (ou traz para frente) a única instância do painel. */
  static open(initialConfig = null) {
    if (!SpireMapPanel.#instance || SpireMapPanel.#instance.rendered === false) {
      SpireMapPanel.#instance = new SpireMapPanel(initialConfig ? { config: initialConfig } : {});
    }
    SpireMapPanel.#instance.render({ force: true });
    return SpireMapPanel.#instance;
  }

  constructor(options = {}) {
    super(options);
    const stored = game.settings.get(MODULE_ID, SETTINGS.DEFAULT_CONFIG);
    this.config = normalizeConfig(foundry.utils.mergeObject(
      foundry.utils.deepClone(DEFAULT_CONFIG),
      options.config ?? stored ?? {},
      { inplace: false }
    ));
    /** @type {string} aba ativa */
    this.activeTab = "structure";
    /** @type {Record<string,string>} sobrescritas manuais de tipo por nó */
    this.overrides = {};
    /** @type {import("../generator.js").SpireMap|null} */
    this.map = null;
    /** @type {string|null} */
    this.selectedNodeId = null;
    /** zoom do preview */
    this.zoom = 0.28;
    this._previewTimer = null;
  }

  static DEFAULT_OPTIONS = {
    id: "spire-map-panel",
    tag: "form",
    classes: ["spire-map", "spire-map-panel"],
    window: {
      title: "SPIREMAP.panel.title",
      icon: "fa-solid fa-diagram-project",
      resizable: true,
      contentClasses: ["spire-content"]
    },
    position: { width: 1080, height: 780 },
    form: {
      handler: SpireMapPanel.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      tab: SpireMapPanel.#onTab,
      refresh: SpireMapPanel.#onRefresh,
      randomSeed: SpireMapPanel.#onRandomSeed,
      paint: SpireMapPanel.#onPaint,
      clear: SpireMapPanel.#onClear,
      addType: SpireMapPanel.#onAddType,
      removeType: SpireMapPanel.#onRemoveType,
      moveType: SpireMapPanel.#onMoveType,
      resetTypes: SpireMapPanel.#onResetTypes,
      pickIcon: SpireMapPanel.#onPickIcon,
      saveDefaults: SpireMapPanel.#onSaveDefaults,
      resetAll: SpireMapPanel.#onResetAll,
      exportSvg: SpireMapPanel.#onExportSvg,
      exportJson: SpireMapPanel.#onExportJson,
      importJson: SpireMapPanel.#onImportJson,
      fitPreview: SpireMapPanel.#onFitPreview,
      clearOverrides: SpireMapPanel.#onClearOverrides,
      setNodeType: SpireMapPanel.#onSetNodeType,
      openTracker: SpireMapPanel.#onOpenTracker
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/map-panel.hbs`,
      scrollable: [".spire-form-scroll", ".spire-preview__stage"]
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Contexto                                                           */
  /* ------------------------------------------------------------------ */

  async _prepareContext(options) {
    this.#build();

    const c = this.config;
    const opts = (values, current) =>
      values.map((v) => ({ ...v, selected: String(v.value) === String(current) }));

    const typeValues = c.nodeTypes.map((t) => ({ value: t.id, label: smartLocalize(t.label) }));

    const selected = this.selectedNodeId
      ? this.map?.nodes.find((n) => n.id === this.selectedNodeId)
      : null;

    return {
      config: c,
      isGM: game.user?.isGM ?? false,
      tabs: TABS.map((t) => ({ ...t, active: t.id === this.activeTab })),
      activeTab: this.activeTab,
      tabActive: Object.fromEntries(TABS.map((t) => [t.id, t.id === this.activeTab])),
      presets: Object.entries(BUILTIN_PRESETS).map(([id, p]) => ({ id, label: p.label })),
      typeOptions: opts(typeValues, c.firstFloorType),
      bossTypeOptions: opts(typeValues, c.bossType),
      orientationOptions: opts(
        [
          { value: "up", label: "SPIREMAP.fields.orientationUp" },
          { value: "down", label: "SPIREMAP.fields.orientationDown" }
        ],
        c.orientation
      ),
      edgeStyleOptions: opts(
        [
          { value: "curved", label: "SPIREMAP.fields.edgeCurved" },
          { value: "straight", label: "SPIREMAP.fields.edgeStraight" }
        ],
        c.edgeStyle
      ),
      revealModeOptions: opts(
        [
          { value: "onChoice", label: "SPIREMAP.fields.revealModeOnChoice" },
          { value: "manual", label: "SPIREMAP.fields.revealModeManual" }
        ],
        c.revealMode
      ),
      fogPreview: Boolean(this.fogPreview),
      targetOptions: opts(
        [
          { value: "active", label: "SPIREMAP.fields.targetActive" },
          { value: "new", label: "SPIREMAP.fields.targetNew" }
        ],
        c.target
      ),
      nodeTypes: c.nodeTypes.map((t, index) => ({
        ...t,
        index,
        localized: smartLocalize(t.label),
        isFirst: index === 0,
        isLast: index === c.nodeTypes.length - 1
      })),
      totalWeight: c.nodeTypes.reduce((s, t) => s + (t.reserved ? 0 : t.weight), 0),
      mapInfo: this.map
        ? {
            seed: this.map.seed,
            nodes: this.map.nodes.length,
            edges: this.map.edges.length,
            floors: this.map.totalFloors,
            width: this.map.bounds.width,
            height: this.map.bounds.height,
            traversable: isTraversable(this.map),
            warnings: this.map.warnings.length
          }
        : null,
      selectedNode: selected
        ? {
            ...selected,
            label: smartLocalize(c.nodeTypes.find((t) => t.id === selected.typeId)?.label ?? selected.typeId),
            overridden: Boolean(this.overrides[selected.id]),
            options: typeValues.map((v) => ({ ...v, selected: v.value === selected.typeId }))
          }
        : null,
      overrideCount: Object.keys(this.overrides).length,
      zoom: this.zoom,
      zoomPercent: Math.round(this.zoom * 100)
    };
  }

  /** Gera o mapa atual e aplica sobrescritas manuais. */
  #build() {
    this.map = generateMap(this.config);
    if (Object.keys(this.overrides).length) {
      const valid = new Set(this.config.nodeTypes.map((t) => t.id));
      for (const node of this.map.nodes) {
        const override = this.overrides[node.id];
        if (override && valid.has(override)) node.typeId = override;
      }
      this.map.counts = this.map.nodes.reduce((acc, n) => {
        acc[n.typeId] = (acc[n.typeId] ?? 0) + 1;
        return acc;
      }, {});
    }
    // A seed efetiva volta para o campo, para que o mapa seja reproduzível.
    this.config.seed = this.map.seed;
    return this.map;
  }

  /* ------------------------------------------------------------------ */
  /*  Render / eventos                                                   */
  /* ------------------------------------------------------------------ */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // Sincroniza qualquer campo alterado direto no estado, sem re-render.
    // O elemento raiz sobrevive aos re-renders, então os listeners são ligados uma única vez.
    if (!this._formBound) {
      this._formBound = true;
      root.addEventListener("change", this.#onFieldChange.bind(this));
      root.addEventListener("input", this.#onFieldInput.bind(this));
    }

    // Seleção de nó no preview (o conteúdo é recriado a cada render).
    const stage = root.querySelector(".spire-preview__stage");
    stage?.addEventListener("click", (event) => {
      const group = event.target.closest?.("[data-node-id]");
      if (!group) return;
      this.selectedNodeId = group.dataset.nodeId;
      this.render();
    });

    // Zoom com a roda do mouse.
    stage?.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.shiftKey) return;
        event.preventDefault();
        this.zoom = Math.min(1.5, Math.max(0.05, this.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
        this.#applyZoom();
      },
      { passive: false }
    );

    this.#renderPreview();

    // No primeiro render, ajusta o zoom para o mapa caber inteiro.
    if (!this._didFit) {
      this._didFit = true;
      requestAnimationFrame(() => SpireMapPanel.#fit.call(this));
    }
  }

  /** Ajusta o zoom para o mapa inteiro caber na área de preview. */
  static #fit() {
    const stage = this.element?.querySelector(".spire-preview__stage");
    if (!stage || !this.map) return;
    const pad = 26;
    const scaleW = (stage.clientWidth - pad) / this.map.bounds.width;
    const scaleH = (stage.clientHeight - pad) / this.map.bounds.height;
    this.zoom = Math.max(0.05, Math.min(1.5, Math.min(scaleW, scaleH)));
    this.#applyZoom();
  }

  /** Aplica o zoom atual ao SVG do preview. */
  #applyZoom() {
    const svg = this.element?.querySelector(".spire-preview__stage svg");
    if (!svg || !this.map) return;
    svg.style.width = `${Math.round(this.map.bounds.width * this.zoom)}px`;
    svg.style.height = "auto";
    const readout = this.element.querySelector(".spire-zoom-readout");
    if (readout) readout.textContent = `${Math.round(this.zoom * 100)}%`;
    const slider = this.element.querySelector('input[name="__zoom"]');
    if (slider) slider.value = String(this.zoom);
  }

  /** Redesenha apenas o SVG e os números, sem tocar no formulário. */
  #renderPreview() {
    const stage = this.element?.querySelector(".spire-preview__stage");
    if (!stage) return;
    if (!this.map) this.#build();

    // Com o "olho" ligado, o preview mostra exatamente o que os jogadores veriam
    // no início do mapa (nós ocultos como "?").
    const fog =
      this.fogPreview && this.config.secretNodes
        ? toFog(this.map, createProgress(this.map, this.config, "preview"), { gmView: false })
        : null;

    stage.innerHTML = renderSvg(this.map, {
      localize: smartLocalize,
      interactive: true,
      highlightId: this.selectedNodeId,
      fog
    });
    this.#applyZoom();

    const info = this.element.querySelector(".spire-readout");
    if (info) {
      info.textContent = game.i18n.format("SPIREMAP.preview.summary", {
        nodes: this.map.nodes.length,
        edges: this.map.edges.length,
        floors: this.map.totalFloors,
        width: this.map.bounds.width,
        height: this.map.bounds.height
      });
    }
    const seedField = this.element.querySelector('input[name="seed"]');
    if (seedField && seedField.value !== this.map.seed) seedField.value = this.map.seed;

    this.#refreshStats();
  }

  /** Regeração debounced do preview enquanto o usuário digita/arrasta. */
  #schedulePreview(delay = 120) {
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => {
      this.config = normalizeConfig(this.config);
      this.#build();
      this.#renderPreview();
      this.#refreshStats();
    }, delay);
  }

  /** Atualiza a tabela de estatísticas sem re-render completo. */
  #refreshStats() {
    const host = this.element?.querySelector(".spire-stats");
    if (!host || !this.map) return;
    const rows = Object.entries(this.map.counts)
      .map(([typeId, count]) => {
        const type = this.config.nodeTypes.find((t) => t.id === typeId);
        return { typeId, count, type };
      })
      .sort((a, b) => b.count - a.count);
    host.innerHTML = rows
      .map(
        ({ typeId, count, type }) => `
        <div class="spire-stat" data-type="${typeId}">
          <span class="spire-chip" style="background:${type?.fill ?? "#666"};color:${type?.color ?? "#fff"}">${
            type?.symbol ?? "?"
          }</span>
          <span class="spire-stat__label">${smartLocalize(type?.label ?? typeId)}</span>
          <span class="spire-stat__count">${count}</span>
          <span class="spire-stat__pct">${Math.round((count / this.map.nodes.length) * 100)}%</span>
        </div>`
      )
      .join("");
  }

  /** Campos que exigem re-render completo do formulário. */
  static #STRUCTURAL_FIELDS = new Set(["__preset"]);

  #onFieldInput(event) {
    const el = event.target;
    if (!el?.name) return;
    if (el.name === "__zoom") {
      this.zoom = Number(el.value);
      this.#applyZoom();
      return;
    }
    // ID e nome dos tipos só são aplicados no "change" (evitam re-render a cada tecla).
    if (/^nodeTypes\.\d+\.(id|label)$/.test(el.name)) return;
    if (el.type === "range" || el.type === "number" || el.type === "text" || el.type === "color") {
      this.#assign(el);
      this.#schedulePreview(el.type === "text" ? 350 : 90);
    }
  }

  async #onFieldChange(event) {
    const el = event.target;
    if (!el?.name) return;

    if (el.name === "__preset") {
      const preset = BUILTIN_PRESETS[el.value];
      if (preset) {
        Object.assign(this.config, foundry.utils.deepClone(preset.config));
        this.config = normalizeConfig(this.config);
        this.overrides = {};
        await this.render();
      }
      el.value = "";
      return;
    }
    if (el.name === "__nodeTypeOverride") {
      if (this.selectedNodeId) {
        if (el.value) this.overrides[this.selectedNodeId] = el.value;
        else delete this.overrides[this.selectedNodeId];
        await this.render();
      }
      return;
    }
    if (el.name === "__zoom") return;
    if (el.name === "__fog") {
      this.fogPreview = el.checked;
      this.#renderPreview();
      return;
    }

    // O campo "nome" mostra o texto já traduzido; se o usuário não mexeu, mantém a
    // chave de tradução original (assim o tipo continua bilíngue).
    const labelField = el.name.match(/^nodeTypes\.(\d+)\.label$/);
    if (labelField) {
      const current = this.config.nodeTypes[Number(labelField[1])]?.label ?? "";
      if (el.value.trim() === smartLocalize(current).trim()) return;
    }

    this.#assign(el);

    // Alterar a lista de tipos ou campos que mudam a UI exige re-render.
    const needsRerender =
      SpireMapPanel.#STRUCTURAL_FIELDS.has(el.name) ||
      /^nodeTypes\.\d+\.(id|label|reserved)$/.test(el.name);

    if (needsRerender) {
      this.config = normalizeConfig(this.config);
      await this.render();
    } else {
      this.#schedulePreview(0);
    }
  }

  /** Escreve o valor de um input no objeto de configuração. */
  #assign(el) {
    let value;
    switch (el.type) {
      case "checkbox":
        value = el.checked;
        break;
      case "number":
      case "range":
        value = el.value === "" ? 0 : Number(el.value);
        break;
      default:
        value = el.value;
    }
    foundry.utils.setProperty(this.config, el.name, value);
  }

  /* ------------------------------------------------------------------ */
  /*  Ações                                                              */
  /* ------------------------------------------------------------------ */

  static async #onSubmit(event, form, formData) {
    // O painel aplica tudo em tempo real; o submit apenas pinta o mapa.
    await SpireMapPanel.#onPaint.call(this, event, form);
  }

  static #onTab(event, target) {
    this.activeTab = target.dataset.tab;
    this.render();
  }

  static #onRefresh() {
    this.overrides = {};
    this.#build();
    this.#renderPreview();
    this.#refreshStats();
  }

  static #onRandomSeed() {
    this.config.seed = randomSeedString();
    this.overrides = {};
    const field = this.element.querySelector('input[name="seed"]');
    if (field) field.value = this.config.seed;
    this.#build();
    this.#renderPreview();
    this.#refreshStats();
  }

  static async #onPaint() {
    if (!game.user.isGM) return ui.notifications.warn(game.i18n.localize("SPIREMAP.notify.gmOnly"));
    if (!this.map) this.#build();
    const result = await paintMap(this.map, { localize: smartLocalize });
    if (!result) return;
    if (this.config.target === "new") await result.scene.view?.();
    SpireRevealTracker.refreshIfOpen();
    // Com nós secretos, o Mestre precisa do controle de revelação — abre junto.
    if (this.config.secretNodes) SpireRevealTracker.open();
  }

  static #onOpenTracker() {
    SpireRevealTracker.open();
  }

  static async #onClear() {
    const scene = game.scenes?.active ?? canvas?.scene;
    if (!scene) return ui.notifications.warn(game.i18n.localize("SPIREMAP.notify.noActiveScene"));
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("SPIREMAP.buttons.clear") },
      content: `<p>${game.i18n.format("SPIREMAP.notify.confirmClear", { scene: scene.name })}</p>`
    });
    if (!confirmed) return;
    const removed = await clearSceneMap(scene);
    ui.notifications.info(game.i18n.format("SPIREMAP.notify.cleared", { count: removed }));
  }

  static async #onAddType() {
    const base = {
      id: `custom-${this.config.nodeTypes.length + 1}`,
      label: game.i18n.localize("SPIREMAP.types.newLabel"),
      symbol: "•",
      color: "#f0e6d2",
      fill: "#4b5d3a",
      icon: "",
      weight: 10,
      minFloor: 1,
      maxPerFloor: 0,
      maxTotal: 0,
      noRepeatOnPath: false,
      reserved: false
    };
    this.config.nodeTypes.push(base);
    this.config = normalizeConfig(this.config);
    await this.render();
  }

  static async #onRemoveType(event, target) {
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index)) return;
    if (this.config.nodeTypes.length <= 1) {
      return ui.notifications.warn(game.i18n.localize("SPIREMAP.notify.needOneType"));
    }
    const removed = this.config.nodeTypes.splice(index, 1)[0];
    for (const [nodeId, typeId] of Object.entries(this.overrides)) {
      if (typeId === removed?.id) delete this.overrides[nodeId];
    }
    this.config = normalizeConfig(this.config);
    await this.render();
  }

  static async #onMoveType(event, target) {
    const index = Number(target.dataset.index);
    const dir = target.dataset.dir === "up" ? -1 : 1;
    const next = index + dir;
    const list = this.config.nodeTypes;
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    await this.render();
  }

  static async #onResetTypes() {
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("SPIREMAP.buttons.resetTypes") },
      content: `<p>${game.i18n.localize("SPIREMAP.notify.confirmResetTypes")}</p>`
    });
    if (!confirmed) return;
    this.config.nodeTypes = DEFAULT_NODE_TYPES.map((t) => ({ ...t }));
    this.config = normalizeConfig(this.config);
    this.overrides = {};
    await this.render();
  }

  static async #onPickIcon(event, target) {
    const index = Number(target.dataset.index);
    const current = this.config.nodeTypes[index]?.icon ?? "";
    const FP = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    if (!FP) return ui.notifications.warn("FilePicker indisponível.");
    const picker = new FP({
      type: "image",
      current,
      callback: async (path) => {
        this.config.nodeTypes[index].icon = path;
        await this.render();
      }
    });
    picker.render(true);
  }

  static async #onSaveDefaults() {
    await game.settings.set(MODULE_ID, SETTINGS.DEFAULT_CONFIG, normalizeConfig(this.config));
    ui.notifications.info(game.i18n.localize("SPIREMAP.notify.defaultsSaved"));
  }

  static async #onResetAll() {
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("SPIREMAP.buttons.resetAll") },
      content: `<p>${game.i18n.localize("SPIREMAP.notify.confirmResetAll")}</p>`
    });
    if (!confirmed) return;
    this.config = normalizeConfig(foundry.utils.deepClone(DEFAULT_CONFIG));
    this.overrides = {};
    this.selectedNodeId = null;
    await this.render();
  }

  static #onExportSvg() {
    if (!this.map) this.#build();
    const svg = renderSvg(this.map, { localize: smartLocalize, standalone: true, interactive: false });
    const name = `spire-map-${this.map.seed}.svg`;
    SpireMapPanel.#download(svg, name, "image/svg+xml");
  }

  static #onExportJson() {
    const payload = JSON.stringify(
      { module: MODULE_ID, version: 1, config: normalizeConfig(this.config), overrides: this.overrides },
      null,
      2
    );
    SpireMapPanel.#download(payload, `spire-map-config.json`, "application/json");
  }

  static async #onImportJson() {
    const content = `<p>${game.i18n.localize("SPIREMAP.notify.importHint")}</p>
      <textarea name="payload" rows="10" style="width:100%;font-family:monospace"></textarea>`;
    const result = await DialogV2.prompt({
      window: { title: game.i18n.localize("SPIREMAP.buttons.importJson") },
      content,
      ok: {
        label: game.i18n.localize("SPIREMAP.buttons.import"),
        callback: (event, button) => button.form.elements.payload.value
      },
      rejectClose: false
    });
    if (!result) return;
    try {
      const parsed = JSON.parse(result);
      const incoming = parsed.config ?? parsed;
      this.config = normalizeConfig(incoming);
      this.overrides = parsed.overrides && typeof parsed.overrides === "object" ? parsed.overrides : {};
      this.selectedNodeId = null;
      await this.render();
      ui.notifications.info(game.i18n.localize("SPIREMAP.notify.imported"));
    } catch (err) {
      ui.notifications.error(game.i18n.format("SPIREMAP.notify.importError", { error: err.message }));
    }
  }

  static #onFitPreview() {
    SpireMapPanel.#fit.call(this);
  }

  static async #onClearOverrides() {
    this.overrides = {};
    this.selectedNodeId = null;
    await this.render();
  }

  static async #onSetNodeType(event, target) {
    const typeId = target.dataset.typeId;
    if (!this.selectedNodeId || !typeId) return;
    this.overrides[this.selectedNodeId] = typeId;
    await this.render();
  }

  /** Download de um arquivo gerado no cliente. */
  static #download(text, filename, mime) {
    const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
    if (save) return save(text, mime, filename);
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async close(options) {
    clearTimeout(this._previewTimer);
    SpireMapPanel.#instance = null;
    return super.close(options);
  }
}
