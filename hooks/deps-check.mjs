#!/usr/bin/env node
// deps-check.mjs — cổng thư viện mới (AC-38) bằng lib/deps.mjs. Công cụ CLI (không phải hook): skill flow-*, captain, cổng commit gọi.
// Tìm thư viện MỚI trong diff package.json / go.mod rồi kiểm: có thật, đủ tuổi, tên không giống package phổ biến, không lỗ hổng/mã độc đã biết.
//
//   node deps-check.mjs [--repo <dir>] [--base <ref|none>] [--head <ref|:>] [--min-age <ngày>] [--list] [--json]
//       so base (mặc định HEAD; none = repo trống) với head (mặc định ":" = bản đã git add, tức thứ sắp commit)
//   node deps-check.mjs --vet npm:<tên>[@bản] | go:<module>[@bản]     kiểm một gói (trước khi thêm vào)
//   --list: chỉ liệt kê thư viện mới, không gọi mạng
//
// Exit: 0 ổn / không có gì mới (kể cả khi có gói "chưa kiểm được" vì mạng — dòng đó vẫn in rõ, không im lặng) ·
//       1 có thư viện có vấn đề · 2 không chạy được (sai cách dùng, mốc git/repo không đọc được; không coi là sạch).
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MIN_AGE_DAYS, newPackages, vetAll } from './lib/deps.mjs'

class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg) }

const USAGE = `deps-check.mjs — cổng thư viện mới
  deps-check [--repo <dir>] [--base <ref|none>] [--head <ref|:>] [--min-age <ngày>] [--list] [--json]
      thư viện mới giữa base (mặc định HEAD) và head (mặc định ":" = bản đã git add)
  deps-check --vet npm:<tên>[@bản] | go:<module>[@bản]
      kiểm một gói trước khi thêm
  --list  chỉ liệt kê, không gọi mạng · --json  ra JSON · --min-age  ngưỡng tuổi (mặc định ${DEFAULT_MIN_AGE_DAYS} ngày)
exit: 0 ổn · 1 có thư viện có vấn đề · 2 không chạy được`

const VALUE_FLAGS = new Set(['--repo', '--base', '--head', '--min-age', '--vet'])
const BOOL_FLAGS = new Set(['--list', '--json', '--help', '-h'])

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (BOOL_FLAGS.has(flag)) a[flag.replace(/^-+/, '')] = true
    else if (VALUE_FLAGS.has(flag)) {
      if (i + 1 >= argv.length) fail(`${flag} cần một giá trị\n${USAGE}`)
      a[flag.slice(2)] = argv[++i]
    } else fail(`đối số không hợp lệ: ${flag}\n${USAGE}`)
  }
  return a
}

function parseVetTarget(target) {
  const m = /^(npm|go):(.+)$/.exec(target)
  if (!m) fail(`--vet cần dạng npm:<tên>[@bản] hoặc go:<module>[@bản], nhận "${target}"`)
  const [, eco, rest] = m
  const at = rest.lastIndexOf('@')
  return { eco, name: at > 0 ? rest.slice(0, at) : rest, version: at > 0 ? rest.slice(at + 1) : eco === 'npm' ? 'latest' : '' }
}

const label = (p) => `${p.eco} ${p.name}${p.version ? `@${p.version}` : ''}`
function describe(r) {
  if (r.status === 'ok') return `OK     ${label(r)} — có thật, ${r.ageDays} ngày tuổi, chưa thấy lỗ hổng`
  if (r.status === 'bad') return `LỖI   ${label(r)} — ${r.problems.join('; ')}${r.unknown.length ? ` (và chưa kiểm được: ${r.unknown.join('; ')})` : ''}`
  return `CHƯA   ${label(r)} — chưa kiểm được: ${r.unknown.join('; ')}`
}

// Package nguồn git/URL user đã duyệt: .claude/flow.json {"trustedDepSources": ["tên@nguồn", …]} của HEAD (cùng cách đọc với cổng flow-gate).
// Chỉ đọc bản đã commit, không đọc đĩa/index. Không có repo, HEAD hoặc flow.json, hoặc file hỏng/sai kiểu ⇒ [] (không tin ai, như cũ).
function trustedDepSources(repo) {
  const r = spawnSync('git', ['cat-file', 'blob', 'HEAD:.claude/flow.json'], { cwd: repo, encoding: 'utf8' })
  if (r.error || r.status !== 0) return []
  try {
    const list = JSON.parse(r.stdout.replace(/^﻿/, ''))?.trustedDepSources
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []
  } catch {
    return []
  }
}

export async function run(argv, io = {}) {
  try {
    const a = parseArgs(argv)
    if (a.help || a.h) return { lines: [USAGE], errLines: [], code: 0 }
    let minAgeDays
    if (a['min-age'] !== undefined) {
      minAgeDays = Number(a['min-age'])
      if (!Number.isFinite(minAgeDays) || minAgeDays < 0) fail(`--min-age cần một số ngày, nhận "${a['min-age']}"`)
    }
    const vetOpts = { fetch: io.fetch, now: io.now, minAgeDays, trustedSources: trustedDepSources(a.repo ?? '.') }

    const pkgs = a.vet !== undefined
      ? [parseVetTarget(a.vet)]
      : newPackages(a.base === 'none' ? null : a.base ?? 'HEAD', a.head ?? ':', a.repo ?? '.')

    if (a.list) {
      const lines = pkgs.length ? pkgs.map((p) => `${label(p)}${p.source ? ` [nguồn ${p.source}]` : ''} (${p.file})`) : ['Không có thư viện mới.']
      return { lines: a.json ? [JSON.stringify({ ok: true, packages: pkgs })] : lines, errLines: [], code: 0 }
    }

    const results = await vetAll(pkgs, vetOpts)
    const count = (s) => results.filter((r) => r.status === s).length
    const code = count('bad') ? 1 : 0
    if (a.json) return { lines: [JSON.stringify({ ok: code === 0, packages: results })], errLines: [], code }
    const lines = results.map(describe)
    lines.push(results.length
      ? `Kết quả: ${results.length} thư viện mới — ${count('ok')} ổn, ${count('bad')} có vấn đề, ${count('unknown')} chưa kiểm được`
      : 'Không có thư viện mới.')
    return { lines, errLines: [], code }
  } catch (e) {
    return { lines: [], errLines: [`deps-check: ${e instanceof Fail ? e.message : e?.message ?? e}`], code: 2 }
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) {
  const { lines, errLines, code } = await run(process.argv.slice(2))
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`)
  if (errLines.length) process.stderr.write(`${errLines.join('\n')}\n`)
  process.exitCode = code
}
