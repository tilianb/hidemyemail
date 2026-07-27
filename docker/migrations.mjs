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

/**
 * Splits SQL text into individual statements.
 * @param {string} sql - The SQL text to split.
 * @return {string[]} The SQL statements, excluding comment contents and empty trailing text.
 */
export function splitSqlStatements(sql) {
  const out = [];
  let buffer = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const character = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        buffer += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble && character === "-" && next === "-") {
      inLineComment = true;
      buffer += " ";
      i++;
      continue;
    }
    if (!inSingle && !inDouble && character === "/" && next === "*") {
      inBlockComment = true;
      buffer += " ";
      i++;
      continue;
    }
    if (character === "'" && !inDouble) {
      if (inSingle && next === "'") buffer += sql[i++];
      else inSingle = !inSingle;
    } else if (character === '"' && !inSingle) {
      if (inDouble && next === '"') buffer += sql[i++];
      else inDouble = !inDouble;
    }
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
