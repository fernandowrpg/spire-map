/**
 * Tradução tolerante: se a string for uma chave conhecida, traduz; se for texto livre
 * (nome customizado de um tipo de nó, por exemplo), devolve como está.
 * @module spire-map/i18n
 */

/**
 * @param {string} key chave de i18n ou texto literal
 * @returns {string}
 */
export function smartLocalize(key) {
  const str = String(key ?? "");
  if (!str) return "";
  return game.i18n?.has?.(str) ? game.i18n.localize(str) : str;
}
