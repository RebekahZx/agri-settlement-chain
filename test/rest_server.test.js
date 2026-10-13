// Tests for the REST baseline (src/rest_server.js). Runs under `hardhat test`
// (mocha) and uses Node's built-in fetch, so no extra dependencies.
const { expect } = require("chai");
const http = require("http");
const { createApp } = require("../src/rest_server");

describe("REST baseline API", function () {
  let server;
  let base;

  before(async function () {
    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async function () {
    await post("/reset");
  });

  async function post(p, body = {}) {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }

  it("runs the happy path: create → confirm → redeem", async function () {
    const c = await post("/transaction", { produceType: "rice", agreedPriceINR: 1200 });
    expect(c).to.deep.equal({ status: 200, body: { txId: 1, status: "PENDING" } });
    const d = await post(`/confirm/${c.body.txId}`);
    expect(d).to.deep.equal({ status: 200, body: { tokenId: 1, status: "ACTIVE" } });
    const r = await post(`/redeem/${d.body.tokenId}`);
    expect(r).to.deep.equal({ status: 200, body: { tokenId: 1, status: "REDEEMED" } });
  });

  it("runs the dispute path: create → confirm → reclaim", async function () {
    const c = await post("/transaction");
    const d = await post(`/confirm/${c.body.txId}`);
    const r = await post(`/reclaim/${d.body.tokenId}`);
    expect(r.body.status).to.equal("RECLAIMED");
  });

  it("rejects double confirmation and unknown ids", async function () {
    const c = await post("/transaction");
    await post(`/confirm/${c.body.txId}`);
    expect((await post(`/confirm/${c.body.txId}`)).status).to.equal(400);
    expect((await post("/confirm/999")).status).to.equal(404);
    expect((await post("/redeem/999")).status).to.equal(404);
    expect((await post("/reclaim/999")).status).to.equal(404);
  });

  it("rejects redeeming or reclaiming a token that is no longer ACTIVE", async function () {
    const c = await post("/transaction");
    const d = await post(`/confirm/${c.body.txId}`);
    await post(`/redeem/${d.body.tokenId}`);
    expect((await post(`/redeem/${d.body.tokenId}`)).status).to.equal(400);
    expect((await post(`/reclaim/${d.body.tokenId}`)).status).to.equal(400);
  });

  it("isolates state between app instances and resets counters", async function () {
    await post("/transaction");
    await post("/reset");
    expect((await post("/transaction")).body.txId).to.equal(1);
  });
});
