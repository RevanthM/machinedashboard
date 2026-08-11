import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';

const fleetHome = process.env.FLEET_HOME?.trim() || join(homedir(), '.fleet-console');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: join(fleetHome, 'fleet.db'),
  },
});
