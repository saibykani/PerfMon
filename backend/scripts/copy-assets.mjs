// Copies non-TS assets (SQL migrations) into dist so the compiled server can run migrations.
import { cpSync, existsSync } from 'node:fs';
if (existsSync('src/db/migrations')) cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
