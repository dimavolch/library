const pythagoraErrors = require("../const/errors");
const MODES = require("../const/modes.json");
const { mongoObjToJson, compareJson, jsonObjToMongo, noUndefined } = require("../utils/common.js");
const { logWithStoreId } = require("../utils/cmdPrint.js");

let tryRequire = require("tryrequire");
let mongoose = tryRequire("mongoose");
const {v4} = require("uuid");
const _ = require("lodash");

let methods = ['save','find', 'insert', 'update', 'delete', 'deleteOne', 'insertOne', 'updateOne', 'updateMany', 'deleteMany', 'replaceOne', 'replaceOne', 'remove', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndRemove', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndRemove', 'findByIdAndDelete', 'exists', 'estimatedDocumentCount', 'distinct', 'translateAliases', '$where', 'watch', 'validate', 'startSession', 'diffIndexes', 'syncIndexes', 'populate', 'listIndexes', 'insertMany', 'hydrate', 'findOne', 'findById', 'ensureIndexes', 'createIndexes', 'createCollection', 'create', 'countDocuments', 'count', 'bulkWrite', 'aggregate'];

//.populate() support
function getSchemaTree(str) {
    let key = Object.keys(mongoose.models).find((k) => k.toLowerCase() === str.toLowerCase());
    return  mongoose.models[key].schema.tree;
}

function checkForSchemaTree(schema) {
    return schema && schema.tree ? schema.tree : schema;
}

function getSchemaOptions(schemaTree) {
    //todo check if this can be more than 1 element in array and if so fix accordigly
    let newSchemaTree = Array.isArray(schemaTree) ? schemaTree[0] : schemaTree;
    newSchemaTree = checkForSchemaTree(newSchemaTree);
    if (newSchemaTree.ref) return { ref: newSchemaTree.ref};
    if (newSchemaTree instanceof mongoose.VirtualType) return newSchemaTree.options;

    for (let key of Object.keys(newSchemaTree)) {
        if (newSchemaTree[key].ref) return { ref: newSchemaTree[key].ref }; //todo check and fix for complex population queries
    }
}

function getPopCollection(schemaTreeOriginal, pathArr) {
    let schemaTree = checkForSchemaTree(schemaTreeOriginal)[pathArr[0]];
    //todo check if this can be more than 1 element in array and if so fix accordigly
    schemaTree = Array.isArray(schemaTree) ? schemaTree[0] : schemaTree;
    let {ref} = getSchemaOptions(schemaTree);
    pathArr.shift();
    if (pathArr.length) {
        return getPopCollection(schemaTree, pathArr);
    } else {
        return ref;
    }
}

async function  getPopData(populateDocs, populateOptions, mongoDocs, schema, schemaOptions = undefined) {
    let localField = schemaOptions && schemaOptions.localField ? schemaOptions.localField : populateOptions.path;
    let foreignField = schemaOptions && schemaOptions.foreignField ? schemaOptions.foreignField : '_id';
    let ids = _.flatten(mongoDocs.map((m) => m[localField]));
    if (!ids || !ids.length) return;
    let popCollection = getPopCollection(schema, populateOptions.path.split('.'));
    popCollection = popCollection.toLowerCase() + 's';

    let popDocs = await mongoose.connection.db.collection(popCollection)
        .find({
            [foreignField]: {$in: ids}
        }).toArray();
    populateDocs = populateDocs.concat({
        type: 'mongo',
        subtype: 'populate',
        req: {collection: popCollection},
        preQueryRes: mongoObjToJson(Array.isArray(popDocs) ? popDocs : [popDocs])
    });

    if (populateOptions.populate) {//todo find proper solution to extract new schema from array
        for (let pop of populateOptions.populate) {
            let currentSchema = schema[populateOptions.path];
            let schemaOptions = getSchemaOptions(currentSchema);
            populateDocs = await getPopData(populateDocs, pop, popDocs, getSchemaTree(schemaOptions.ref), schemaOptions);
        }
    }

    return populateDocs;
}
//.populate() support end

async function getMongoDocs(self, stage) {
    let collection,
        req,
        op,
        query,
        populateDocs = [],
        isModel = self instanceof mongoose.Model,
        isQuery = self instanceof mongoose.Query,
        conditions = self._conditions || self._doc;

    if (isQuery) {
        collection = _.get(self, '_collection.collectionName');
        query = jsonObjToMongo(conditions);
        req = _.extend({collection}, _.pick(self, ['op', 'options', '_conditions', '_fields', '_update', '_path', '_distinct', '_doc']));
    } else if (isModel) {
        op = self.$op || self.$__.op;
        if (op !== 'validate') conditions = _.pick(self._doc, '_id');
        query = jsonObjToMongo(conditions)
        collection = self.constructor.collection.collectionName;
        req = {
            collection,
            op: op,
            options: self.$__.saveOptions,
            _doc: self._doc
        }
    } else if (self instanceof mongoose.Aggregate) {
        collection = _.get(self, '_model.collection.collectionName');
        req = {
            collection,
            op: 'aggregate',
            _pipeline: self._pipeline,
            _doc: self._doc
        };
        return { error: new Error(pythagoraErrors.mongoMethodNotSupported('aggregate')) };
    }

    let mongoDocs = [];
    // TODO make a better way to ignore some queries
    if (query && req && req.op) {
        let findQuery = noUndefined(query);//jsonObjToMongo(noUndefined(query));
        let mongoRes = await new Promise(async (resolve, reject) => {
            global.asyncLocalStorage.run(undefined, async () => {
                if (isQuery) {
                    let explaination = await self.model.find(findQuery).explain();
                    try {
                        findQuery = Array.isArray(explaination) ?
                            (explaination[0].command ? explaination[0].command.filter : explaination[0].queryPlanner.parsedQuery) :
                            explaination.command.filter;
                    } catch (e) {
                        console.error('explaination', explaination);
                    }
                }
                resolve(await mongoose.connection.db.collection(collection).find(findQuery).toArray());
            });
        });

        var populatedFields = self._mongooseOptions ? self._mongooseOptions.populate : undefined;
        if (populatedFields && stage === 'pre') for (let field in populatedFields) {
            field = populatedFields[field];
            await new Promise(async (resolve, reject) => {
                global.asyncLocalStorage.run(undefined, async () => {
                    try {
                        populateDocs = await getPopData(populateDocs, field, mongoRes, getSchemaTree(collection.slice(0, -1)));
                    } catch (e) {
                        // dummy catch //todo console.log('population error ', e)
                    }
                    resolve();
                });
            });
        }

        mongoDocs = mongoObjToJson(Array.isArray(mongoRes) ? mongoRes : [mongoRes]);
    }

    return {req, mongoDocs, populateDocs}
}

function configureMongoosePlugin(pythagora) {
    if (!mongoose) return;
    mongoose.plugin((schema) => {
        schema.pre(methods, async function() {
            if (global.asyncLocalStorage.getStore() === undefined ||
                this instanceof mongoose.Types.Embedded) return;
            logWithStoreId('mongo pre');
            this.asyncStore = global.asyncLocalStorage.getStore();
            this.mongoReqId = v4();
            try {
                let request = pythagora.requests[pythagora.getRequestKeyByAsyncStore()];
                if (pythagora.mode === MODES.capture && request) {
                    let mongoRes = await getMongoDocs(this, 'pre');

                    if (mongoRes.error) request.error = mongoRes.error.message;

                    request.intermediateData.push({
                        type: 'mongo',
                        req: mongoObjToJson(_.omit(mongoRes.req, '_doc')),
                        mongoReqId: this.mongoReqId,
                        preQueryRes: mongoObjToJson(mongoRes.mongoDocs)
                    });

                    if (mongoRes.populateDocs) request.intermediateData = request.intermediateData.concat(mongoRes.populateDocs);
                } else {
                    this.originalConditions = mongoObjToJson(this._conditions);
                }
            } catch (e) {
                console.error(_.pick(this, ['op', '_conditions', '_doc']), e);
            }
        });

        schema.post(methods, async function(...args) {
            let doc = args[0];
            let next = args[1];
            if (this.asyncStore === undefined ||
                this instanceof mongoose.Types.Embedded) return next ? next() : null;

            await new Promise(((resolve, reject) => {
                global.asyncLocalStorage.run(this.asyncStore, async() => {
                    try {
                        logWithStoreId('mongo post');
                        var mongoRes = await getMongoDocs(this, 'post');

                        if (pythagora.mode === MODES.test) {
                            pythagora.testingRequests[this.asyncStore].mongoQueriesTest++;
                            let request = pythagora.testingRequests[this.asyncStore];
                            let mongoReq = mongoObjToJson(_.omit(mongoRes.req, '_doc'));
                            let capturedData = request.intermediateData.find(d => {
                                return !d.processed &&
                                    d.type === 'mongo' &&
                                    d.req.op === mongoReq.op &&
                                    d.req.collection === mongoReq.collection &&
                                    compareJson(d.req.options, mongoObjToJson(mongoReq.options), true) &&
                                    compareJson(d.req._conditions, this.originalConditions, true);
                            });
                            if (capturedData) capturedData.processed = true;
                            if (capturedData &&
                                (!compareJson(capturedData.mongoRes, mongoObjToJson(doc)) || !compareJson(capturedData.postQueryRes, mongoObjToJson(mongoRes.mongoDocs)))
                            ) {
                                pythagora.testingRequests[this.asyncStore].errors.push(pythagoraErrors.mongoResultDifferent);
                            } else if (!capturedData) {
                                pythagora.testingRequests[this.asyncStore].errors.push(pythagoraErrors.mongoQueryNotFound);
                            }
                        } else if (pythagora.mode === MODES.capture) {
                            let request = pythagora.requests[pythagora.getRequestKeyByAsyncStore()];
                            if (request) {
                                request.mongoQueriesCapture++;
                                request.intermediateData.forEach((intData, i) => {
                                    if (intData.mongoReqId === this.mongoReqId) {
                                        request.intermediateData[i].mongoRes = mongoObjToJson(doc);
                                        request.intermediateData[i].postQueryRes = mongoObjToJson(mongoRes.mongoDocs);
                                    }
                                });
                            }
                        }
                        if (next) {
                            next();
                        } else {
                            resolve();
                        }
                    } catch (e) {
                        console.error(e);
                    }
                });
            }));
        });
    });
}

async function cleanupDb() {
    try {
        await connectToPythagoraDB();
        const collections = await mongoose.connection.db.collections();
        for (const collection of collections) {
            await collection.drop();
        }
    } catch (e) {
        console.log('Error while cleaning up PythagoraDB: ', e.message);
    }
}

async function connectToPythagoraDB() {
    let pythagoraDb = 'pythagoraDb';
    let connection = mongoose.connections[0];
    let login = connection.user && connection.password ? `${connection.user}:${connection.password}@` : '';
    await mongoose.disconnect();
    for (const connection of mongoose.connections) {
        if (connection.name !== pythagoraDb) await connection.close();
    }
    await mongoose.connect(`mongodb://${login}${connection.host}:${connection.port}/${pythagoraDb}`, {
        useNewUrlParser: true,
        useUnifiedTopology: true
    });
}

module.exports = {
    configureMongoosePlugin,
    cleanupDb,
    connectToPythagoraDB
}
