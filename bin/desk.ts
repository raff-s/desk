#!/usr/bin/env node
import { main } from "../src/core/cli.ts";

process.exitCode = await main(process.argv.slice(2));
