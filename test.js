const assert = require("node:assert");
const { priceOf, mergePrices, globalActive, viewList } = require("./lib.js");

const item = (id, name, rarity, count = 1) => ({ card_id: id, count, card: { id, wikipedia_title: name, rarity } });
const list = [item("a", "Alpha", "C"), item("b", "Beta", "L", 3), item("c", "Gamma", "SR"), item("d", "Delta", "C")];
const prices = {
  alpha: { name: "Alpha", byRarity: { C: 10 }, ts: 1 },
  beta: { name: "Beta", byRarity: { L: 500 }, ts: 1 },
  gamma: { name: "Gamma", byRarity: { SR: 90 }, ts: 1 },
};
const ids = { a: { count: 1 }, b: { count: 3 }, c: { count: 1 }, d: { count: 1 } };
const names = (v) => viewList(list, prices, ids, { sort: "off", scope: "all", rar: [], dup: false, ...v }).map((it) => it.card.wikipedia_title);

assert.deepStrictEqual(names({ sort: "desc" }), ["Beta", "Gamma", "Alpha", "Delta"]);
assert.deepStrictEqual(names({ sort: "asc" }), ["Alpha", "Gamma", "Beta", "Delta"]);
assert.deepStrictEqual(names({ rar: ["C"] }), ["Alpha", "Delta"]);
assert.deepStrictEqual(names({ dup: true }), ["Beta"]);
assert.deepStrictEqual(names({ sort: "desc", rar: ["C", "SR"] }), ["Gamma", "Alpha", "Delta"]);
assert.strictEqual(viewList(list, prices, ids, { sort: "desc", scope: "all", rar: [], dup: false })[0], list[1]);

assert.strictEqual(globalActive({ sort: "desc", scope: "all", rar: [], dup: false }), true);
assert.strictEqual(globalActive({ sort: "desc", scope: "page", rar: ["L"], dup: true }), false);
assert.strictEqual(globalActive({ sort: "off", scope: "all", rar: [], dup: false }), false);

assert.strictEqual(priceOf(prices, " BETA ", "L"), 500);
assert.strictEqual(priceOf(prices, "Beta", "LEGENDARY"), 500);
assert.ok(Number.isNaN(priceOf({ x: { byRarity: { L: 5, C: 1 } } }, "x", "SR")));
assert.ok(Number.isNaN(priceOf(prices, "Inconnue", "C")));

const m = mergePrices(
  { beta: { name: "Beta", byRarity: { L: 500 }, ts: 5 } },
  { beta: { name: "Beta", byRarity: { L: 450, C: 3 }, prev: { L: 500 }, ts: 9 } }
);
assert.deepStrictEqual(m.beta, { name: "Beta", byRarity: { L: 450, C: 3 }, prev: { L: 500 }, ts: 9 });

console.log("OK");
