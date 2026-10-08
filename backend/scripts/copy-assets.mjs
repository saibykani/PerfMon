// Copies non-TS assets into dist so the compiled server can use them:
//  - SQL migrations (run at startup)
//  - report assets (embedded fonts for PDF / HTML reports)
import { cpSync, existsSync } from 'node:fs';
if (existsSync('src/db/migrations')) cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
if (existsSync('src/reports/assets')) cpSync('src/reports/assets', 'dist/reports/assets', { recursive: true });
