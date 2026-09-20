#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types
/**
 * Bin shim for `agentlens` / `agl`. Node 22.7+ transforms the types itself
 * (transform-types, not strip-only, because workspace packages use TS
 * parameter properties), so the published package runs straight from source
 * (esbuild single-file bundling is deferred to M7, §13).
 */
import { main } from './index.ts'

main()
