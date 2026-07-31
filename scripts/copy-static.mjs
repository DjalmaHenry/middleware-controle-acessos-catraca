import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/renderer", { recursive: true });
await cp("src/renderer", "dist/renderer", { recursive: true });
await mkdir("dist/assets", { recursive: true });
await cp("assets/icon.png", "dist/assets/icon.png");
await cp("assets/icon.ico", "dist/assets/icon.ico");
