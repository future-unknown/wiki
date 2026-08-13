#!/usr/bin/env node
import { main } from '../lib/index.js'

process.exitCode = await main(process.argv.slice(2))
