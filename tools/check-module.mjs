#!/usr/bin/env node
/**
 * Validação do módulo antes de publicar.
 *
 * Roda tanto local (`node tools/check-module.mjs`) quanto no CI. Verifica:
 *  1. o manifesto tem os campos obrigatórios e a versão é semver;
 *  2. todo arquivo citado no manifesto existe;
 *  3. todo script passa no parser do Node;
 *  4. os arquivos de idioma são JSON válido e têm exatamente as mesmas chaves;
 *  5. toda chave `SPIREMAP.*` usada em scripts/templates existe nos dois idiomas;
 *  6. todo template referenciado por `PARTS` existe.
 *
 * Sai com código 1 se algo estiver errado.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const read = (p) => readFileSync(join(root, p), "utf8");
const rel = (p) => relative(root, p).replaceAll("\\", "/");

/** Lista recursiva de arquivos com uma extensão. */
function walk(dir, ext, out = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) walk(join(dir, entry), ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

/* ----------------------------- 1. manifesto ------------------------------ */

let manifest;
try {
  manifest = JSON.parse(read("module.json"));
} catch (err) {
  console.error(`module.json inválido: ${err.message}`);
  process.exit(1);
}

for (const field of ["id", "title", "description", "version", "compatibility", "esmodules"]) {
  if (manifest[field] === undefined) fail(`module.json: campo obrigatório "${field}" ausente`);
}
if (!/^\d+\.\d+\.\d+([-+].+)?$/.test(String(manifest.version))) {
  fail(`module.json: versão "${manifest.version}" não é semver (X.Y.Z)`);
}
if (manifest.id !== "spire-map") {
  fail(`module.json: id "${manifest.id}" — a pasta em Data/modules deve ter o mesmo nome`);
}
if (!manifest.compatibility?.minimum) fail("module.json: compatibility.minimum ausente");

for (const key of ["manifest", "download", "url"]) {
  const value = manifest[key];
  if (!value) {
    notes.push(`module.json: "${key}" vazio (será injetado pelo CI no release)`);
    continue;
  }
  if (/OWNER|SEU-USUARIO|<.*>/.test(value)) {
    notes.push(`module.json: "${key}" ainda tem um placeholder (${value})`);
  }
}
if (manifest.manifest && !/releases\/latest\/download\/module\.json$/.test(manifest.manifest)) {
  notes.push(
    'module.json: o campo "manifest" costuma apontar para .../releases/latest/download/module.json ' +
      "para que o Foundry detecte atualizações"
  );
}

/* -------------------------- 2. arquivos citados -------------------------- */

const declared = [
  ...(manifest.esmodules ?? []),
  ...(manifest.styles ?? []),
  ...(manifest.languages ?? []).map((l) => l.path),
  ...(manifest.packs ?? []).map((p) => p.path)
];
for (const file of declared) {
  if (!existsSync(join(root, file))) fail(`arquivo declarado no manifesto não existe: ${file}`);
}

/* ------------------------------ 3. scripts ------------------------------- */

const scripts = walk("scripts", ".js");
if (!scripts.length) fail("nenhum script encontrado em scripts/");
for (const file of scripts) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    fail(`erro de sintaxe em ${rel(file)}:\n${err.stderr?.toString().split("\n")[4] ?? err.message}`);
  }
}

/* ------------------------------ 4. idiomas ------------------------------- */

const langs = new Map();
for (const entry of manifest.languages ?? []) {
  try {
    langs.set(entry.lang, JSON.parse(read(entry.path)));
  } catch (err) {
    fail(`${entry.path} não é JSON válido: ${err.message}`);
  }
}
if (langs.size > 1) {
  const [base, ...rest] = [...langs.entries()];
  for (const [lang, table] of rest) {
    const missing = Object.keys(base[1]).filter((k) => !(k in table));
    const extra = Object.keys(table).filter((k) => !(k in base[1]));
    if (missing.length) fail(`${lang}: ${missing.length} chave(s) faltando: ${missing.slice(0, 6).join(", ")}`);
    if (extra.length) fail(`${lang}: ${extra.length} chave(s) a mais: ${extra.slice(0, 6).join(", ")}`);
  }
}

/* --------------------- 5. chaves usadas x traduzidas --------------------- */

const sources = [...scripts, ...walk("templates", ".hbs")];
const used = new Map(); // chave -> arquivo onde apareceu
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/SPIREMAP(?:\.[A-Za-z0-9_]+)+/g)) {
    const key = match[0];
    if (!used.has(key)) used.set(key, rel(file));
  }
}
for (const [key, file] of used) {
  const missingIn = [...langs.entries()].filter(([, table]) => !(key in table)).map(([lang]) => lang);
  if (missingIn.length === langs.size) fail(`chave "${key}" usada em ${file} não existe em nenhum idioma`);
  else if (missingIn.length) fail(`chave "${key}" (${file}) falta em: ${missingIn.join(", ")}`);
}

/* --------------------- 5b. chaves traduzidas sem uso --------------------- */

const allKeys = new Set(Object.keys([...langs.values()][0] ?? {}));
const unused = [...allKeys].filter((k) => !used.has(k));
if (unused.length) {
  notes.push(`${unused.length} chave(s) traduzida(s) sem uso: ${unused.slice(0, 8).join(", ")}`);
}

/* ------------------------------ 6. templates ----------------------------- */

for (const file of scripts) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/modules\/\$\{MODULE_ID\}\/(templates\/[A-Za-z0-9._-]+)/g)) {
    if (!existsSync(join(root, match[1]))) fail(`template referenciado não existe: ${match[1]} (${rel(file)})`);
  }
}

/* -------------------------------- saída --------------------------------- */

console.log(
  `Spire Map ${manifest.version} — ${scripts.length} scripts, ${langs.size} idiomas, ` +
    `${used.size} chaves de i18n em uso, ${Object.keys([...langs.values()][0] ?? {}).length} traduzidas`
);
for (const note of notes) console.log(`  aviso: ${note}`);
if (problems.length) {
  console.error(`\n${problems.length} problema(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("Tudo certo.");
