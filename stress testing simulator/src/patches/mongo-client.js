module.exports = function(mongoPath) {
    const originalMongoClient = require(`${mongoPath}/lib/mongo_client`);
    const MODES = require("../const/modes.json");
    const {PYTHAGORA_DB} = require('../const/mongodb');
    const urlParser = require('url');

    if (originalMongoClient.MongoClient) {
        const patchedMongoClient = class MongoClient extends originalMongoClient.MongoClient {
            constructor(url, options) {
                super(url, options);
                global.Pythagora.setMongoClient(this);
            }
        }

        // TODO check and add .connect patches if that's how db can be selected
        // let originalConnectPrototype = originalMongoClient.prototype.connect;
        // patchedMongoClient.prototype.connect = function (url, options, callback) {
        //     return originalConnectPrototype.apply(this, arguments);
        // }
        //
        // let originalConnect = originalMongoClient.connect;
        // patchedMongoClient.connect = function (url, options, callback) {
        //     return originalConnect.apply(this, arguments);
        // }
        originalMongoClient.MongoClient = patchedMongoClient;
        return originalMongoClient;
    } else {
        // older version of Mongodb
        const patchedMongoClient = function (url, options) {
            let client = new originalMongoClient(url, options)
            global.Pythagora.setMongoClient(client);
            return client;
        }
        patchedMongoClient.prototype = originalMongoClient.prototype;

        // this is for transfering static methods
        for (const key in originalMongoClient) {
            patchedMongoClient[key] = originalMongoClient[key];
        }

        // TODO check and add .connect patches if that's how db can be selected
        // let originalConnectPrototype = originalMongoClient.prototype.connect;
        // patchedMongoClient.prototype.connect = function (url, options, callback) {
        //     return originalConnectPrototype.apply(this, arguments);
        // }
        //
        // let originalConnect = originalMongoClient.connect;
        // patchedMongoClient.connect = function (url, options, callback) {
        //     return originalConnect.apply(this, arguments);
        // }
        return patchedMongoClient;
    }
}
