/**
 * Load src/server/.env before any other modules. Use with: ts-node -r ./src/server/load-env
 */
import path from 'path';
import { config } from 'dotenv';
config({ path: path.join(__dirname, '.env') });
