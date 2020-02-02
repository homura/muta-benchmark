const autocannon = require("autocannon");
const ora = require("ora");
const Table = require("cli-table3");
const logger = require("./logger");
const { AssetBenchProducer } = require("./BenchProducer");

function round(x) {
  return parseFloat(Math.round(x * 100) / 100).toFixed(2);
}

const signatures = [];

async function bench(options) {
  let errorCount = 0;

  const { gap, pk, assetId, url, receiver, chainId, preSignCount, txPerSec } = options;
  const assetBenchProducer = new AssetBenchProducer({
    pk,
    chainId,
    gap,
    url,
    assetId,
    receiver
  });

  if (!assetId) {
    const createAssetSpin = ora("Creating asset").start();
    try {
      const asset = await assetBenchProducer.createAsset();
      createAssetSpin.succeed(`Created asset ${JSON.stringify(asset)}`);
    } catch (e) {
      createAssetSpin.fail(`Asset create failed, ${e.message}`);
    }
  }

  await assetBenchProducer.prepare();

  const signSpin = ora("Preparing signature").start();
  for (let i = 0; i < preSignCount; i++) {
    signatures.push(assetBenchProducer.produceRequestBody());
  }
  signSpin.succeed(`Prepared ${preSignCount} signatures`);

  let before;
  let count;
  function getBody() {
    if (!before) before = Date.now();
    if (Date.now() - before >= 1000) {
      before = Date.now();
      count = 0;
    } else {
      count += 1;
    }

    if (txPerSec > count && signatures.length > 0) {
      return signatures.shift();
    }
    return assetBenchProducer.produceRequestBody();
  }

  await assetBenchProducer.start();

  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        ...options,
        setupClient(client) {
          client.setBody(getBody());
        }
      },
      finishedBench
    );

    autocannon.track(instance);

    instance.on("response", function(client, statusCode, returnBytes, responseTime) {
      const res = client.parser.chunk.toString();
      const isError = res.includes("error");
      if (isError) {
        logger.error(res);
        errorCount++;
      }
      client.setBody(getBody());
    });

    instance.on("done", async function({ start, duration }) {
      const spin = ora("TPS is calculating ").start();
      const { blockUsage, transferProcessed, blocks } = await assetBenchProducer.end();
      spin.stop();

      const txCount = transferProcessed;
      const blockCount = blockUsage;

      const balanceTable = new Table({ head: ["", "balance", "block height"] });
      balanceTable.push(
        { init: [assetBenchProducer.startBalance, assetBenchProducer.startBlock] },
        { done: [assetBenchProducer.endBalance, assetBenchProducer.endBlock] }
      );

      console.log("block_id \t\t count \t\t\t round");
      Object.entries(blocks)
        .sort((l, r) => Number(l[0]) - Number(r[0]))
        .forEach(([id, info]) => {
          console.log(`${id} \t\t\t ${info.transactionsCount} \t\t\t ${info.round}`);
        });

      console.log("TPS:");
      console.log(balanceTable.toString());

      console.log(`${round(txCount / blockCount)} tx/block`);
      console.log(`${round(duration / blockCount)} sec/block`);
      console.log(`${round(txCount / duration)} tx/sec`);
    });

    function finishedBench(err) {
      if (err) reject(err);
      else resolve({ errorCount });
    }
  });
}

module.exports = bench;
