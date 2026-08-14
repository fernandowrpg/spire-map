/**
 * Constantes e configuração padrão do Spire Map.
 * @module spire-map/constants
 */

export const MODULE_ID = "spire-map";

/** Chaves de settings do mundo. */
export const SETTINGS = {
  DEFAULT_CONFIG: "defaultConfig",
  PRESETS: "presets",
  SHOW_SCENE_BUTTON: "showSceneButton",
  AUTO_PREVIEW: "autoPreview"
};

/** Flag namespace usado em todos os documentos criados pelo módulo. */
export const FLAG = {
  SCOPE: MODULE_ID,
  MAP_ID: "mapId",
  NODE: "node",
  KIND: "kind",
  /** Cena: mapa desenhado (grafo + config), usado pelo controle de revelação. */
  MAP: "map",
  /** Cena: estado de revelação e progresso do grupo. */
  PROGRESS: "progress"
};

/** Estados possíveis de um nó no controle de revelação. */
export const NODE_STATE = {
  HIDDEN: "hidden",
  REVEALED: "revealed",
  AVAILABLE: "available",
  VISITED: "visited",
  CURRENT: "current"
};

/**
 * Tipos de nó padrão. Cada tipo é totalmente editável pelo usuário no painel.
 *
 * @typedef {object} NodeType
 * @property {string}  id          Identificador único (slug).
 * @property {string}  label       Nome exibido. Pode ser uma chave de i18n.
 * @property {string}  symbol      Texto curto desenhado dentro do nó (1-3 chars).
 * @property {string}  color       Cor da borda / do símbolo.
 * @property {string}  fill        Cor de preenchimento do nó.
 * @property {string}  icon        Caminho opcional de imagem (Tile) usado no lugar do símbolo.
 * @property {number}  weight      Peso relativo no sorteio (0 = nunca sorteado).
 * @property {number}  minFloor    Primeiro andar (1-indexado) em que o tipo pode aparecer.
 * @property {number}  maxPerFloor 0 = ilimitado.
 * @property {number}  maxTotal    0 = ilimitado.
 * @property {boolean} noRepeatOnPath Impede dois nós consecutivos do mesmo tipo em um caminho.
 * @property {boolean} reserved    Tipos reservados (tesouro/descanso/boss) não entram no sorteio.
 */

/** @type {NodeType[]} */
export const DEFAULT_NODE_TYPES = [
  {
    id: "monster",
    label: "SPIREMAP.nodes.monster",
    symbol: "M",
    color: "#f4e0c0",
    fill: "#8c2f2f",
    icon: "",
    weight: 45,
    minFloor: 1,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: false,
    reserved: false
  },
  {
    id: "event",
    label: "SPIREMAP.nodes.event",
    symbol: "?",
    color: "#f4e0c0",
    fill: "#3f6f8f",
    icon: "",
    weight: 22,
    minFloor: 1,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: false,
    reserved: false
  },
  {
    id: "elite",
    label: "SPIREMAP.nodes.elite",
    symbol: "E",
    color: "#ffe9a8",
    fill: "#6d1f4a",
    icon: "",
    weight: 16,
    minFloor: 6,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: true,
    reserved: false
  },
  {
    id: "rest",
    label: "SPIREMAP.nodes.rest",
    symbol: "R",
    color: "#ffd9a0",
    fill: "#b3541e",
    icon: "",
    weight: 12,
    minFloor: 6,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: true,
    reserved: false
  },
  {
    id: "shop",
    label: "SPIREMAP.nodes.shop",
    symbol: "$",
    color: "#2b2118",
    fill: "#d8b64a",
    icon: "",
    weight: 5,
    minFloor: 2,
    maxPerFloor: 1,
    maxTotal: 0,
    noRepeatOnPath: true,
    reserved: false
  },
  {
    id: "treasure",
    label: "SPIREMAP.nodes.treasure",
    symbol: "T",
    color: "#2b2118",
    fill: "#c9a227",
    icon: "",
    weight: 0,
    minFloor: 1,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: false,
    reserved: true
  },
  {
    id: "boss",
    label: "SPIREMAP.nodes.boss",
    symbol: "B",
    color: "#ffffff",
    fill: "#4a0d0d",
    icon: "",
    weight: 0,
    minFloor: 1,
    maxPerFloor: 0,
    maxTotal: 0,
    noRepeatOnPath: false,
    reserved: true
  }
];

/**
 * Configuração padrão completa do gerador + aparência + saída.
 * Tudo aqui é exposto no painel.
 */
export const DEFAULT_CONFIG = {
  /* ---------------- Estrutura ---------------- */
  floors: 15,
  paths: 6,
  columns: 7,
  seed: "",
  act: 1,

  /* ---------------- Regras ---------------- */
  firstFloorFixed: true,
  firstFloorType: "monster",
  treasureFloor: 9,
  restFloor: 15,
  bossEnabled: true,
  bossType: "boss",
  preventCrossing: true,
  preventSmallLoops: true,
  noSameTypeAsSoleParent: true,
  distinctStarts: true,
  forceReachableExit: true,

  /* ---------------- Aparência ---------------- */
  orientation: "up",
  nodeRadius: 46,
  spacingX: 190,
  spacingY: 170,
  jitterX: 34,
  jitterY: 24,
  marginX: 160,
  marginY: 160,
  edgeWidth: 6,
  edgeColor: "#8a7a5c",
  edgeAlpha: 0.85,
  edgeStyle: "curved",
  nodeStrokeWidth: 4,
  drawBackground: true,
  backgroundColor: "#1b1712",
  showSymbols: true,
  showLabels: false,
  showFloorNumbers: true,
  fontSize: 40,
  fontFamily: "Signika",
  titleText: "",

  /* ---------------- Segredo / revelação ---------------- */
  secretNodes: true,
  maskSymbol: "?",
  maskFill: "#2c2620",
  maskColor: "#8a7a5c",
  revealMode: "onChoice",
  revealLookahead: 1,
  revealFirstFloor: true,
  hideEdgesUntilRevealed: false,
  showPartyMarker: true,
  markerColor: "#ffd66b",
  announceReveal: false,

  /* ---------------- Saída ---------------- */
  target: "active",
  newSceneName: "Spire Map — Ato {act}",
  clearPrevious: true,
  lockDrawings: true,
  createNotes: false,
  createJournal: false,
  journalFolderName: "Spire Map",
  notifyChat: false,

  /* ---------------- Tipos ---------------- */
  nodeTypes: DEFAULT_NODE_TYPES.map((t) => ({ ...t }))
};

/** Presets prontos de estrutura. */
export const BUILTIN_PRESETS = {
  classic: {
    label: "SPIREMAP.presets.classic",
    config: { floors: 15, paths: 6, columns: 7, treasureFloor: 9, restFloor: 15, bossEnabled: true }
  },
  short: {
    label: "SPIREMAP.presets.short",
    config: { floors: 8, paths: 4, columns: 5, treasureFloor: 5, restFloor: 8, bossEnabled: true }
  },
  long: {
    label: "SPIREMAP.presets.long",
    config: { floors: 22, paths: 8, columns: 9, treasureFloor: 12, restFloor: 22, bossEnabled: true }
  },
  wide: {
    label: "SPIREMAP.presets.wide",
    config: { floors: 12, paths: 10, columns: 11, treasureFloor: 7, restFloor: 12, bossEnabled: true }
  }
};

/** Limites de sanidade usados na validação. */
export const LIMITS = {
  floors: [2, 40],
  paths: [1, 20],
  columns: [2, 20],
  nodeRadius: [8, 200],
  spacingX: [40, 800],
  spacingY: [40, 800],
  edgeWidth: [1, 40],
  fontSize: [8, 200]
};
