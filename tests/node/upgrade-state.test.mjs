import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutIsClean,
  classifyUpgradeState,
  executeUpgradeTransaction,
  mutationPlan,
} from "../../scripts/upgrade-state.mjs";

const revision = "a".repeat(40);
const healthy = {
  marketplaces: [{
    name: "roku-codex-toolkit",
    marketplaceSource: {
      sourceType: "git",
      source: "https://github.com/preciousidam/roku-codex-toolkit.git",
    },
  }],
  plugins: ["roku-device-toolkit", "roku-engineering"].map((name) => ({
    name,
    marketplaceName: "roku-codex-toolkit",
    version: "0.2.0",
    installed: true,
    enabled: true,
  })),
  receipt: {
    source_type: "git",
    source: "https://github.com/preciousidam/roku-codex-toolkit.git",
    ref_name: "v0.2.0",
    sparse_paths: [],
    revision,
  },
  checkout: { clean: true, head: revision, refRevision: revision },
  targetVersion: "0.3.0",
};

test("healthy official installs are reconstructible", () => {
  const result = classifyUpgradeState(healthy);
  assert.equal(result.disposition, "upgrade");
  assert.equal(result.snapshot.ref, "v0.2.0");
  assert.equal(result.targetRef, "v0.3.0");
});

test("the installed target is a no-op and downgrades are refused", () => {
  assert.equal(classifyUpgradeState({ ...healthy, targetVersion: "0.2.0" }).disposition, "noop");
  assert.equal(classifyUpgradeState({ ...healthy, targetVersion: "0.1.0" }).disposition, "refuse");
});

test("unreconstructible states are refused", () => {
  const cases = [
    { plugins: healthy.plugins.slice(0, 1) },
    { plugins: healthy.plugins.map((plugin, index) => ({ ...plugin, enabled: index !== 0 })) },
    { marketplaces: [{ name: "roku-codex-toolkit", marketplaceSource: { sourceType: "local", source: "/tmp/local" } }] },
    { receipt: undefined },
    { receipt: { ...healthy.receipt, ref_name: "main" } },
    { checkout: { ...healthy.checkout, clean: false } },
    { checkout: { ...healthy.checkout, head: "b".repeat(40) } },
    { plugins: healthy.plugins.map((plugin, index) => ({ ...plugin, version: index ? "0.1.0" : "0.2.0" })) },
    { plugins: [...healthy.plugins, {
      name: "stale-toolkit-plugin",
      marketplaceName: "roku-codex-toolkit",
      version: "0.2.0",
      installed: true,
      enabled: true,
    }] },
  ];
  for (const override of cases) {
    assert.equal(classifyUpgradeState({ ...healthy, ...override }).disposition, "refuse");
  }
});

test("fresh state is directed to setup", () => {
  const result = classifyUpgradeState({ ...healthy, marketplaces: [], plugins: [] });
  assert.equal(result.disposition, "refuse");
  assert.match(result.reason, /use setup/i);
});

test("checkout cleanliness permits only the receipt and Python bytecode caches", () => {
  assert.equal(checkoutIsClean("?? .codex-marketplace-install.json\0", ""), true);
  assert.equal(checkoutIsClean(
    "?? .codex-marketplace-install.json\0",
    "plugins/roku-device-toolkit/scripts/__pycache__/roku_config.cpython-39.pyc\0" +
      "plugins/roku-device-toolkit/mcp/__pycache__/server.cpython-313.pyc\0",
  ), true);
  for (const ignored of [
    ".env\0",
    "artifacts/screen.png\0",
    "plugins/roku-device-toolkit/mcp/private.log\0",
    "plugins/roku-device-toolkit/mcp/__pycache__/credential.txt\0",
  ]) {
    assert.equal(checkoutIsClean("?? .codex-marketplace-install.json\0", ignored), false);
  }
  assert.equal(checkoutIsClean(" M README.md\0", ""), false);
});

function transactionFixture(failAt) {
  const calls = [];
  let mutation = 0;
  const operation = (name) => async (value) => {
    calls.push([name, value]);
    mutation += 1;
    if (mutation === failAt) throw new Error(`failure ${failAt}`);
  };
  return {
    calls,
    operations: {
      inspect: async () => calls.push(["inspect"]),
      removePlugin: operation("removePlugin"),
      removeMarketplace: operation("removeMarketplace"),
      addMarketplace: operation("addMarketplace"),
      addPlugin: operation("addPlugin"),
    },
  };
}

test("upgrade transaction applies the documented mutation order", async () => {
  const fixture = transactionFixture(Number.POSITIVE_INFINITY);
  let verified = false;
  await executeUpgradeTransaction({
    classification: classifyUpgradeState(healthy),
    operations: fixture.operations,
    verifyTarget: async () => { verified = true; },
    verifySnapshot: async () => assert.fail("rollback must not run"),
  });
  assert.equal(verified, true);
  assert.deepEqual(fixture.calls, mutationPlan.map((step) => [
    step.action,
    step.action === "addMarketplace" ? "v0.3.0" : step.value,
  ]));
});

test("every mutation failure attempts complete rollback", async () => {
  for (let failAt = 1; failAt <= mutationPlan.length; failAt += 1) {
    const fixture = transactionFixture(failAt);
    let snapshotVerified = false;
    await assert.rejects(
      executeUpgradeTransaction({
        classification: classifyUpgradeState(healthy),
        operations: fixture.operations,
        verifyTarget: async () => {},
        verifySnapshot: async () => { snapshotVerified = true; },
      }),
      /previous toolkit version was restored/,
    );
    assert.equal(snapshotVerified, true);
    const rollback = fixture.calls.slice(failAt);
    assert.deepEqual(rollback, [
      ["inspect"],
      ["removePlugin", "roku-engineering"],
      ["removePlugin", "roku-device-toolkit"],
      ["removeMarketplace", "roku-codex-toolkit"],
      ["addMarketplace", "v0.2.0"],
      ["addPlugin", "roku-device-toolkit"],
      ["addPlugin", "roku-engineering"],
    ]);
  }
});

test("rollback continues and reports independent recovery failures", async () => {
  const fixture = transactionFixture(1);
  fixture.operations.removeMarketplace = async () => { throw new Error("remove failed"); };
  await assert.rejects(
    executeUpgradeTransaction({
      classification: classifyUpgradeState(healthy),
      operations: fixture.operations,
      verifyTarget: async () => {},
      verifySnapshot: async () => { throw new Error("wrong snapshot"); },
    }),
    (error) => {
      assert.match(error.message, /Removing marketplace: remove failed/);
      assert.match(error.message, /Verifying restored state: wrong snapshot/);
      assert.ok(fixture.calls.some(([name, value]) => name === "addPlugin" && value === "roku-engineering"));
      return true;
    },
  );
});

test("cancellation switches operations into rollback mode before recovery", async () => {
  const calls = [];
  let rollingBack = false;
  const operations = {
    beginRollback: () => { rollingBack = true; calls.push("beginRollback"); },
    inspect: async () => assert.equal(rollingBack, true),
    removePlugin: async () => {
      if (!rollingBack) throw new Error("cancelled");
    },
    removeMarketplace: async () => {},
    addMarketplace: async () => {},
    addPlugin: async () => {},
  };
  await assert.rejects(
    executeUpgradeTransaction({
      classification: classifyUpgradeState(healthy),
      operations,
      verifyTarget: async () => {},
      verifySnapshot: async () => assert.equal(rollingBack, true),
    }),
    /previous toolkit version was restored/,
  );
  assert.deepEqual(calls, ["beginRollback"]);
});

test("rollback removes only resources found by interrupted-state inspection", async () => {
  const removed = [];
  const operations = {
    inspect: async () => ({
      marketplaces: [],
      plugins: [{
        name: "roku-device-toolkit",
        marketplaceName: "roku-codex-toolkit",
        installed: true,
      }],
    }),
    removePlugin: async (name) => { removed.push(["plugin", name]); },
    removeMarketplace: async () => { removed.push(["marketplace"]); },
    addMarketplace: async () => {},
    addPlugin: async () => {},
  };
  let initial = true;
  await assert.rejects(executeUpgradeTransaction({
    classification: classifyUpgradeState(healthy),
    operations: {
      ...operations,
      removePlugin: async (name) => {
        if (initial) {
          initial = false;
          throw new Error("trigger rollback");
        }
        removed.push(["plugin", name]);
      },
    },
    verifyTarget: async () => {},
    verifySnapshot: async () => {},
  }));
  assert.deepEqual(removed, [["plugin", "roku-device-toolkit"]]);
});

test("rollback restores the snapshot's exact canonical source", async () => {
  const restored = [];
  let initial = true;
  const classification = classifyUpgradeState({
    ...healthy,
    marketplaces: [{
      ...healthy.marketplaces[0],
      marketplaceSource: { sourceType: "git", source: "https://github.com/preciousidam/roku-codex-toolkit" },
    }],
    receipt: { ...healthy.receipt, source: "https://github.com/preciousidam/roku-codex-toolkit" },
  });
  await assert.rejects(executeUpgradeTransaction({
    classification,
    operations: {
      inspect: async () => ({ marketplaces: [], plugins: [] }),
      removePlugin: async () => {
        if (initial) { initial = false; throw new Error("trigger rollback"); }
      },
      removeMarketplace: async () => {},
      addMarketplace: async (ref, source) => { restored.push([ref, source]); },
      addPlugin: async () => {},
    },
    verifyTarget: async () => {},
    verifySnapshot: async () => {},
  }));
  assert.deepEqual(restored, [["v0.2.0", "https://github.com/preciousidam/roku-codex-toolkit"]]);
});

test("malformed rollback inventory falls back to best-effort cleanup", async () => {
  const removed = [];
  let initial = true;
  await assert.rejects(executeUpgradeTransaction({
    classification: classifyUpgradeState(healthy),
    operations: {
      inspect: async () => ({ marketplaces: {}, plugins: {} }),
      removePlugin: async (name) => {
        if (initial) { initial = false; throw new Error("trigger rollback"); }
        removed.push(["plugin", name]);
      },
      removeMarketplace: async () => { removed.push(["marketplace"]); },
      addMarketplace: async () => {},
      addPlugin: async () => {},
    },
    verifyTarget: async () => {},
    verifySnapshot: async () => {},
  }));
  assert.deepEqual(removed, [
    ["plugin", "roku-engineering"],
    ["plugin", "roku-device-toolkit"],
    ["marketplace"],
  ]);
});
