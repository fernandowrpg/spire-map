/**
 * Controle de revelação (só Mestre).
 *
 * Mostra o mapa desenhado na cena com o "nevoeiro" aplicado — o Mestre vê os tipos
 * reais esmaecidos, os jogadores veem apenas o que foi revelado na cena — e permite
 * marcar a escolha dos jogadores, revelar/ocultar nós e andares, voltar um passo e
 * reiniciar o progresso.
 *
 * Também é aqui que o Mestre define o que uma sala "?" revelou ser, libera caminhos secretos
 * na mão, arrasta o adversário para o nó do boss e associa a cada nó uma cena do mundo, que pode
 * ser ativada com os tokens dos jogadores já colocados nela.
 *
 * @module spire-map/apps/reveal-tracker
 */

import { MODULE_ID, FLAG, NODE_STATE, SETTINGS } from "../constants.js";
import { renderSvg } from "../renderer.js";
import {
  readSceneMap,
  chooseNode,
  setProgress,
  applyProgressToScene,
  announceResolution
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
  applyLookahead,
  lockedNodes,
  makeDisplay,
  isResolvable,
  isBossNode,
  setResolution,
  clearResolution,
  setSecretPath,
  setAdversary,
  clearAdversary,
  setAdversaryDefeated,
  adversaryOf,
  sceneOf,
  setNodeScene,
  clearNodeScene
} from "../progress.js";
import { activateNodeScene } from "../node-scene.js";
import { smartLocalize } from "../i18n.js";
import { readVote, tally, activeVoters, startVote, closeVote, cancelVote } from "../vote.js";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

/** Mensagem de cada erro devolvido por `chooseNode`. */
const ERROR_KEY = {
  notAvailable: "SPIREMAP.reveal.error.notAvailable",
  unknownNode: "SPIREMAP.reveal.error.unknownNode",
  noMap: "SPIREMAP.reveal.error.noMap",
  noOptions: "SPIREMAP.reveal.noOptions",
  tie: "SPIREMAP.vote.tie",
  noVotes: "SPIREMAP.vote.noVotes",
  noScene: "SPIREMAP.nodeScene.none",
  missingScene: "SPIREMAP.nodeScene.missing"
};

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

  /** Última cena com mapa vista: o controle continua nela enquanto o grupo está na cena de um nó. */
  static #mapSceneId = null;

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
      spireChoose: SpireRevealTracker.#onChoose,
      spireForceMove: SpireRevealTracker.#onForceMove,
      spireToggle: SpireRevealTracker.#onToggle,
      spireSelect: SpireRevealTracker.#onSelect,
      spireRevealFloor: SpireRevealTracker.#onRevealFloor,
      spireRevealAll: SpireRevealTracker.#onRevealAll,
      spireHideUnvisited: SpireRevealTracker.#onHideUnvisited,
      spireStepBack: SpireRevealTracker.#onStepBack,
      spireReset: SpireRevealTracker.#onReset,
      spireResync: SpireRevealTracker.#onResync,
      spireFit: SpireRevealTracker.#onFit,
      spireResolve: SpireRevealTracker.#onResolve,
      spireUnresolve: SpireRevealTracker.#onUnresolve,
      spireToggleSecret: SpireRevealTracker.#onToggleSecret,
      spireDefeat: SpireRevealTracker.#onDefeat,
      spireClearAdversary: SpireRevealTracker.#onClearAdversary,
      spireOpenAdversary: SpireRevealTracker.#onOpenAdversary,
      spireClearHistory: SpireRevealTracker.#onClearHistory,
      spireStartVote: SpireRevealTracker.#onStartVote,
      spireCloseVote: SpireRevealTracker.#onCloseVote,
      spireCancelVote: SpireRevealTracker.#onCancelVote,
      spireActivateScene: SpireRevealTracker.#onActivateScene,
      spireViewScene: SpireRevealTracker.#onViewScene,
      spireBackToMap: SpireRevealTracker.#onBackToMap
    }
  };

  static PARTS = {
    body: {
      template: `modules/${MODULE_ID}/templates/reveal-tracker.hbs`,
      scrollable: [".spire-reveal__list", ".spire-reveal__stage"]
    }
  };

  /**
   * Cena observada: a que está sendo visualizada, se tiver um mapa. Fora dela (na cena de um nó,
   * por exemplo), continua a última cena com mapa — ou a que tem um nó apontando para a cena atual.
   */
  get scene() {
    const viewed = canvas?.scene ?? game.scenes?.active ?? null;
    if (viewed && readSceneMap(viewed)) {
      SpireRevealTracker.#mapSceneId = viewed.id;
      return viewed;
    }
    const remembered = game.scenes?.get(SpireRevealTracker.#mapSceneId);
    if (remembered && readSceneMap(remembered)) return remembered;
    const owner = viewed
      ? game.scenes?.find((s) =>
          (s.getFlag(MODULE_ID, FLAG.PROGRESS)?.scenes ?? []).some((e) => e.uuid === viewed.uuid)
        )
      : null;
    return owner ?? viewed;
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
    const locked = lockedNodes(map, progress);
    const unlocked = new Set(progress.unlocked ?? []);
    // O Mestre vê sempre o tipo efetivo (a sala "?" já definida) e o apelido.
    const show = makeDisplay(map, progress, { gmView: true });
    const keyOf = new Map();
    for (const path of map.secretPaths ?? []) {
      if (!keyOf.has(path.key)) keyOf.set(path.key, []);
      keyOf.get(path.key).push({ id: path.id, unlocked: unlocked.has(path.id) });
    }

    const describe = (node) => {
      const display = show(node);
      const type = display.type;
      const state = states.get(node.id);
      return {
        id: node.id,
        floor: node.floor,
        col: node.col + 1,
        typeId: node.typeId,
        label: smartLocalize(type?.label ?? node.typeId),
        alias: display.alias,
        description: display.description,
        isResolved: display.resolved,
        baseLabel: smartLocalize(display.baseType?.label ?? node.typeId),
        secretPath: node.secretPath ?? null,
        isLocked: locked.has(node.id),
        secretKeys: keyOf.get(node.id) ?? [],
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
        hasScene: Boolean(sceneOf(progress, node.id)),
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
    // Votação aberta: votos de cada opção e quem votou.
    const vote = readVote(scene);
    const count = vote ? tally(vote) : null;
    const available = (progress.available ?? [])
      .map((id) => map.nodes.find((n) => n.id === id))
      .filter(Boolean)
      .map((node) => ({
        ...describe(node),
        votes: count?.counts.get(node.id) ?? 0,
        voters: (count?.voters.get(node.id) ?? []).join(", "),
        isLeader: Boolean(count?.max) && count.leaders.includes(node.id)
      }));
    const selected = this.selectedNodeId
      ? map.nodes.find((n) => n.id === this.selectedNodeId)
      : null;

    // Detalhes que só o nó selecionado precisa: formulário da sala "?", caminho secreto, boss.
    let selectedInfo = null;
    if (selected) {
      const display = show(selected);
      const resolvable = isResolvable(map, selected);
      const chosenType = display.resolution?.typeId ?? selected.typeId;
      selectedInfo = {
        ...describe(selected),
        resolvable,
        resolution: display.resolution,
        typeOptions: map.config.nodeTypes.map((t) => ({
          value: t.id,
          label: smartLocalize(t.label),
          selected: t.id === chosenType
        })),
        isBossNode: isBossNode(map, selected),
        adversary: adversaryOf(progress, selected.id),
        ...SpireRevealTracker.#sceneChoice(scene, sceneOf(progress, selected.id))
      };
    }

    this._map = map;
    this._progress = progress;

    const viewed = canvas?.scene ?? null;
    return {
      hasMap: true,
      sceneName: scene.name,
      viewingElsewhere: Boolean(viewed && viewed.id !== scene.id),
      viewedName: viewed?.name ?? "",
      seed: map.seed,
      secret: Boolean(map.config.secretNodes),
      summary,
      currentLabel: current ? describe(current) : null,
      available,
      vote: vote
        ? { total: count.total, expected: activeVoters().length, tie: count.leaders.length > 1 }
        : null,
      floors,
      selected: selectedInfo,
      secretPathCount: (map.secretPaths ?? []).length,
      secretPathsOpen: unlocked.size,
      history: SpireRevealTracker.#history().map((entry, index) => ({
        ...entry,
        index,
        when: entry.defeatedAt ? new Date(entry.defeatedAt).toLocaleDateString() : ""
      })),
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

      // Soltar um ator direto em cima de um nó de boss no minimapa.
      this.#bindDrop(stage, (event) => event.target.closest?.("[data-node-id]")?.dataset.nodeId);
    }

    // Área de soltar do nó selecionado.
    for (const zone of root.querySelectorAll(".spire-dropzone")) {
      this.#bindDrop(zone, () => zone.dataset.nodeId);
    }
  }

  /**
   * Cena associada ao nó selecionado e as opções do seletor (todas as cenas do mundo, menos a
   * do mapa). Uma cena apagada continua listada, marcada como ausente.
   * @param {Scene} mapScene
   * @param {{uuid:string,name:string}|null} entry
   */
  static #sceneChoice(mapScene, entry) {
    const options = (game.scenes?.contents ?? [])
      .filter((s) => s.id !== mapScene.id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ value: s.uuid, label: s.name, selected: s.uuid === entry?.uuid }));
    const missing = Boolean(entry) && !options.some((o) => o.selected);
    if (missing) options.unshift({ value: entry.uuid, label: entry.name, selected: true });
    return {
      nodeScene: entry ? { ...entry, missing, active: game.scenes?.active?.uuid === entry.uuid } : null,
      sceneOptions: options
    };
  }

  /**
   * Liga arrastar-e-soltar de atores e cenas em um elemento.
   * @param {HTMLElement} el
   * @param {(event: DragEvent) => string|undefined} resolveNodeId
   */
  #bindDrop(el, resolveNodeId) {
    el.addEventListener("dragover", (event) => {
      event.preventDefault();
      el.classList.add("is-dragover");
    });
    el.addEventListener("dragleave", () => el.classList.remove("is-dragover"));
    el.addEventListener("drop", async (event) => {
      event.preventDefault();
      el.classList.remove("is-dragover");
      const nodeId = resolveNodeId(event);
      if (nodeId) await this.#onDrop(event, nodeId);
    });
  }

  /** Uma cena solta vira a cena do nó; um ator, o adversário do boss. */
  async #onDrop(event, nodeId) {
    let data = null;
    try {
      const editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
      data = editor?.getDragEventData?.(event) ?? JSON.parse(event.dataTransfer.getData("text/plain"));
    } catch (err) {
      data = null;
    }
    if (data?.type === "Scene" && data.uuid) return this.#setScene(nodeId, data.uuid);
    return this.#dropAdversary(data, nodeId);
  }

  /** Associa uma cena do mundo ao nó (`uuid` vazio desfaz). */
  async #setScene(nodeId, uuid) {
    const state = this.#fresh();
    if (!state || !state.map.nodes.some((n) => n.id === nodeId)) return;
    let scene = null;
    if (uuid) {
      try {
        scene = await fromUuid(uuid);
      } catch (err) {
        scene = null;
      }
      if (!(scene instanceof Scene)) {
        ui.notifications.warn(game.i18n.localize("SPIREMAP.nodeScene.missing"));
        return;
      }
    }
    const progress = scene
      ? setNodeScene(state.map, state.progress, nodeId, {
          uuid: scene.uuid,
          name: scene.name,
          img: scene.thumb ?? ""
        })
      : clearNodeScene(state.map, state.progress, nodeId);
    await setProgress(this.scene, progress);
    this.selectedNodeId = nodeId;
    this.render();
  }

  /** Vincula ao nó o ator solto (barra lateral, compêndio ou token). */
  async #dropAdversary(data, nodeId) {
    const state = this.#fresh();
    const node = state?.map.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (!isBossNode(state.map, node)) {
      ui.notifications.warn(game.i18n.localize("SPIREMAP.boss.notBossNode"));
      return;
    }

    if (!data?.uuid || !["Actor", "Token"].includes(data.type)) {
      ui.notifications.warn(game.i18n.localize("SPIREMAP.boss.dropInvalid"));
      return;
    }

    let doc = null;
    try {
      doc = await fromUuid(data.uuid);
    } catch (err) {
      doc = null;
    }
    // Um token solto vale pelo ator que ele representa.
    const actor = doc?.actor ?? doc;
    if (!actor?.name) {
      ui.notifications.warn(game.i18n.localize("SPIREMAP.boss.dropInvalid"));
      return;
    }

    await setProgress(
      this.scene,
      setAdversary(state.map, state.progress, nodeId, {
        uuid: actor.uuid ?? data.uuid,
        name: doc?.name ?? actor.name,
        img: actor.img ?? doc?.texture?.src ?? ""
      })
    );
    this.selectedNodeId = nodeId;
    this.render();
  }

  /** Histórico de adversários derrotados (setting do mundo). */
  static #history() {
    try {
      const list = game.settings.get(MODULE_ID, SETTINGS.BOSS_HISTORY);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      return [];
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

    if (el.name === "__nodeScene") await this.#setScene(el.dataset.nodeId, el.value);
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
      const key = ERROR_KEY[result.error];
      ui.notifications.warn(key ? game.i18n.localize(key) : String(result.error));
      return;
    }
    // Sala "?" ainda sem definição, ou boss: o nó fica selecionado, com o formulário à mão.
    const state = this.#fresh();
    const node = state?.map.nodes.find((n) => n.id === nodeId);
    const pending =
      node &&
      ((isResolvable(state.map, node) &&
        !(state.progress.resolved ?? []).some((r) => r.id === nodeId)) ||
        isBossNode(state.map, node));
    this.selectedNodeId = pending ? nodeId : null;

    if (result.unlockedNow?.length) {
      ui.notifications.info(
        game.i18n.format("SPIREMAP.secretPath.unlocked", { count: result.unlockedNow.length })
      );
    }
    if (result.revealedNow?.length) {
      ui.notifications.info(
        game.i18n.format("SPIREMAP.reveal.revealedCount", { count: result.revealedNow.length })
      );
    }
    if (result.nodeScene) SpireRevealTracker.#notifyActivation(result.nodeScene);
    this.render();
  }

  /** Avisa o resultado de ativar a cena de um nó. */
  static #notifyActivation(result) {
    if (!result.ok) {
      ui.notifications.warn(game.i18n.localize(ERROR_KEY[result.error] ?? String(result.error)));
      return;
    }
    ui.notifications.info(
      game.i18n.format("SPIREMAP.nodeScene.activated", { name: result.scene.name, count: result.placed })
    );
  }

  /* ------------------------------ cena do nó ------------------------------ */

  static async #onActivateScene(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    if (!nodeId || !state) return;
    SpireRevealTracker.#notifyActivation(await activateNodeScene(state.progress, nodeId));
    this.render();
  }

  /** Só o Mestre olha a cena, sem ativá-la para os jogadores. */
  static async #onViewScene(event, target) {
    const entry = sceneOf(this.#fresh()?.progress, target.dataset.nodeId ?? this.selectedNodeId);
    const scene = entry ? await fromUuid(entry.uuid).catch(() => null) : null;
    if (scene instanceof Scene) await scene.view();
    else ui.notifications.warn(game.i18n.localize("SPIREMAP.nodeScene.missing"));
  }

  /** Ativa de novo a cena do mapa para todos. */
  static async #onBackToMap() {
    await this.scene?.activate();
  }

  /* ----------------------- sala "?" com tipo definido ---------------------- */

  static async #onResolve(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    if (!nodeId || !state) return;
    const box = target.closest(".spire-resolve");
    const result = setResolution(state.map, state.progress, nodeId, {
      typeId: box?.querySelector('[name="__resType"]')?.value,
      alias: box?.querySelector('[name="__resAlias"]')?.value,
      description: box?.querySelector('[name="__resDesc"]')?.value
    });
    if (result.error) {
      ui.notifications.warn(game.i18n.localize("SPIREMAP.resolve.invalidType"));
      return;
    }
    await setProgress(this.scene, result.progress);
    // Só anuncia o que os jogadores já podem ver: a sala precisa ter sido escolhida.
    if (state.map.config.announceReveal && (result.progress.visited ?? []).includes(nodeId)) {
      await announceResolution(state.map, result.progress, nodeId);
    }
    this.render();
  }

  static async #onUnresolve(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    if (!nodeId || !state) return;
    await setProgress(this.scene, clearResolution(state.map, state.progress, nodeId));
    this.render();
  }

  /* --------------------------- caminhos secretos --------------------------- */

  static async #onToggleSecret(event, target) {
    const pathId = Number(target.dataset.pathId);
    const state = this.#fresh();
    if (!pathId || !state) return;
    await setProgress(this.scene, setSecretPath(state.map, state.progress, pathId));
    this.render();
  }

  /* --------------------------- adversário do boss -------------------------- */

  static async #onDefeat(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    const adversary = state ? adversaryOf(state.progress, nodeId) : null;
    if (!adversary) return;
    const defeated = !adversary.defeated;
    const at = Date.now();
    await setProgress(this.scene, setAdversaryDefeated(state.map, state.progress, nodeId, defeated, at));

    // O histórico vive em um setting do mundo: continua lá depois de regenerar o mapa.
    const node = state.map.nodes.find((n) => n.id === nodeId);
    const key = `${state.map.mapId}:${nodeId}`;
    const history = SpireRevealTracker.#history().filter((h) => h.key !== key);
    if (defeated) {
      history.push({
        key,
        uuid: adversary.uuid,
        name: adversary.name,
        img: adversary.img,
        scene: this.scene?.name ?? "",
        act: state.map.config.act,
        floor: node?.floor ?? null,
        seed: state.map.seed,
        defeatedAt: at
      });
    }
    await game.settings.set(MODULE_ID, SETTINGS.BOSS_HISTORY, history);
    this.render();
  }

  static async #onClearAdversary(event, target) {
    const nodeId = target.dataset.nodeId ?? this.selectedNodeId;
    const state = this.#fresh();
    if (!nodeId || !state) return;
    await setProgress(this.scene, clearAdversary(state.map, state.progress, nodeId));
    this.render();
  }

  static async #onOpenAdversary(event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    try {
      const doc = await fromUuid(uuid);
      if (doc?.sheet) doc.sheet.render(true);
      else ui.notifications.warn(game.i18n.localize("SPIREMAP.boss.missingActor"));
    } catch (err) {
      ui.notifications.warn(game.i18n.localize("SPIREMAP.boss.missingActor"));
    }
  }

  static async #onClearHistory(event, target) {
    const index = target.dataset.index;
    const history = SpireRevealTracker.#history();
    if (index !== undefined) {
      history.splice(Number(index), 1);
      await game.settings.set(MODULE_ID, SETTINGS.BOSS_HISTORY, history);
      return this.render();
    }
    const confirmed = await DialogV2.confirm({
      window: { title: game.i18n.localize("SPIREMAP.boss.clearHistory") },
      content: `<p>${game.i18n.localize("SPIREMAP.boss.confirmClearHistory")}</p>`
    });
    if (!confirmed) return;
    await game.settings.set(MODULE_ID, SETTINGS.BOSS_HISTORY, []);
    this.render();
  }

  /* -------------------------------- votação ------------------------------- */

  static async #onStartVote() {
    const result = await startVote(this.scene);
    if (!result.ok) ui.notifications.warn(game.i18n.localize(ERROR_KEY[result.error] ?? String(result.error)));
    this.render();
  }

  static async #onCloseVote() {
    const result = await closeVote(this.scene);
    if (!result.ok) {
      ui.notifications.warn(game.i18n.localize(ERROR_KEY[result.error] ?? String(result.error)));
      return this.render();
    }
    this.selectedNodeId = null;
    this.render();
  }

  static async #onCancelVote() {
    await cancelVote(this.scene);
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
