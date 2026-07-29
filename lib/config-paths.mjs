// lib/config-paths.mjs — one place that answers "where do the owner-editable configs live?".
//
// The files behind /api/settings (data/*.config.json + grading-companies.json) are read by the
// feature modules and REWRITTEN IN PLACE by a settings PUT. That makes them the one part of the
// data dir a test can dirty: an integration run that exercises a PUT would otherwise leave the
// checked-in data/tracker.config.json modified — and an aborted run leaves it modified for the
// next one, which then fails its round-trip from a moved baseline.
//
// TCG_CONFIG_DIR redirects the whole set at a copy, so the suite can exercise real saves against
// disposable files. Same escape hatch as TCG_TRACKER_DB / TCG_BACKUP_DIR, and unset in production.
// Only the editable set moves: baked catalogue data (riftbound.json, pokemon-*.json) and the
// tracked *.config.example.json seeds are always read from the repo's own data/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_DIR = process.env.TCG_CONFIG_DIR || path.join(ROOT, 'data');

export const configFile = (name) => path.join(CONFIG_DIR, name);

// True when the configs are the repo's own — used to label them 'data/x.json' in the UI.
export const configIsCanonical = CONFIG_DIR === path.join(ROOT, 'data');
