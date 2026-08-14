#!/usr/bin/env node
/**
 * Prepara o `module.json` para uma release.
 *
 * Injeta a versão e as três URLs que o Foundry usa:
 *   url      -> página do repositório
 *   manifest -> .../releases/latest/download/module.json   (é assim que o Foundry
 *               descobre que existe uma versão nova)
 *   download -> .../releases/download/v<versão>/spire-map.zip  (sempre a versão exata)
 *
 * Uso:
 *   node tools/prepare-manifest.mjs <versao> <url-do-repositorio>
 *   node tools/prepare-manifest.mjs 1.1.0 https://github.com/fernandowrpg/spire-map
 *
 * Sem argumentos, apenas mostra o que está no manifesto hoje.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "module.json");
const manifest = JSON.parse(readFileSync(file, "utf8"));

const [version, repoUrl] = process.argv.slice(2);

if (!version) {
  console.log(
    `versão atual: ${manifest.version}\n` +
      `url:      ${manifest.url ?? "—"}\n` +
      `manifest: ${manifest.manifest ?? "—"}\n` +
      `download: ${manifest.download ?? "—"}`
  );
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(version)) {
  console.error(`versão inválida: "${version}" (esperado X.Y.Z)`);
  process.exit(1);
}

manifest.version = version;

if (repoUrl) {
  const base = repoUrl.replace(/\/+$/, "");
  manifest.url = base;
  manifest.manifest = `${base}/releases/latest/download/module.json`;
  manifest.download = `${base}/releases/download/v${version}/${manifest.id}.zip`;
} else if (manifest.download) {
  // Mantém o repositório, só atualiza a versão dentro da URL de download.
  manifest.download = manifest.download.replace(/\/download\/v[^/]+\//, `/download/v${version}/`);
}

writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  `module.json preparado para a ${version}\n` +
    `  url:      ${manifest.url}\n` +
    `  manifest: ${manifest.manifest}\n` +
    `  download: ${manifest.download}`
);
