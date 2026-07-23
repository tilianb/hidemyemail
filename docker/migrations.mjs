import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function applyMigrations(db, migrationsDir) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied = new Set(
    (await db.prepare("SELECT name FROM d1_migrations").all()).results.map((row) => row.name),
  );
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    console.log(`[hidemyemail] Applying migration ${file}`);
    const statements = splitSqlStatements(sql)
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement));
    statements.push(db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(file));
    await db.batch(statements);
  }
}

export function splitSqlStatements(sql) {
  const out = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  for (const character of sql) {
    if (character === "'" && !inDouble) inSingle = !inSingle;
    else if (character === '"' && !inSingle) inDouble = !inDouble;
    if (character === ";" && !inSingle && !inDouble) {
      out.push(buffer);
      buffer = "";
    } else {
      buffer += character;
    }
  }
  if (buffer.trim()) out.push(buffer);
  return out;
}
