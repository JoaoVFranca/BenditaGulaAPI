import express, { type Express } from "express";
import { accessSync } from "node:fs";
import { resolve, join } from "node:path";

export function serveFrontend(app: Express, directory: string) {
  const root = resolve(directory);
  accessSync(join(root, "index.html"));
  app.use("/assets", express.static(join(root, "assets"), {
    dotfiles: "deny", index: false, immutable: true, maxAge: "1y",
  }));
  app.use(express.static(root, {
    dotfiles: "deny", maxAge: 0,
    setHeaders(res) { res.setHeader("Cache-Control", "no-cache"); },
  }));
}
