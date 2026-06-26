import { buildSampleEvents, seedEvents } from "../src/seed-events.js";

const base = process.env.CHOBO_BASE_URL ?? "http://localhost:8787";
const count = Number(process.env.SEED_COUNT ?? "500");
const days = Number(process.env.SEED_DAYS ?? "30");
const secret = process.env.CHOBO_INGEST_SECRET?.trim() || undefined;

const events = buildSampleEvents({ count, days, seed: 7 });
seedEvents(base, events, secret)
  .then((r) => { console.log(`chobo seed → ${base}:`, r); process.exit(0); })
  .catch((e) => { console.error("chobo seed failed:", e); process.exit(1); });
