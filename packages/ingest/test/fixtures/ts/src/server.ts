import express from "express";
import { formatUser, type User } from "./lib/format";
import * as db from "./db";
export { formatUser } from "./lib/format";

const lazy = () => import("./lib/lazy");

export function createServer(port: number) {
  const app = express();
  app.get("/users/:id", async (req, res) => {
    const user = await db.findUser(req.params.id);
    if (!user || user.disabled) {
      return res.status(404).send("not found");
    }
    res.send(formatUser(user));
  });
  return port > 0 ? app.listen(port) : app;
}

export class UserService {
  private cache = new Map<string, User>();

  async get(id: string): Promise<User | undefined> {
    return this.cache.get(id) ?? (await db.findUser(id));
  }

  render(user: User) {
    return formatUser(user);
  }
}

export const toUpper = (s: string) => s.toUpperCase();

void lazy;
