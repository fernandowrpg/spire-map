/**
 * Controle de revelação (só Mestre).
 *
 * Mostra o mapa desenhado na cena com o "nevoeiro" aplicado — o Mestre vê os tipos
 * reais esmaecidos, os jogadores veem apenas o que foi revelado na cena — e permite
 * marcar a escolha dos jogadores, revelar/ocultar nós e andares, voltar um passo e
 * reiniciar o progresso.
 *
 * @module spire-map/apps/reveal-tracker
 */

import { MODULE_ID, FLAG, NODE_STATE } from "../constants.js";
import { renderSvg } from "../renderer.js";
import {
  readSceneMap,
  chooseNode,
  setProgress,
  applyProgressToScene
} from "../scene-painter.js";
import {
  createProgress,
  nodeStates,
  progressSummary,
  toFog,
  toggleReveal,
  revealAll,
  revealFloor,
  hideUnvisited,
  resetProgress,
  stepBack,
  applyLookahead
} from "../progress.js";
import { smartLocalize } from "../i18n.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Rótulo de cada estado. */
const STATE_LABEL = {
  [NODE_STATE.HIDDEN]: "SPIREMAP.reveal.stateHidden",
  [NODE_STATE.REVEALED]: "SPIREMAP.reveal.stateRevealed",
  [NODE_STATE.AVAILABLE]: "SPIREMAP.reveal.stateAvailable",
  [NODE_STATE.VISITED]: "SPIREMAP.reveal.stateVisited",
  [NODE_STATE.CURRENT]: "SPIREMAP.reveal.stateCurrent"
};

export class SpireRevealTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {SpireRevealTracker|null} */
  static #instance = null;

  static open() {
    if (!SpireRevealTracker.#instance) SpireRevealTracker.#instance = new SpireRevealTracker();
    SpireRevealTracker.#instance.render({ force: true });
    return SpireRevealTracker.#instance;
  }

  /** Fecha e reabre se já estiver aberto (usado após pintar um mapa novo). */
  static refreshIfOpen() {
    if (SpireRevealTracker.#instance?.rendered) SpireRevealTracker.#instance.render();
  }

  constructor(options = {}) {
    super(options);
    this.selectedNodeId = null;
    this.zoom = 0.3;
    this._didFit = false;
    this._onSceneUpdate = this.#onSceneUpdate.bind(this);
    Hooks.on("updateScene", this._onSceneUpdate);
    Hooks.on("canvasReady", this._onSceneUpdate);
  }

  static DEFAULT_OPTIONS = {
    id: "spire-reveal-tracker",
    tag: "div",
    classes: ["spire-map", "spire-reveal"],
    window: {
      title: "SPIREMAP.reveal.title",
      icon: "fa-solid fa-eye",
      resizable: true,
      contentClasses: ["spire-content"]
    },
    position: { width: 760, height: 720 },
    actions: {
      choose: SpireRevealTracker.#onChoose,
      forceMove: SpireRevealTracker.#onForceMove,
      toggle: SpireRevealTracker.#onToggle,
      select: SpireRevealTracker.#onSelect,
      revealFloor: SpireRevealTracker.#onRevealFloor,
      revealAll: SpireRevealTracker.#onRevealAll,
      hideUnvisited: SpireRevealTracker.#onHideUnvisited,
      stepBack: SpireRevealTracker.#onStepBack,
      reset: SpireRevealTracker.#onReset,
      resync: SpireRevealTracker.#onResync,
      fit: SpireRevealTracker.#onFit
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/reveal-tracker.hbs`,
      scrollable: [".spire-reveal__list", ".spire-reveal__stage"]
    }
  };

  /** Cena observada: a que está sendo visualizada. */
  get scene() {
    return canvas?.scene ?? game.scenes?.active ?? null;
  }

  #onSceneUpdate(scene, changes) {
    if (!this.rendered) return;
    if (scene?.id && this.scene?.id && scene.id !== this.scene.id) return;
    if (changes && !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
    this.render();
  }

  /* ------------------------------------------------------------------ */

  async _prepareContext() {
    const scene = this.scene;
    const data = scene ? readSceneMap(scene) : null;

    if (!data) {
      return { hasMap: false, sceneName: scene?.name ?? "—" };
    }

    const { map } = data;
    const progress = data.progress ?? createProgress(map, map.config, data.mapId);
    const states = nodeStates(map, progress);
    const summary = progressSummary(map, progress);
    const typeById = new Map(map.config.nodeTypes.map((t) => [t.id, t]));

    const describe = (node) => {
      const type = typeById.get(node.typeId);
      const state = states.get(node.id);
      return {
        id: node.id,
        floor: node.floor,
        col: node.col + 1,
        typeId: node.typeId,
        label: smartLocalize(type?.label ?? node.typeId),
        symbol: type?.symbol ?? "?",
        fill: type?.fill ?? "#555555",
        color: type?.color ?? "#ffffff",
        state,
        stateLabel: game.i18n.localize(STATE_LABEL[state] ?? state),
        isHidden: state === NODE_STATE.HIDDEN,
        isCurrent: state === NODE_STATE.CURRENT,
        isAvailable: state === NODE_STATE.AVAILABLE,
        isVisited: state === NODE_STATE.VISITED || state === NODE_STATE.CURRENT,
        revealed: (progress.revealed ?? []).includes(node.id),
        isBoss: node.isBoss
      };
    };

    // Andares de cima para baixo (como o mapa aparece na cena).
    const floors = [];
    for (let floor = map.totalFloors; floor >= 1; floor--) {
      const nodes = (map.byFloor[floor - 1] ?? []).map(describe);
      if (!nodes.length) continue;
      floors.push({
        floor,
        isTop: floor === map.totalFloors && map.config.bossEnabled,
        allRevealed: nodes.every((n) => n.revealed),
        hasCurrent: nodes.some((n) => n.isCurrent),
        nodes
      });
    }

    const current = map.nodes.find((n) => n.id === progress.current);
    const available = (progress.available ?? [])
      .map((id) => map.nodes.find((n) => n.id === id))
      .filter(Boolean)
      .map(describe);
    const selected = this.selectedNodeId
      ? map.nodes.find((n) => n.id === this.selectedNodeId)
      : null;

    this._map = map;
    this._progress = progress;

    return {
      hasMap: true,
      sceneName: scene.name,
      seed: map.seed,
      secret: Boolean(map.config.secretNodes),
      summary,
      currentLabel: current ? describe(current) : null,
      available,
      floors,
      selected: selected ? describe(selected) : null,
      modeOptions: [
        { value: "onChoice", label: "SPIREMAP.fields.revealModeOnChoice", selected: progress.mode === "onChoice" },
        { value: "manual", label: "SPIREMAP.fields.revealModeManual", selected: progress.mode === "manual" }
      ],
      lookahead: progress.lookahead ?? 1,
      zoomPercent: Math.round(this.zoom * 100)
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    if (!context.hasMap) return;

    const root = this.element;

    if (!this._bound) {
      this._bound = true;
      root.addEventListener("change", (event) => this.#onFieldChange(event));
    }

    const stage = root.querySelector(".spire-reveal__stage");
    if (stage) {
      stage.innerHTML = renderSvg(this._map, {
        localize: smartLocalize,
        interactive: true,
        highlightId: this.selectedNodeId,
        fog: toFog(this._map, this._progress, { gmView: true })
      });
      this.#applyZoom();

      stage.addEventListener("click", async (event) => {
        const group = event.target.closest?.("[data-node-id]");
        if (!group) return;
        const nodeId = group.dataset.nodeId;
        const fresh = this.#fresh();
        if (!fresh) return;
        const state = nodeStates(fresh.map, fresh.progress).get(nodeId);
        // Clique em uma opção disponível avança direto; nos outros nós, seleciona.
        if (state === NODE_STATE.AVAILABLE && !event.shiftKey) {
          await this.#choose(nodeId);
        } else {
          this.selectedNodeId = nodeId;
          this.render();
        }
      });

      stage.addEventListener(
        "wheel",
        (event) => {
          if (!event.ctrlKey && !event.shiftKey) return;
          event.preventDefault();
          this.zoom = Math.min(1.5, Math.max(0.05, this.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
          this.#applyZoom();
        },
        { passive: false }
      );

      if (!this._didFit) {
        this._didFit = true;
        requestAnimationFrame(() => SpireRevealTracker.#onFit.call(this));
      }
    }
  }

  #applyZoom() {
    const svg = this.element?.querySelector(".spire-reveal__stage svg");
    if (!svg || !this._map) return;
    svg.style.width = `${Math.round(this._map.bounds.width * this.zoom)}px`;
    svg.style.height = "auto";
    const readout = this.element.querySelector(".spire-zoom-readout");
    if (readout) readout.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  async #onFieldChange(event) {
    const el = event.target;
    if (!el?.name || !this._map) return;

    if (el.name === "__mode" || el.name === "__lookahead") {
      const state = this.#fresh();
      if (!state) return;
      const progress = {
        ...state.progress,
        mode: el.name === "__mode" ? el.value : state.progress.mode,
        lookahead: el.name === "__lookahead" ? Number(el.value) : state.progress.lookahead
      };
      progress.revealed = applyLookahead(state.map, progress);
      await setProgress(this.scene, progress);
      this.render();
    }
  }

  /* ------------------------------- ações ------------------------------ */

  /**
   * Relê mapa e progresso direto da cena antes de qualquer ação.
   * Evita agir sobre um estado velho se outra janela, macro ou Mestre mexeu no mapa.
   * @returns {{map: object, progress: object}|null}
   */
  #fresh() {
    const data = readSceneMap(this.scene);
    if (!data) return null;
    this._map = data.map;
    this._progress = data.progress ?? createProgress(data.map, data.map.config, data.mapId);
    return { map: this._map, progress: this._progress };
  }

  async #choose(nodeId, force = false) {
    const result = await chooseNode(this.scene, nodeId, { force });
    if (!result.ok) {
      const key = `SPIREMAP.reveal.error.${result.error}`;
      ui.notifications.warn(game.i18n.has(key) ? game.i18n.localize(key) : result.error);
      return;
    }
    this.selectedNodeId = null;
    if (result.revealedNow?.length) {
      ui.notifications.info(
        game.i18n.format("SPIREMAP.reveal.revealedCount", { count: result.revealedNow.length })
      );
    }
    this.render();
  }

  static async #onChoose(event, target) {
    await this.#choose(target.dataset.nodeId ?? this.selectedNodeId);
  }

  static async #onForceMove(event, target) {
    await this.#choose(target.dataset.nodeId ?? this.selectedNodeId, true);
  }

  static async #onToggle(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    if (!nodeId || !state) return;
    await setProgress(this.scene, toggleReveal(state.map, state.progress, nodeId));
    this.render();
  }

  static #onSelect(event, target) {
    this.selectedNodeId = target.dataset.nodeId;
    this.render();
  }

  static async #onRevealFloor(event, target) {
    const floor = Number(target.dataset.floor);
    const state = this.#fresh();
    if (!Number.isInteger(floor) || !state) return;
    await setProgress(this.scene, revealFloor(state.map, state.progress, floor));
    this.render();
  }

  static async #onRevealAll() {
    const state = this.#fresh();
    if (!state) return;
    await setProgress(this.scene, revealAll(state.map, state.progress));
    this.render();
  }

  static async #onHideUnvisited() {
    const state = this.#fresh();
    if (!state) return;
    await setProgress(this.scene, hideUnvisited(state.map, state.progress));
    this.render();
  }

  static async #onStepBack() {
    const state = this.#fresh();
    if (!state) return;
    await setProgress(this.scene, stepBack(state.map, state.progress));
    this.selectedNodeId = null;
    this.render();
  }

  static async #onReset() {
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("SPIREMAP.reveal.reset") },
      content: `<p>${game.i18n.localize("SPIREMAP.reveal.confirmReset")}</p>`
    });
    if (!confirmed) return;
    const state = this.#fresh();
    if (!state) return;
    await setProgress(this.scene, resetProgress(state.map, state.progress, state.map.config));
    this.selectedNodeId = null;
    this.render();
  }

  /** Reaplica o estado atual a todos os documentos (útil se alguém editou a cena). */
  static async #onResync() {
    const state = this.#fresh();
    if (!state) return;
    const result = await applyProgressToScene(this.scene, state.map, state.progress);
    ui.notifications.info(
      game.i18n.format("SPIREMAP.reveal.resynced", { count: result.updated })
    );
    this.render();
  }

  static #onFit() {
    const stage = this.element?.querySelector(".spire-reveal__stage");
    if (!stage || !this._map) return;
    const pad = 26;
    const scaleW = (stage.clientWidth - pad) / this._map.bounds.width;
    const scaleH = (stage.clientHeight - pad) / this._map.bounds.height;
    this.zoom = Math.max(0.05, Math.min(1.5, Math.min(scaleW, scaleH)));
    this.#applyZoom();
  }

  async close(options) {
    Hooks.off("updateScene", this._onSceneUpdate);
    Hooks.off("canvasReady", this._onSceneUpdate);
    SpireRevealTracker.#instance = null;
    return super.close(options);
  }
}
