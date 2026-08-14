/**
 * Renderizador SVG do mapa.
 *
 * Usado em dois lugares:
 *  - preview ao vivo dentro do painel de configuração;
 *  - exportação do mapa como arquivo .svg.
 *
 * Também é headless (não usa API do Foundry).
 * @module spire-map/renderer
 */

import { edgePoints } from "./generator.js";

/** Escapa texto para uso seguro dentro de SVG/HTML. */
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Converte um caminho de aresta em atributo `d` de <path>.
 * @param {{x:number,y:number}[]} pts
 */
function toPathData(pts) {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

/**
 * Renderiza o mapa como um documento SVG completo.
 *
 * @param {import("./generator.js").SpireMap} map
 * @param {object} [options]
 * @param {(key:string) => string} [options.localize] tradutor para os rótulos dos tipos
 * @param {boolean} [options.standalone] inclui cabeçalho XML (para salvar em arquivo)
 * @param {boolean} [options.interactive] adiciona data-attributes e classes para hover/clique
 * @param {string}  [options.highlightId] destaca um nó
 * @param {object}  [options.fog] estado de revelação (ver `progress.js#toFog`). Sem isso,
 *                                o mapa é desenhado inteiro, sem segredo.
 * @returns {string} markup SVG
 */
export function renderSvg(map, options = {}) {
  const {
    localize = (k) => k,
    standalone = false,
    interactive = true,
    highlightId = null,
    fog = null
  } = options;
  const config = map.config;
  const { width, height } = map.bounds;
  const index = new Map(map.nodes.map((n) => [n.id, n]));
  const typeById = new Map(config.nodeTypes.map((t) => [t.id, t]));
  const r = config.nodeRadius / 2;

  const parts = [];
  if (standalone) parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="spire-map-svg" preserveAspectRatio="xMidYMid meet">`
  );

  parts.push(
    `<defs><filter id="spire-glow" x="-40%" y="-40%" width="180%" height="180%">` +
      `<feGaussianBlur stdDeviation="${(r * 0.22).toFixed(2)}" result="b"/>` +
      `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
  );

  if (config.drawBackground) {
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(config.backgroundColor)}"/>`);
  }

  /* --------------------------- numeração dos andares --------------------------- */
  if (config.showFloorNumbers) {
    parts.push('<g class="spire-floors">');
    for (let floor = 1; floor <= map.totalFloors; floor++) {
      const sample = map.byFloor[floor - 1]?.[0];
      if (!sample) continue;
      const rowIndex = config.orientation === "up" ? map.totalFloors - floor : floor - 1;
      const y = config.marginY + rowIndex * config.spacingY;
      const label = floor === map.totalFloors && config.bossEnabled ? "★" : String(floor);
      parts.push(
        `<text x="${Math.max(14, config.marginX * 0.42).toFixed(0)}" y="${(y + config.fontSize * 0.34).toFixed(0)}" ` +
          `font-family="${escapeXml(config.fontFamily)}" font-size="${(config.fontSize * 0.66).toFixed(0)}" ` +
          `fill="${escapeXml(config.edgeColor)}" opacity="0.65" text-anchor="middle">${escapeXml(label)}</text>`
      );
    }
    parts.push("</g>");
  }

  /* --------------------------------- arestas ---------------------------------- */
  const isRevealed = (id) => !fog || fog.revealed.has(id);
  const edgeVisible = (a, b) =>
    !fog || !config.hideEdgesUntilRevealed || (isRevealed(a) && isRevealed(b));

  parts.push('<g class="spire-edges" fill="none" stroke-linecap="round" stroke-linejoin="round">');
  for (const edge of map.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) continue;
    const known = edgeVisible(edge.from, edge.to);
    if (!known && !fog?.gmView) continue;
    const d = toPathData(edgePoints(from, to, config));
    const alpha = known ? config.edgeAlpha : config.edgeAlpha * 0.25;
    parts.push(
      `<path d="${d}" stroke="${escapeXml(config.edgeColor)}" stroke-width="${config.edgeWidth}" ` +
        `stroke-opacity="${alpha}" stroke-dasharray="${(config.edgeWidth * 2.2).toFixed(1)} ${(config.edgeWidth * 1.5).toFixed(1)}"/>`
    );
  }
  parts.push("</g>");

  /* ----------------------------------- nós ------------------------------------ */
  parts.push('<g class="spire-nodes">');
  for (const node of map.nodes) {
    const realType = typeById.get(node.typeId) ?? {
      fill: "#555",
      color: "#fff",
      symbol: "?",
      label: node.typeId,
      icon: ""
    };
    const maskType = {
      fill: config.maskFill,
      color: config.maskColor,
      symbol: config.maskSymbol,
      label: "SPIREMAP.reveal.unknown",
      icon: ""
    };

    const known = isRevealed(node.id);
    const secret = Boolean(fog) && !known;
    // Para o Mestre, um nó oculto aparece com o tipo verdadeiro esmaecido.
    const type = secret && !fog.gmView ? maskType : realType;
    const opacity = secret && fog.gmView ? 0.42 : 1;

    const radius = node.isBoss ? r * 1.45 : r;
    const label = localize(known || !fog ? realType.label : maskType.label);
    const isHot = highlightId === node.id;

    const stateClass = !fog
      ? ""
      : [
          secret ? "is-secret" : "is-known",
          fog.current === node.id ? "is-current" : "",
          fog.visited.has(node.id) ? "is-visited" : "",
          fog.available.has(node.id) ? "is-available" : ""
        ]
          .filter(Boolean)
          .join(" ");

    const attrs = interactive
      ? ` class="spire-node${isHot ? " is-highlight" : ""}${stateClass ? " " + stateClass : ""}"` +
        ` data-node-id="${node.id}" data-type="${escapeXml(node.typeId)}" data-floor="${node.floor}"` +
        (fog ? ` data-secret="${secret ? "1" : "0"}"` : "")
      : "";

    parts.push(`<g${attrs}>`);
    if (interactive) {
      parts.push(
        `<title>${escapeXml(`${label} — ${localize("SPIREMAP.preview.floor")} ${node.floor}`)}</title>`
      );
    }

    // Anéis de estado (desenhados por baixo do nó).
    if (fog?.available.has(node.id) && fog.current !== node.id) {
      parts.push(
        `<circle cx="${node.x}" cy="${node.y}" r="${(radius * 1.34).toFixed(1)}" fill="none" ` +
          `stroke="${escapeXml(config.markerColor)}" stroke-width="${Math.max(2, config.nodeStrokeWidth * 0.8)}" ` +
          `stroke-opacity="0.75" stroke-dasharray="${(radius * 0.5).toFixed(1)} ${(radius * 0.34).toFixed(1)}"/>`
      );
    }
    if (fog?.visited.has(node.id) && fog.current !== node.id) {
      parts.push(
        `<circle cx="${node.x}" cy="${node.y}" r="${(radius * 1.22).toFixed(1)}" fill="none" ` +
          `stroke="${escapeXml(config.markerColor)}" stroke-width="${Math.max(1, config.nodeStrokeWidth * 0.5)}" ` +
          `stroke-opacity="0.45"/>`
      );
    }
    if (fog?.current === node.id) {
      parts.push(
        `<circle cx="${node.x}" cy="${node.y}" r="${(radius * 1.5).toFixed(1)}" fill="none" ` +
          `stroke="${escapeXml(config.markerColor)}" stroke-width="${Math.max(3, config.nodeStrokeWidth * 1.2)}" ` +
          `stroke-opacity="0.95"/>`
      );
    }

    parts.push(`<g opacity="${opacity}">`);
    parts.push(
      `<circle cx="${node.x}" cy="${node.y}" r="${radius.toFixed(1)}" fill="${escapeXml(type.fill)}" ` +
        `stroke="${escapeXml(type.color)}" stroke-width="${config.nodeStrokeWidth}"` +
        (secret && !fog.gmView ? ' stroke-dasharray="6 5"' : "") +
        ` filter="url(#spire-glow)"/>`
    );

    if (type.icon) {
      const size = radius * 1.25;
      parts.push(
        `<image href="${escapeXml(type.icon)}" x="${(node.x - size / 2).toFixed(1)}" y="${(node.y - size / 2).toFixed(1)}" ` +
          `width="${size.toFixed(1)}" height="${size.toFixed(1)}" preserveAspectRatio="xMidYMid meet"/>`
      );
    } else if (config.showSymbols || secret) {
      const fs = (node.isBoss ? config.fontSize * 1.3 : config.fontSize) * 0.92;
      parts.push(
        `<text x="${node.x}" y="${(node.y + fs * 0.35).toFixed(1)}" text-anchor="middle" ` +
          `font-family="${escapeXml(config.fontFamily)}" font-size="${fs.toFixed(0)}" font-weight="700" ` +
          `fill="${escapeXml(type.color)}">${escapeXml(type.symbol)}</text>`
      );
    }
    parts.push("</g>");

    if (config.showLabels && (known || !fog)) {
      parts.push(
        `<text x="${node.x}" y="${(node.y + radius + config.fontSize * 0.62).toFixed(1)}" text-anchor="middle" ` +
          `font-family="${escapeXml(config.fontFamily)}" font-size="${(config.fontSize * 0.52).toFixed(0)}" ` +
          `fill="${escapeXml(realType.color)}" opacity="0.9">${escapeXml(localize(realType.label))}</text>`
      );
    }
    parts.push("</g>");
  }
  parts.push("</g>");

  /* ---------------------------------- título ---------------------------------- */
  if (config.titleText) {
    const title = config.titleText.replace("{act}", String(config.act)).replace("{seed}", map.seed);
    const y = config.orientation === "up" ? config.marginY * 0.5 : height - config.marginY * 0.35;
    parts.push(
      `<text x="${(width / 2).toFixed(0)}" y="${y.toFixed(0)}" text-anchor="middle" ` +
        `font-family="${escapeXml(config.fontFamily)}" font-size="${(config.fontSize * 1.35).toFixed(0)}" ` +
        `font-weight="700" fill="${escapeXml(config.edgeColor)}">${escapeXml(title)}</text>`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}
