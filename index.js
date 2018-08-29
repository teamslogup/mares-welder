const url = require('url');
const fs = require('fs');
const path = require('path');
const Router = new require('koa-router');

require('dotenv').config();
const Koa = require('koa');

const cors = require('koa2-cors');
const bodyParser = require('koa-bodyparser');
const logger = require('koa-logger');

if (process.env.NODE_ENV === 'prod') console.debug = () => {};

class MaresUtil {
    parseDBUrl(stringUrl) {
        let parsedUrl;
        let retObj = {};
        try {
            retObj.dbUrl = parsedUrl = url.parse(stringUrl);
            retObj.dialect = stringUrl.protocol || 'mysql:';
            retObj.dialect = retObj.dialect.replace(":", "");
            if (parsedUrl.auth) {
                let auth = parsedUrl.auth;
                let split = auth.split(":");
                retObj.user = split[0];
                retObj.pw = split[1];
            }
            retObj.host = stringUrl.hostname || 'localhost';
            retObj.port = stringUrl.port || '3306';
            retObj.name = parsedUrl.pathname;
            if (retObj.name) retObj.name = retObj.name.replace("/", "");
            return retObj;
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    buildAPI(rootPath, maxDepth) {
        let exist = fs.existsSync(rootPath + '/apis');
        let depthCnt = 0;
        let routerObj = {};

        let makeRscFromPath = (p, c, url) => {
            let relativePath = url.replace(rootPath, '');
            depthCnt = relativePath.split('/').length;
            if (depthCnt - 2 < maxDepth) {
                let root = url;
                if (p !== null) {
                    root = path.resolve(url, p);
                }
                let next = path.resolve(root, c);
                if (fs.statSync(next).isDirectory()) {
                    let cArr = fs.readdirSync(next);
                    for (let i = 0; i < cArr.length; ++i) {
                        let cObj = cArr[i];
                        makeRscFromPath(c, cObj, root);
                    }
                } else {
                    if (c === 'weld.js') {
                        let finalPath = path.resolve(root, c);
                        let router = require(finalPath);
                        if (router instanceof Router) {
                            routerObj[finalPath] = router;
                        }
                    }
                }
            }
        };
        if (exist) {
            makeRscFromPath(null, 'apis', rootPath);
        }
        return routerObj;
    }

    async buildSequelize(rootPath, sequelize) {
        let fullPath = path.resolve(rootPath, 'models', 'sequelize', 'index.js');
        let exist = fs.existsSync(fullPath);
        let modelObj = {};

        if (exist) {
            let models = require(fullPath);
            for (let k in models) {
                let model = models[k];
                if (sequelize instanceof Promise) {
                    sequelize = await sequelize;
                }
                let modelInstance = await model(sequelize);
                modelObj[modelInstance.name] = modelInstance;
            }
        }
        return modelObj;
    }

    checkDuplicationModel(Models) {
        let cached = {};
        let duplObj = [];
        Models.reverse().forEach((ModelObj) => {
            for (let key in ModelObj) {
                let Model = ModelObj[key];
                let name = Model.name;
                if (cached[name] === true) {
                    duplObj.push(name);
                }
                cached[name] = true;
            }
        });
        if (duplObj.length > 0) {
            throw Error('Duplicate tables: ' + duplObj.toString());
        }
    }
}

//todo 디비 설정 파라미터 외부에서 받아 올 수 있도록 수정필요.
class Mares {
    constructor(name = 'untitled', v = '0.0.1') {
        this._app = new Koa();
        this._util = new MaresUtil();
        this._v = v;
        this._name = name;
        this._middles = [];
        this._Models = [];
        this._apis = [];
        this._sequelize = null;
        this._opt = {
            apiReadDepth: 7
        };
    }

    get util() {
        return this._util;
    }

    get sequelize() {
        return this._sequelize;
    }

    async attach(rootPath, w = 0) {
        let weight = Number(w);
        if (weight !== 0 && !weight) {
            throw Error('Weight must be number value.');
        }

        let util = this._util;
        let apis = this._apis;
        let Models = this._Models;
        let sequelize = this._sequelize;

        let routerObj = util.buildAPI(rootPath, this._opt.apiReadDepth);
        if (!apis[w]) {
            apis[w] = routerObj
        } else {
            throw Error('Duplicate weight.');
        }

        let currentModels = await util.buildSequelize(rootPath, sequelize);
        if (!Models[w]) {
            Models[w] = currentModels;
        }
    }

    addMainDB(sequelize) {
        this._sequelize = sequelize;
    }

    use(middle) {
        this._middles.push(middle);
    }

    async listen(port) {
        let app = this._app;
        let sequelize = this._sequelize;
        let apis = this._apis;
        let middles = this._middles;
        let Models = this._Models;
        let util = this._util;
        let apiCnt = 0;

        if (sequelize) {
            util.checkDuplicationModel(Models);
            Models.reverse().forEach((ModelObj) => {
                for (let key in ModelObj) {
                    let Model = ModelObj[key];
                    Model.sync();
                }
            });

            let db = await sequelize.then();
            let config = db.config;

            console.log('Database info:', config.host, config.port, config.database, 'Connection Success');
        }

        app.use(bodyParser());
        app.use(logger());

        middles.forEach((key) => {
            app.use(key);
        });

        apis.reverse().forEach((apiObj) => {
            for (let key in apiObj) {
                let router = apiObj[key];
                if (router instanceof Router) {
                    apiCnt++;
                    app.use(router.routes());
                }
            }
        });

        app.use(cors);
        app.listen(port);

        console.log(apiCnt + ' apis are routing...');
        console.log(this._v + 'v ' + this._name + ' is running on ' + port + ' port!');
        return app;
    }
}

module.exports = Mares;