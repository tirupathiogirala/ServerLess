'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const validate = require('../lib/validate');
const setBucketName = require('../lib/setBucketName');
const filesize = require('filesize');

class AwsDeployFunction {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.packagePath = this.options.package ||
      this.serverless.service.package.path ||
      path.join(this.serverless.config.servicePath || '.', '.serverless');
    this.provider = this.serverless.getProvider('aws');

    // used to store data received via AWS SDK
    this.serverless.service.provider.remoteFunctionData = null;

    Object.assign(this,
      validate,
      setBucketName
    );

    // We define an internal lifecycle that will be invoked and can be hooked
    this.commands = {
      aws: {
        type: 'entrypoint',
        commands: {
          deploy: {
            commands: {
              function: {
                lifecycleEvents: [
                  'downloadTemplate',
                ],
              },
            },
          },
        },
      },
    };

    this.hooks = {
      'deploy:function:initialize': () => BbPromise.bind(this)
        .then(this.validate)
        .then(this.checkIfFunctionExists),

      'deploy:function:packageFunction': () => this.serverless.pluginManager
        .spawn('package:function'),

      'deploy:function:deploy': () => BbPromise.bind(this)
        .then(this.setBucketName)
        .then(() => this.serverless.pluginManager.spawn('aws:deploy:function'))
        .then(() => this.serverless.pluginManager.spawn('aws:common:cleanupTempDir')),

      'aws:deploy:function:downloadTemplate': () => BbPromise.bind(this)
        .then(this.setLastDeploymentDirectory)
        .then(this.downloadTemplateFromS3)
        .tap(() => {
          console.log(this.templateHash);
          console.log(this.template);
          console.log("CURRENT!!!!", this.serverless.service.provider.compiledCloudFormationTemplate);
        }),
    };
  }

  setLastDeploymentDirectory() {
    this.serverless.cli.log('Determine last deployment ...');

    const service = this.serverless.service.service;

    const searchLatest = (current, token) => this.provider.request('S3',
      'listObjectsV2',
      {
        Bucket: this.bucketName,
        Prefix: `serverless/${service}/${this.options.stage}`,
        ContinuationToken: token,
      },
      this.options.stage,
      this.options.region
    )
    .then(result => {
      const content = _.get(result, 'Contents', []);
      const latest = _.reduce(content, (__, item) => {
        const parsedTime = /^.*\/([^/-]+).*\/.*?$/.exec(item.Key);
        if (!parsedTime) {
          return __;
        }
        const time = _.toInteger(parsedTime[1]);
        return time > __ ? time : __;
      }, current);
      // Paginate further in case the result is truncated
      if (_.get(result, 'Truncated')) {
        return searchLatest(latest, result.NextContinuationToken);
      }
      return latest;
    });

    return searchLatest(0)
    .then(time => {
      if (!time) {
        return BbPromise.reject(
          new this.serverless.Error('Could not find a previous service deployment')
        );
      }
      const stage = this.options.stage;
      // Make the deployment directory publicly available
      _.set(
        this,
        'serverless.service.provider.lastDeploymentDirectory',
        `serverless/${service}/${stage}/${time}-${(new Date(time)).toISOString()}`
      );
      return BbPromise.resolve();
    });
  }

  downloadTemplateFromS3() {
    this.serverless.cli.log('Downloading CloudFormation file from S3 ...');

    const compiledTemplateFileName = 'compiled-cloudformation-template.json';
    const directory = _.get(
      this,
      'serverless.service.provider.lastDeploymentDirectory'
    );
    const params = this.setServersideS3EncryptionOptions({
      Bucket: this.bucketName,
      Key: `${directory}/${compiledTemplateFileName}`,
    });

    return this.provider.request('S3',
      'getObject',
      params,
      this.options.stage,
      this.options.region)
    .then(response => {
      if (
        _.get(response, 'ContentType') !== 'application/json' ||
        _.get(response, 'ContentLength', 0) <= 0 ||
        !_.get(response, 'Body')
      ) {
        return BbPromise.reject(
          new this.serverless.Error('Could not retrieve CF template from S3')
        );
      }

      this.templateHash = _.get(response, 'Metadata.filesha256', '');
      return BbPromise.resolve(_.get(response, 'Body', new Buffer('{}')).toString('utf8'));
    })
    .then(template => BbPromise.try(() => JSON.parse(template)))
    .then(template => {
      this.template = template;
      return null;
    });
  }

  setServersideS3EncryptionOptions(params) {
    const clonedParams = _.cloneDeep(params);
    const deploymentBucketObject = this.serverless.service.provider.deploymentBucketObject;
    if (deploymentBucketObject) {
      const encryptionFields = [
        ['serverSideEncryption', 'ServerSideEncryption'],
        ['sseCustomerAlgorithim', 'SSECustomerAlgorithm'],
        ['sseCustomerKey', 'SSECustomerKey'],
        ['sseCustomerKeyMD5', 'SSECustomerKeyMD5'],
        ['sseKMSKeyId', 'SSEKMSKeyId'],
      ];

      encryptionFields.forEach((element) => {
        if (deploymentBucketObject[element[0]]) {
          clonedParams[element[1]] = deploymentBucketObject[element[0]];
        }
      }, this);
    }
    return clonedParams;
  }
}

module.exports = AwsDeployFunction;
