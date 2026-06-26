// Self-references the package by name (resolves via package.json "exports" -> dist/index.js).
import * as chobo from "@chobo/sdk";
if (typeof chobo.init !== "function") { console.error("ESM: init missing"); process.exit(1); }
if (typeof chobo.meterStream !== "function") { console.error("ESM: meterStream missing"); process.exit(1); }
if (chobo.VERSION !== "0.1.0") { console.error("ESM: VERSION wrong"); process.exit(1); }
console.log("ESM OK");
