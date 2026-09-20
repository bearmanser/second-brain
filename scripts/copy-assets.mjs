import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist/storage/migrations', { recursive: true });
cpSync('src/storage/migrations', 'dist/storage/migrations', { recursive: true });
