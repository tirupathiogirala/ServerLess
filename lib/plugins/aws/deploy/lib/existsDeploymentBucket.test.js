'use strict';

const sinon = require('sinon');
const chai = require('chai');
const AwsProvider = require('../../provider/awsProvider');
const Serverless = require('../../../../Serverless');
const existsDeploymentBucket = require('./existsDeploymentBucket');

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

const expect = require('chai').expect;

describe('#existsDeploymentBucket()', () => {
  let serverless;
  const awsPlugin = {};

  beforeEach(() => {
    const options = {
      stage: 'dev',
      region: 'us-east-1',
    };
    serverless = new Serverless();
    awsPlugin.serverless = serverless;
    awsPlugin.provider = new AwsProvider(serverless, options);

    Object.assign(awsPlugin, existsDeploymentBucket);
  });

  it('should validate the region for the given S3 bucket', () => {
    const bucketName = 'com.serverless.deploys';

    const awsPluginStub = sinon.stub(awsPlugin.provider, 'request').resolves({
      LocationConstraint: awsPlugin.provider.options.region,
    });

    return expect(awsPlugin.existsDeploymentBucket(bucketName)).to.be.fulfilled
    .then(() => {
      expect(awsPluginStub.args[0][0]).to.equal('S3');
      expect(awsPluginStub.args[0][1]).to.equal('getBucketLocation');
      expect(awsPluginStub.args[0][2].Bucket).to.equal(bucketName);
    })
    .finally(() => {
      awsPluginStub.restore();
    });
  });

  it('should reject an S3 bucket that does not exist', () => {
    const bucketName = 'com.serverless.deploys';
    const errorObj = { message: 'Access Denied' };

    const awsPluginStub = sinon.stub(awsPlugin.provider, 'request').rejects(errorObj);
    return expect(awsPlugin.existsDeploymentBucket(bucketName))
      .to.be.rejectedWith(/Could not locate deployment bucket/)
    .then(() => {
      expect(awsPluginStub.args[0][0]).to.equal('S3');
      expect(awsPluginStub.args[0][1]).to.equal('getBucketLocation');
      expect(awsPluginStub.args[0][2].Bucket).to.equal(bucketName);
    })
    .finally(() => {
      awsPluginStub.restore();
    });
  });

  it('should reject an S3 bucket in the wrong region', () => {
    const bucketName = 'com.serverless.deploys';

    const awsPluginStub = sinon.stub(awsPlugin.provider, 'request').resolves({
      LocationConstraint: 'us-west-1',
    });

    return expect(awsPlugin.existsDeploymentBucket(bucketName))
      .to.be.rejectedWith(/not in the same region/)
    .then(() => {
      expect(awsPluginStub.args[0][0]).to.equal('S3');
      expect(awsPluginStub.args[0][1]).to.equal('getBucketLocation');
      expect(awsPluginStub.args[0][2].Bucket).to.equal(bucketName);
    })
    .finally(() => {
      awsPluginStub.restore();
    });
  });

  [
    { region: 'eu-west-1', response: 'EU' },
    { region: 'us-east-1', response: '' },
  ].forEach((value) => {
    it(`should handle inconsistent getBucketLocation responses for ${value.region} region`, () => {
      const bucketName = 'com.serverless.deploys';

      awsPlugin.provider.options.region = value.region;

      const awsPluginStub = sinon.stub(awsPlugin.provider, 'request').resolves({
        LocationConstraint: value.response,
      });

      awsPlugin.serverless.service.provider.deploymentBucket = bucketName;
      return expect(awsPlugin.existsDeploymentBucket(bucketName)).to.be.fulfilled
      .then(() => {
        expect(awsPluginStub.args[0][0]).to.equal('S3');
        expect(awsPluginStub.args[0][1]).to.equal('getBucketLocation');
        expect(awsPluginStub.args[0][2].Bucket).to.equal(bucketName);
      })
      .finally(() => {
        awsPluginStub.restore();
      });
    });
  });
});
