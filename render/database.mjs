import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
// Rooms are ephemeral match sessions. No paid database or persistent disk needed.
export function createRoomDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_fine_rafael_vega.sql',import.meta.url),'utf8'));
  return {prepare(sql) {
    const statement=sqlite.prepare(sql);
    const bound=(values=[])=>({bind(...args){return bound(args)},async run(){const r=statement.run(...values);return {meta:{changes:Number(r.changes)}}},async first(){return statement.get(...values)??null}});
    return bound();
  }, close(){sqlite.close()}};
}
