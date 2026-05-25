import { Hono } from "hono";
import type { AppEnv } from "../app";
import * as q from "../../db/queries";

export function domainRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/domains", async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM domains ORDER BY domain").all();
    return c.json(rows.results ?? []);
  });
  r.post("/domains", async (c) => {
    const { domain, default_destination } = await c.req.json<{ domain: string; default_destination: string }>();
    if (!domain || !default_destination) return c.json({ error: "missing fields" }, 400);
    const id = await q.createDomain(c.env.DB, domain.toLowerCase(), default_destination.toLowerCase());
    return c.json({ id, domain, default_destination });
  });
  return r;
}
