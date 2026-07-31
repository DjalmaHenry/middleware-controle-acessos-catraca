import assert from "node:assert/strict";
import test from "node:test";
import { firewallRemoteAddresses } from "../main/installation-service";

test("restringe o Firewall à rede local e à sub-rede privada do iDSecure", () => {
  assert.deepEqual(
    firewallRemoteAddresses("https://192.168.1.2:30443/#/dashboard"),
    ["LocalSubnet", "192.168.1.0/24"]
  );
  assert.deepEqual(
    firewallRemoteAddresses("https://10.20.30.40:30443"),
    ["LocalSubnet", "10.20.30.0/24"]
  );
});

test("não amplia o Firewall para endereço público ou inválido", () => {
  assert.deepEqual(firewallRemoteAddresses("https://8.8.8.8"), ["LocalSubnet"]);
  assert.deepEqual(firewallRemoteAddresses("endereço inválido"), ["LocalSubnet"]);
});
