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
        .tap(() => {
          console.log(this.templateHash);
          console.log(this.template);
        })
        .then(() => this.serverless.pluginManager.spawn('aws:common:cleanupTempDir')),

      'aws:deploy:function:downloadTemplate': () => BbPromise.bind(this)
        .then(this.getLastDeploymentDirectory)
        .then(this.downloadTemplateFromS3)
    };
  }

  getLastDeploymentDirectory() {
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
      this.directory = `serverless/${service}/${stage}/${time}-${(new Date(time)).toISOString()}`;
      return BbPromise.resolve();
    });
  }

  downloadTemplateFromS3() {
    this.serverless.cli.log('Downloading CloudFormation file from S3 ...');

    const compiledTemplateFileName = 'compiled-cloudformation-template.json';

    const params = this.setServersideS3EncryptionOptions({
      Bucket: this.bucketName,
      Key: `${this.directory}/${compiledTemplateFileName}`,
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

  normalizeArnRole(role) {
    if (typeof role === 'string') {
      if (role.indexOf(':') === -1) {
        const roleResource = this.serverless.service.resources.Resources[role];

        if (roleResource.Type !== 'AWS::IAM::Role') {
          throw new Error('Provided resource is not IAM Role.');
        }

        const roleProperties = roleResource.Properties;
        const compiledFullRoleName = `${roleProperties.Path || '/'}${roleProperties.RoleName}`;

        return this.provider.getAccountId().then((accountId) =>
          `arn:aws:iam::${accountId}:role${compiledFullRoleName}`
        );
      }

      return BbPromise.resolve(role);
    }

    return this.provider.request(
      'IAM',
      'getRole',
      {
        RoleName: role['Fn::GetAtt'][0],
      },
      this.options.stage, this.options.region
    ).then((data) => data.Arn);
  }

  callUpdateFunctionConfiguration(params) {
    return this.provider.request(
      'Lambda',
      'updateFunctionConfiguration',
      params,
      this.options.stage, this.options.region
    ).then(() => {
      this.serverless.cli.log(`Successfully updated function: ${this.options.function}`);
    });
  }

  updateFunctionConfiguration() {
    const functionObj = this.options.functionObj;
    const serviceObj = this.serverless.service.serviceObject;
    const providerObj = this.serverless.service.provider;
    const params = {
      FunctionName: functionObj.name,
    };

    if ('awsKmsKeyArn' in functionObj && !_.isObject(functionObj.awsKmsKeyArn)) {
      params.KMSKeyArn = functionObj.awsKmsKeyArn;
    } else if (serviceObj && 'awsKmsKeyArn' in serviceObj && !_.isObject(serviceObj.awsKmsKeyArn)) {
      params.KMSKeyArn = serviceObj.awsKmsKeyArn;
    }

    if ('description' in functionObj && !_.isObject(functionObj.description)) {
      params.Description = functionObj.description;
    }

    if ('memorySize' in functionObj && !_.isObject(functionObj.memorySize)) {
      params.MemorySize = functionObj.memorySize;
    } else if ('memorySize' in providerObj && !_.isObject(providerObj.memorySize)) {
      params.MemorySize = providerObj.memorySize;
    }

    if ('timeout' in functionObj && !_.isObject(functionObj.timeout)) {
      params.Timeout = functionObj.timeout;
    } else if ('timeout' in providerObj && !_.isObject(providerObj.timeout)) {
      params.Timeout = providerObj.timeout;
    }

    if (functionObj.onError && !_.isObject(functionObj.onError)) {
      params.DeadLetterConfig = {
        TargetArn: functionObj.onError,
      };
    }

    if (functionObj.environment || providerObj.environment) {
      params.Environment = {};
      params.Environment.Variables = Object.assign(
        {},
        providerObj.environment,
        functionObj.environment
      );

      if (_.some(params.Environment.Variables, value => _.isObject(value))) {
        delete params.Environment;
      } else {
        Object.keys(params.Environment.Variables).forEach((key) => {
          // taken from the bash man pages
          if (!key.match(/^[A-Za-z_][a-zA-Z0-9_]*$/)) {
            const errorMessage = 'Invalid characters in environment variable';
            throw new this.serverless.classes.Error(errorMessage);
          }
        });
      }
    }

    if (functionObj.vpc || providerObj.vpc) {
      const vpc = functionObj.vpc || providerObj.vpc;
      params.VpcConfig = {};

      if (_.isArray(vpc.securityGroupIds) && !_.some(vpc.securityGroupIds, _.isObject)) {
        params.VpcConfig.SecurityGroupIds = vpc.securityGroupIds;
      }

      if (_.isArray(vpc.subnetIds) && !_.some(vpc.subnetIds, _.isObject)) {
        params.VpcConfig.SubnetIds = vpc.subnetIds;
      }

      if (_.isEmpty(params.VpcConfig)) {
        delete params.VpcConfig;
      }
    }

    if ('role' in functionObj && !_.isObject(functionObj.role)) {
      return this.normalizeArnRole(functionObj.role).then(roleArn => {
        params.Role = roleArn;

        return this.callUpdateFunctionConfiguration(params);
      });
    } else if ('role' in providerObj && !_.isObject(providerObj.role)) {
      return this.normalizeArnRole(providerObj.role).then(roleArn => {
        params.Role = roleArn;

        return this.callUpdateFunctionConfiguration(params);
      });
    }

    if (_.isEmpty(_.omit(params, 'FunctionName'))) {
      return BbPromise.resolve();
    }

    return this.callUpdateFunctionConfiguration(params);
  }

  deployFunction() {
    const artifactFileName = this.provider.naming
      .getFunctionArtifactName(this.options.function);
    let artifactFilePath = this.serverless.service.package.artifact ||
      path.join(this.packagePath, artifactFileName);

    // check if an artifact is used in function package level
    const functionObject = this.serverless.service.getFunction(this.options.function);
    if (_.has(functionObject, ['package', 'artifact'])) {
      artifactFilePath = functionObject.package.artifact;
    }

    const data = fs.readFileSync(artifactFilePath);

    const remoteHash = this.serverless.service.provider.remoteFunctionData.Configuration.CodeSha256;
    const localHash = crypto.createHash('sha256').update(data).digest('base64');

    if (remoteHash === localHash && !this.options.force) {
      this.serverless.cli.log('Code not changed. Skipping function deployment.');
      return BbPromise.resolve();
    }

    const params = {
      FunctionName: this.options.functionObj.name,
      ZipFile: data,
    };

    const stats = fs.statSync(artifactFilePath);
    this.serverless.cli.log(
      `Uploading function: ${this.options.function} (${filesize(stats.size)})...`
    );

    return this.provider.request(
      'Lambda',
      'updateFunctionCode',
      params,
      this.options.stage, this.options.region
    ).then(() => {
      this.serverless.cli.log(`Successfully deployed function: ${this.options.function}`);
    });
  }
}

module.exports = AwsDeployFunction;
