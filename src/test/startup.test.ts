import assert from "node:assert/strict";
import test from "node:test";
import { loginItemWillLaunch } from "../main/startup";

test("aceita no Windows uma entrada habilitada para o mesmo executável", () => {
  assert.equal(loginItemWillLaunch({
    openAtLogin: false,
    executableWillLaunchAtLogin: true
  }, "win32"), true);
});

test("rejeita no Windows uma entrada desabilitada", () => {
  assert.equal(loginItemWillLaunch({
    openAtLogin: false,
    executableWillLaunchAtLogin: false
  }, "win32"), false);
});
