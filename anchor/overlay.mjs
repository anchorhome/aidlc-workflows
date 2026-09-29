#!/usr/bin/env bun
// Project-owned customizations of framework-shipped JSON files (agent configs,
// .kiro/settings/*.json) that must survive every framework refresh. A refresh
// replaces those files with the shipped versions; this re-applies the
// project's changes on top.
//
//   bun anchor/overlay.mjs extract <project-dir> <stock-projection-dir> > overlay.json
//   bun anchor/overlay.mjs apply   <project-dir> <overlay.json>
//
// `extract` compares every JSON file under <stock>/.kiro with the project's copy
// and records only the differences. `apply` re-applies them and is idempotent.
//
// Diff shape per file (recursive):
//   objects         { "$set": {k: v}, "$unset": [k], "<k>": <nested diff> }
//   scalar arrays   { "$add": [...], "$remove": [...] }  (order: shipped, then added)
//   object arrays   { "$append": [...] }                  (matched by exact JSON)
// A "$remove"/"$unset" whose target the new shipped file no longer has is
// reported with "!" and exit code 3, so an upstream rename is noticed.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const scalarArray = (v) => Array.isArray(v) && v.every((x) => x === null || typeof x !== "object");
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// Lists whose order carries no meaning: permission and tool lists. Anything
// else (command args, hook lists) is compared and replaced exactly, so a
// project's reordering or insertion is kept byte for byte.
const SET_LISTS = new Set([
  "allowedCommands", "deniedCommands", "allowedPaths", "deniedPaths",
  "tools", "allowedTools", "resources", "toolAliases",
]);

export function diff(cur, base, key = "") {
  if (same(cur, base)) return undefined;
  if (isObj(cur) && isObj(base)) {
    const d = {};
    const set = {};
    const unset = [];
    for (const k of Object.keys(cur)) {
      if (!(k in base)) set[k] = cur[k];
      else {
        const sub = diff(cur[k], base[k], k);
        if (sub === undefined) continue;
        if (sub && typeof sub === "object" && "$replace" in sub) set[k] = sub.$replace;
        else d[k] = sub;
      }
    }
    for (const k of Object.keys(base)) if (!(k in cur)) unset.push(k);
    if (Object.keys(set).length) d.$set = set;
    if (unset.length) d.$unset = unset;
    return d;
  }
  if (SET_LISTS.has(key) && scalarArray(cur) && scalarArray(base)) {
    const add = cur.filter((v) => !base.includes(v));
    const remove = base.filter((v) => !cur.includes(v));
    return { ...(add.length ? { $add: add } : {}), ...(remove.length ? { $remove: remove } : {}) };
  }
  // Hook lists: the project appended entries after the shipped ones.
  if (Array.isArray(cur) && Array.isArray(base) && base.length <= cur.length &&
    base.every((x, i) => same(x, cur[i]))) {
    return { $append: cur.slice(base.length) };
  }
  return { $replace: cur };
}

export function applyDiff(target, d, where, log) {
  for (const k of d.$unset ?? []) {
    if (k in target) {
      delete target[k];
      log.push(`- ${where}.${k}`);
    } else log.push(`! ${where}.${k}: already absent in the shipped file (unset skipped)`);
  }
  for (const [k, v] of Object.entries(d.$set ?? {})) {
    if (!same(target[k], v)) {
      target[k] = structuredClone(v);
      log.push(`~ ${where}.${k}`);
    }
  }
  for (const [k, sub] of Object.entries(d)) {
    if (k.startsWith("$")) continue;
    const here = `${where}.${k}`;
    if (sub.$add || sub.$remove || sub.$append) {
      const list = Array.isArray(target[k]) ? target[k] : (target[k] = []);
      for (const v of sub.$remove ?? []) {
        const i = list.indexOf(v);
        if (i >= 0) {
          list.splice(i, 1);
          log.push(`- ${here}: ${String(v).slice(0, 100)}`);
        } else log.push(`! ${here}: shipped file no longer has ${String(v).slice(0, 100)} (remove skipped)`);
      }
      for (const v of sub.$add ?? []) {
        if (!list.includes(v)) {
          list.push(v);
          log.push(`+ ${here}: ${String(v).slice(0, 100)}`);
        }
      }
      for (const v of sub.$append ?? []) {
        if (!list.some((x) => same(x, v))) {
          list.push(structuredClone(v));
          log.push(`+ ${here}: ${JSON.stringify(v).slice(0, 100)}`);
        }
      }
    } else {
      if (!isObj(target[k])) {
        log.push(`! ${here}: shipped file no longer has this object (nested changes skipped)`);
        continue;
      }
      applyDiff(target[k], sub, here, log);
    }
  }
}

function jsonFiles(dir, root = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p, root));
    else if (name.endsWith(".json")) out.push(relative(root, p));
  }
  return out;
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "extract" && a && b) {
  const overlay = {};
  for (const rel of jsonFiles(join(b, ".kiro")).map((r) => join(".kiro", r))) {
    // Engine data and generated manifests are the framework's, not the project's.
    if (rel.startsWith(join(".kiro", "tools"))) continue;
    const mine = join(a, rel);
    if (!existsSync(mine)) continue;
    const d = diff(read(mine), read(join(b, rel)));
    if (d !== undefined && Object.keys(d).length) overlay[rel] = d;
  }
  process.stdout.write(JSON.stringify(overlay, null, 2) + "\n");
} else if (cmd === "apply" && a && b) {
  const overlay = read(b);
  const log = [];
  for (const [rel, d] of Object.entries(overlay)) {
    const p = join(a, rel);
    if (!existsSync(p)) {
      log.push(`! ${rel}: not in the refreshed project (skipped)`);
      continue;
    }
    const doc = read(p);
    const before = JSON.stringify(doc);
    if ("$replace" in d) {
      if (!same(doc, d.$replace)) Object.assign(doc, d.$replace);
    } else applyDiff(doc, d, rel, log);
    if (JSON.stringify(doc) !== before) writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
  }
  process.stdout.write(log.length ? log.join("\n") + "\n" : "overlay already applied\n");
  if (log.some((l) => l.startsWith("!"))) process.exitCode = 3;
} else {
  process.stderr.write("usage: overlay.mjs extract <project-dir> <stock-dir> | apply <project-dir> <overlay.json>\n");
  process.exitCode = 2;
}
