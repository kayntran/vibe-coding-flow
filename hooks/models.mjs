#!/usr/bin/env node
// Vai -> model mới nhất trên máy; đổi model cho vai. Dùng: node ~/.claude/hooks/models.mjs pick|set|reset|list (xem lib/models.mjs).
import { runCli } from './lib/models.mjs'

process.exitCode = runCli(process.argv.slice(2))
