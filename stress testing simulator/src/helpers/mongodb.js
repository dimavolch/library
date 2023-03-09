const pythagoraErrors = require("../const/errors");
const MODES = require("../const/modes.json");
const {
    compareJson,
    convertToRegularObject,
    ObjectId,
    objectIdAsStringRegex,
    regExpRegex,
    mongoIdRegex,
    stringToRegExp,
    isJSONObject,
    isObjectId
} = require("../utils/common.js");
const { logWithStoreId } = require("../utils/cmdPrint.js");

const {v4} = require("uuid");
const _ = require("lodash");
const {MONGO_METHODS} = require("../const/mongodb");
const {PYTHAGORA_DB} = require('../const/mongodb');
let unsupportedMethods = ['aggregate'];

let methods = ['save','find', 'insert', 'update', 'delete', 'deleteOne', 'insertOne', 'updateOne', 'updateMany', 'deleteMany', 'replaceOne', 'replaceOne', 'remove', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndRemove', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndRemove', 'findByIdAndDelete', 'exists', 'estimatedDocumentCount', 'distinct', 'translateAliases', '$where', 'watch', 'validate', 'startSession', 'diffIndexes', 'syncIndexes', 'populate', 'listIndexes', 'insertMany', 'hydrate', 'findOne', 'findById', 'ensureIndexes', 'createIndexes', 'createCollection', 'create', 'countDocuments', 'count', 'bulkWrite', 'aggregate'];

function mongoObjToJson(originalObj) {
    let obj = _.clone(originalObj);
    if (!obj) return obj;
    else if (isObjectId(obj)) return `ObjectId("${obj.toString()}")`;
    if (Array.isArray(obj)) return obj.map(d => {
        return mongoObjToJson(d)
    });
    obj = convertToRegularObject(obj);

    for (let key in obj) {
        if (!obj[key]) continue;
        if (isObjectId(obj[key])) {
            // TODO label a key as ObjectId better (not through a string)
            obj[key] = `ObjectId("${obj[key].toString()}")`;
        } else if (obj[key] instanceof RegExp) {
            obj[key] = `RegExp("${obj[key].toString()}")`;
        } else if (typeof obj[key] === 'object') {
            obj[key] = mongoObjToJson(obj[key]);
        }
    }
    return obj;
}

function jsonObjToMongo(originalObj) {
    let obj = _.clone(originalObj);
    if (!obj) return obj;
    if (Array.isArray(obj)) return obj.map(d => jsonObjToMongo(d));
    else if (typeof obj === 'string' && objectIdAsStringRegex.test(obj)) return stringToMongoObjectId(obj);
    else if (typeof obj === 'string' && mongoIdRegex.test(obj)) return stringToMongoObjectId(`ObjectId("${obj}")`);
    else if (typeof obj === 'string' && regExpRegex.test(obj)) return stringToRegExp(obj);
    else if (isJSONObject(obj)) {
        obj = convertToRegularObject(obj);
        for (let key in obj) {
            if (!obj[key]) continue;
            else if (typeof obj[key] === 'string') {
                // TODO label a key as ObjectId better (not through a string)
                if (objectIdAsStringRegex.test(obj[key])) obj[key] = stringToMongoObjectId(obj[key]);
                else if (mongoIdRegex.test(obj[key])) obj[key] = stringToMongoObjectId(`ObjectId("${obj[key]}")`);
                else if (regExpRegex.test(obj[key])) obj[key] = stringToRegExp(obj[key]);
            } else if (obj[key]._bsontype === "ObjectID") {
                continue;
            } else if (isJSONObject(obj[key]) || Array.isArray(obj[key])) {
                obj[key] = jsonObjToMongo(obj[key]);
            }
        }
    }
    return obj;
}

function stringToMongoObjectId(str) {
    let idValue = str.match(objectIdAsStringRegex);
    if (idValue && idValue[1] && ObjectId.isValid(idValue[1])) {
        return new ObjectId(idValue[1]);
    }
    return str;
}

// TODO provjeriti s Leonom da li je ok da samo maknemo options zato što elementi iz baze mogu biti manji i takvi se insertaju umjesto cijeli
// usually, we won't pass any options because we want to get whole documents
async function getCurrentMongoDocs(collection, query, options = {}) {
    return await new Promise((resolve, reject) => {
        global.asyncLocalStorage.run(undefined, async () => {
            if (Array.isArray(query)) {
                let results = query.map(async q => {
                    let qRes = await collection.find(q.query, options);
                    return await qRes.toArray();
                });
                resolve(_.flatten(await Promise.all(results)));
            } else {
                let result = await collection.find(query, options);
                resolve(await result.toArray());
            }
        });
    });
}


function extractArguments(method, arguments) {
    let returnObj = {
        otherArgs: {}
    };
    // TODO add processing for .multi
    let neededArgs = Object.keys(MONGO_METHODS[method]).slice(1);
    for (let i = 0; i < MONGO_METHODS[method].args.length; i++) {
        let mappedArg = neededArgs.find(d => MONGO_METHODS[method][d].argName === MONGO_METHODS[method].args[i]);
        if (mappedArg) {

            if (MONGO_METHODS[method][mappedArg].multi) {
                let operations = arguments[i];
                returnObj[mappedArg] = operations.map(d => {
                    let op = Object.keys(d)[0];
                    let opNeededArgs = Object.keys(MONGO_METHODS[op]).slice(1);
                    delete opNeededArgs.args;
                    let opArgs = {
                        subOp: op,
                        otherArgs: {}
                    };
                    _.forEach(d[op], (v, k) =>  {
                        let mappedValue = opNeededArgs.find(ona => MONGO_METHODS[op][ona].argName === k);
                        if (mappedValue) opArgs[mappedValue] = v;
                        else opArgs.otherArgs[k] = v;
                    })
                    return opArgs;
                });
            } else {
                let ignoreKeys = MONGO_METHODS[method][mappedArg].ignore;
                let mappsedArgData = arguments[i];
                if (ignoreKeys) mappsedArgData = _.omit(mappsedArgData, ignoreKeys);
                returnObj[mappedArg] = mappsedArgData;
            }
        } else {
            returnObj.otherArgs[MONGO_METHODS[method].args[i]] = arguments[i];
        }
    }

    return returnObj;
}

function checkForErrors(method, request) {
    if (unsupportedMethods.includes(method) && request) {
        request.error = pythagoraErrors.mongoMethodNotSupported(method);
    }
}

async function cleanupDb(pythagora) {
    const dbConnection = pythagora.mongoClient.db(PYTHAGORA_DB);
    if (dbConnection.databaseName === PYTHAGORA_DB) dbConnection.dropDatabase();
}

function createCaptureIntermediateData(db, collection, op, query, options, otherArgs, preQueryRes) {
    return {
        type: 'mongodb',
        id: v4(), // former mongoReqId
        preQueryRes: mongoObjToJson(preQueryRes),
        query: mongoObjToJson(query), // former 'res'
        otherArgs: mongoObjToJson(otherArgs),
        options: mongoObjToJson(options),
        op,
        db,
        collection
    };
}

function findAndCheckCapturedData(collectionName, op, query, options, otherArgs, request, mongoResult, postQueryRes) {
    let capturedData = request.intermediateData.find(d => {
        return !d.processed &&
            d.type === 'mongodb' &&
            d.collection === collectionName &&
            d.op === op &&
            compareJson(d.query, query, true) &&
            compareJson(d.options, options, true) &&
            compareJson(d.otherArgs, otherArgs, true);
    });

    if (capturedData) capturedData.processed = true;
    if (capturedData && (
        !compareJson(capturedData.mongoRes, mongoObjToJson(mongoResult)) ||
        !compareJson(capturedData.postQueryRes, mongoObjToJson(postQueryRes))
    )) {
        request.errors.push(pythagoraErrors.mongoResultDifferent);
    } else if (!capturedData) {
        request.errors.push(pythagoraErrors.mongoQueryNotFound);
    }
}

async function prepareDB(pythagora, req) {
    await cleanupDb(pythagora);

    const testReq = await pythagora.getRequestMockDataById(req);
    if (!testReq) return;

    let uniqueIds = [];
    for (const data of testReq.intermediateData) {
        if (data.type !== 'mongodb') continue;
        let insertData = [];
        for (let doc of data.preQueryRes) {
            if (!uniqueIds.includes(doc._id)) {
                uniqueIds.push(doc._id);
                insertData.push(jsonObjToMongo(doc));
            }
        }
        if (insertData.length) await pythagora.mongoClient.db(PYTHAGORA_DB).collection(data.collection).insertMany(insertData);
    }
}

module.exports = {
    cleanupDb,
    prepareDB,
    findAndCheckCapturedData,
    mongoObjToJson,
    getCurrentMongoDocs,
    extractArguments,
    checkForErrors,
    createCaptureIntermediateData
}
