'use strict';

const BbPromise = require('bluebird');
const path = require('path');
const YAML = require('js-yaml');
const resolve = require('json-refs').resolveRefs;

class YamlParser {

  constructor(serverless) {
    this.serverless = serverless;
  }

  parse(yamlFilePath) {
    let parentDir = yamlFilePath.split(path.sep);
    parentDir.pop();
    parentDir = parentDir.join('/');
    process.chdir(parentDir);

    const root = this.serverless.utils.readFileSync(yamlFilePath);
    const options = {
      filter: ['relative', 'remote'],
      loaderOptions: {
        processContent: (res, callback) => {
          callback(null, YAML.load(res.text));
        },
      },
    };
    // We have to make sure here that we return a bluebird promise and no system promise.
    return BbPromise.resolve(resolve(root, options).then((res) => (res.resolved)));
  }
}

module.exports = YamlParser;
