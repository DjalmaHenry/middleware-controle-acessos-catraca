import assert from "node:assert/strict";
import test from "node:test";
import { detectImageMime, PhotoService } from "../main/photo-service";

test("detecta JPEG pelos bytes mesmo com Content-Type incorreto", async () => {
  let receivedAuthorization = false;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const fetcher: typeof fetch = async (_input, init) => {
    receivedAuthorization = new Headers(init?.headers).has("authorization");
    return new Response(jpeg, {
      status: 200,
      headers: { "content-type": "multipart/form-data" }
    });
  };
  const service = new PhotoService(() => undefined, fetcher);

  const result = await service.resolve("https://fotos.example/aluno");

  assert.equal(result, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
  assert.equal(receivedAuthorization, false);
});

test("rejeita conteúdo que não é imagem e conexão sem HTTPS", async () => {
  const fetcher: typeof fetch = async () => new Response("não é uma foto", { status: 200 });
  const service = new PhotoService(() => undefined, fetcher);

  assert.equal(await service.resolve("https://fotos.example/invalida"), null);
  assert.equal(await service.resolve("http://fotos.example/insegura"), null);
});

test("reconhece os formatos de imagem aceitos", () => {
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(detectImageMime(Buffer.from("GIF89a", "ascii")), "image/gif");
  assert.equal(detectImageMime(Buffer.from("RIFF0000WEBP", "ascii")), "image/webp");
});
