#!/usr/bin/env node
import * as NodeUtil from "node:util";
import { prune } from "./lib/fork-build-cache.cjs";

const { values } = NodeUtil.parseArgs({
  options: { "dry-run": { type: "boolean" }, days: { type: "string", default: "14" } },
});
prune({ days: Number(values.days), dryRun: values["dry-run"] ?? false });
