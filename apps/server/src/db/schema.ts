import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Only channel identity is scaffolded. Feature tables arrive with their owning feature.
export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
