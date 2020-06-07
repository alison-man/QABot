const fs = require('fs')
const crypto = require('crypto')
const lotus = require('./lotus');
const backend = require('./backend');
var uniqueFilename = require('unique-filename')

let stop = false;
let topMinersList = new Array;
let storageDealsMap = new Map();
let retriveDealsMap = new Map();

let statsStorageDealsActive = 0;
let statsStorageDealsPending = 0;
let statsStorageDealsCompleted = 0;
let statsStorageDealsFailed = 0;
let statsRetrieveDealsSuccessful = 0;
let statsRetrieveDealsFailed = 0;

const RETRIVING_ARRAY_MAX_SIZE = 1000000 //items
const BUFFER_SIZE = 65536 //64KB
const MIN_MINER_POWER = 1 //790273982464(736 GiB) //ex
const FILE_SIZE_EXTRA_SMALL = 100
const FILE_SIZE_SMALL = 104857600   //(100MB)
const FILE_SIZE_MEDIUM = 1073741824  //(1GB)
const FILE_SIZE_LARGE = 5368709120  // (5GB)
const MAX_PENDING_STORAGE_DEALS = 2;

const dealStates = [
"StorageDealUnknown",
"StorageDealProposalNotFound",
"StorageDealProposalRejected",
"StorageDealProposalAccepted",
"StorageDealAcceptWait",
"StorageDealStaged",
"StorageDealSealing",
"StorageDealActive",
"StorageDealFailing",
"StorageDealNotFound",
"StorageDealFundsEnsured",
"StorageDealWaitingForDataRequest",
"StorageDealValidating",
"StorageDealTransferring",
"StorageDealWaitingForData",
"StorageDealVerifyData",
"StorageDealEnsureProviderFunds",
"StorageDealEnsureClientFunds",
"StorageDealProviderFunding",
"StorageDealClientFunding",
"StorageDealPublish",
"StorageDealPublishing",
"StorageDealError",
"StorageDealCompleted"
]

function INFO(msg) {
  console.log('\x1b[32m', '[ INFO ] ', '\x1b[0m', msg);
}

function ERROR(msg) {
  console.log('\x1b[31m', '[ ERR  ] ', '\x1b[0m', msg);
}

function WARNING(msg) {
  console.log('\x1b[33m', '[ WARN ] ', '\x1b[0m', msg);
}

function RemoveLineBreaks(data) {
  return data.toString().replace(/(\r\n|\n|\r)/gm, "");
}

function RandomTestFilePath() {
  const path = require('path');
  return path.join(process.env.HOME,uniqueFilename('.', 'qab-testfile'));
}

function RandomTestFileSize() {
  return FILE_SIZE_EXTRA_SMALL; //TODO: generate random size [FILE_SIZE_SMALL,FILE_SIZE_MEDIUM,FILE_SIZE_LARGE]
}

function GenerateTestFile(filePath) {
  var size = RandomTestFileSize();

  const fd = fs.openSync(filePath, 'w');
  const hash = crypto.createHash('sha256');

  var start = new Date();

  try {
    for (i = 0; i < size / BUFFER_SIZE; i++) {
      const buffer = crypto.randomBytes(BUFFER_SIZE);
      var bytesWritten = fs.writeSync(fd, buffer, 0, BUFFER_SIZE);
      hash.update(buffer.slice(0, bytesWritten));
    }

  } finally {
    fs.closeSync(fd);
  }

  var testFileHash = hash.digest('hex');
  var end = new Date() - start;

  INFO(`GenerateTestFile: ${filePath} sha256: ${testFileHash}`);
  console.log('GenerateTestFile Execution time: %dms', end);

  return testFileHash;
}

function DeleteTestFile(filename) {
  try {
    fs.unlinkSync(filename);
    INFO("DeleteTestFile : " + filename);
  } catch(err) {
    ERROR(err)
  }
}

function GetTopMiners() {
  const createCsvWriter = require('csv-writer').createObjectCsvWriter;
  const csvMiners = createCsvWriter({
    path: 'qabminers.csv',
    header: [
      { id: 'address', title: 'ADDRESS' },
      { id: 'power', title: 'POWER' }
    ]
  });

  lotus.StateListMiners().then(json => {
    json.result.reduce((previousPromise, miner) => {
      return previousPromise.then(() => {
        return lotus.StateMinerPower(miner).then(data => {
          if (data.result.MinerPower.QualityAdjPower > 0) {
            const records = [
              { address: miner, power: data.result.MinerPower.QualityAdjPower }
            ];

            topMinersList.push({
              address: miner,
              power: data.result.MinerPower.QualityAdjPower
            })

            csvMiners.writeRecords(records);
            INFO(miner + " power: " + data.result.MinerPower.QualityAdjPower);
          }
        }).catch(error => {
          ERROR(error);
        });
      });
    }, Promise.resolve());

  }).catch(error => {
    ERROR(error);
  });
}

function LoadMiners() {
  return new Promise(function (resolve, reject) {
    backend.GetMiners().then(response => {
      if (response.status == 200 && response.data && response.data.items) {
        topMinersList.length = 0;
        response.data.items.forEach(miner => {
          if (miner.id && miner.power) {
            topMinersList.push({
              address: miner.id,
              power: miner.power
            })
          }
        });
      }

      INFO("topMinersList: " + topMinersList.length);
      resolve(true);

    }).catch(error => {
      console.log(error);
    });
  })
}

function LoadTopMiners() {
  return new Promise(function (resolve, reject) {
    const csv = require('csv-parser')
    const fs = require('fs')
    const results = [];
    topMinersList = [];

    fs.createReadStream('qabminers1.csv')
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        results.forEach(miner => {
          topMinersList.push({
            address: miner.ADDRESS,
            power: miner.POWER
          })
        });

        INFO("topMinersList: " + topMinersList.length);
        resolve(true);
      });
  })
}

function CalculateStorageDealPrice(askPrice) {
  const BigNumber = require('bignumber.js');

  let x = new BigNumber(askPrice);
  let y = new BigNumber(1000000000000000000);
  return x.dividedBy(y).toString(10);
}

function StorageDeal(miner) {
  return new Promise(function (resolve, reject) {

    INFO("StorageDeal [" + miner + "]");
    lotus.StateMinerInfo(miner).then(data => {
      INFO("StateMinerInfo [" + miner + "] PeerId: " + data.result.PeerId);
      if (data.result.PeerId) {
        lotus.ClientQueryAsk(data.result.PeerId, miner).then(data => {
          if (data.error) {
            ERROR("ClientQueryAsk : " + JSON.stringify(data));
            //FAILED -> send result to BE
            backend.SaveStoreDeal(miner, false, 'ClientQueryAsk failed : ' + data.error.message);
            resolve(false);
          } else if (data.result && data.result.Ask && data.result.Ask.Price) {
            INFO("ClientQueryAsk : " + JSON.stringify(data));
            let price = CalculateStorageDealPrice(data.result.Ask.Price);
            //generate new file
            var filePath = RandomTestFilePath();
            var fileHash = GenerateTestFile(filePath);

            lotus.ClientImport(filePath).then(data => {
              var dataCid = RemoveLineBreaks(data);
              INFO("ClientImport : " + dataCid);

              INFO("Before ClientStartDeal: " + dataCid + " " + miner + " " + price + " 10000");

              lotus.ClientStartDeal(dataCid,
                miner, price, '10000').then(data => {
                  var dealCid = RemoveLineBreaks(data);
                  INFO("ClientStartDeal: " + dealCid);

                  if (!storageDealsMap.has(dealCid)) {
                    storageDealsMap.set(dealCid, {
                      dataCid: dataCid,
                      miner: miner,
                      filePath: filePath,
                      fileHash: fileHash,
                      timestamp: Date.now()
                    })
                  }

                  resolve(true);
                }).catch(error => {
                  ERROR(error);
                  resolve(false);
                });
            }).catch(error => {
              ERROR(error);
              resolve(false);
            });
          }
        }).catch(error => {
          ERROR(error);
          resolve(false);
        });
      }
    }).catch(error => {
      ERROR(error);
      resolve(false);
    });
  })
}

function RetrieveDeal(dataCid, retrieveDeal) {
  return new Promise(function (resolve, reject) {
    INFO("RetrieveDeal [" + dataCid + "]");
    outFile = RandomTestFilePath();

    lotus.ClientRetrieve(dataCid, outFile).then(data => {
      console.log(RemoveLineBreaks(data));
      var hash = SHA256FileSync(outFile);
      INFO("RetrieveDeal [" + dataCid + "] SHA256: " + hash);
      if (hash == retrieveDeal.hash) {
        INFO(`Retrieved successfully : ${testFileName} sha256: ${hash}`);
        statsRetrieveDealsSuccessful++;
        retriveDealsMap.delete(dataCid);
        //PASSED -> send result to BE
        backend.SaveRetrieveDeal(retrievingDataItem.miner, true, 'success');
        resolve(true);
      }
      else {
        WARNING(`Retrieving test failed for : ${testFileName} sha256: ${hash}`);
        statsRetrieveDealsFailed++;
        retriveDealsMap.delete(dataCid);
        //FAILED -> send result to BE
        backend.SaveRetrieveDeal(retrievingDataItem.miner, false, 'hash check failed');
        resolve(true);
      }
    }).catch(error => {
      ERROR(error);
      resolve(false);
    });
  })
}




function SHA256File(path) {
  return new Promise((resolve, reject) => {
    const output = crypto.createHash('sha256')
    const input = fs.createReadStream(path)

    input.on('error', (err) => {
      reject(err)
    })

    output.once('readable', () => {
      resolve(output.read().toString('hex'))
    })

    input.pipe(output)
  })
}

function SHA256FileSync(path) {
  const fd = fs.openSync(path, 'r')
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.alloc(BUFFER_SIZE)

  try {
    let bytesRead

    do {
      bytesRead = fs.readSync(fd, buffer, 0, BUFFER_SIZE)
      hash.update(buffer.slice(0, bytesRead))
    } while (bytesRead === BUFFER_SIZE)
  } finally {
    fs.closeSync(fd)
  }

  return hash.digest('hex')
}

function DealTimeout(item) {
  var timeDifference = Math.abs(Date.now() - item.timestamp);

  if (timeDifference > 1000 * 10) //10 sec
    return true;

  return false;
}

async function RunStorageDeals() {
  if (storageDealsMap.size <= MAX_PENDING_STORAGE_DEALS) {
    var it = 0;
    while (!stop && (it < topMinersList.length)) {
      await StorageDeal(topMinersList[it].address);
      await pause();
      it++;
    }
  }
}

async function RunRetriveDeals() {
  for (const [key, value] of retriveDealsMap.entries()) {
    if (stop)
     break;

    await RetrieveDeal(key, value);
    await pause();
  }
}

function StorageDealStatus(dealCid, pendingStorageDeal) {
  return new Promise(function (resolve, reject) {
    lotus.ClientGetDealInfo(dealCid).then(data => {
      if (data && data.result && data.result.State) {

        INFO("ClientGetDealInfo [" + dealCid + "] State: " + dealStates[data.result.State] + " dataCid: " + pendingStorageDeal.dataCid);
        INFO("ClientGetDealInfo: " + JSON.stringify(data));


        if (dealStates[data.result.State] == "StorageDealCompleted" ||
          dealStates[data.result.State] == "StorageDealActive") {
          
          if (dealStates[data.result.State] == "StorageDealActive")
            statsStorageDealsActive++;
          else
            statsStorageDealsCompleted++;


          DeleteTestFile(pendingStorageDeal.filePath);

          if (!retriveDealsMap.has(pendingStorageDeal.dataCid)) {
            retriveDealsMap.set(pendingStorageDeal.dataCid, {
              miner: pendingStorageDeal.miner,
              filePath: pendingStorageDeal.filePath,
              fileHash: pendingStorageDeal.fileHash,
              timestamp: Date.now()
            })
          }

          storageDealsMap.delete(dealCid);
          //PASSED -> send result to BE
          backend.SaveStoreDeal(pendingStorageDeal.miner, true, 'success');

        } else if (dealStates[data.result.State] == "StorageDealSealing") {
          statsStorageDealsPending++;
        } else if (dealStates[data.result.State] == "StorageDealError") {
          statsStorageDealsFailed++;
          DeleteTestFile(pendingStorageDeal.filePath);
          storageDealsMap.delete(dealCid);
          //FAILED -> send result to BE
          backend.SaveStoreDeal(pendingStorageDeal.miner, false, 'state StorageDealError');
        } else if (DealTimeout(pendingStorageDeal.timestamp)) {
          statsStorageDealsFailed++;
          DeleteTestFile(pendingStorageDeal.filePath);
          storageDealsMap.delete(dealCid);
          //FAILED -> send result to BE
          backend.SaveStoreDeal(pendingStorageDeal.miner, false, 'timeout in state: ' + dealStates[data.result.State]);
        }

        resolve(true);
      } else {
        WARNING("ClientGetDealInfo: " + JSON.stringify(data));
        resolve(false);
      }
    }).catch(error => {
      ERROR(error);
      resolve(false);
    });
  })
}

async function CheckPendingStorageDeals() {
  for (const [key, value] of storageDealsMap.entries()) {
    if (stop)
     break;

     await StorageDealStatus(key, value);
     await pause();
  }
}

function PrintStats() {
  INFO("*****************STATS*****************");
  INFO("StorageDeals: TOTAL : " + statsStorageDealsActive + statsStorageDealsPending + statsStorageDealsCompleted + statsStorageDealsFailed);
  INFO("StorageDeals: ACTIVE : " + statsStorageDealsActive);
  INFO("StorageDeals: PENDING : " + statsStorageDealsPending);
  INFO("StorageDeals: COMPLETED : " + statsStorageDealsCompleted);
  INFO("StorageDeals: FAILED : " + statsStorageDealsFailed);

  INFO("StorageDeals: TOTAL : " + statsRetrieveDealsSuccessful + statsRetrieveDealsFailed);
  INFO("StorageDeals: SUCCESSFUL : " + statsRetrieveDealsSuccessful);
  INFO("StorageDeals: FAILED : " + statsRetrieveDealsFailed);
  INFO("***************************************")
}

const pause = () => new Promise(res => setTimeout(res, 2000));

const mainLoop = async _ => {
  while (!stop) {
    await LoadMiners();
    await RunStorageDeals();
    await CheckPendingStorageDeals();
    await RunRetriveDeals();
    await pause();

    PrintStats();
  }
};

mainLoop();

function shutdown() {
  stop = true;

  setTimeout(() => { 
    INFO(`Shutdown`);
    process.exit(); 
  }, 3000);
}
// listen for TERM signal .e.g. kill
process.on('SIGTERM', shutdown);
// listen for INT signal e.g. Ctrl-C
process.on('SIGINT', shutdown);
