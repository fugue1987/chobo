// Self-references via "exports" require condition -> dist/index.cjs.
const chobo = require("@chobo/sdk");
if (typeof chobo.init !== "function") { console.error("CJS: init missing"); process.exit(1); }
if (typeof chobo.meterStream !== "function") { console.error("CJS: meterStream missing"); process.exit(1); }
if (chobo.VERSION !== "0.1.0") { console.error("CJS: VERSION wrong"); process.exit(1); }
console.log("CJS OK");
