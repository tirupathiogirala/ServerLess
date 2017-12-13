'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const AwsProvider = require('../../provider/awsProvider');
const AwsDeploy = require('../index');
const Serverless = require('../../../../Serverless');
const BbPromise = require('bluebird');
const testUtils = require('../../../../../tests/utils');

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

const expect = chai.expect;

describe('createStack', () => {
  let awsDeploy;
  let sandbox;
  let serverless;
  const tmpDirPath = testUtils.getTmpDirPath();

  const serverlessYmlPath = path.join(tmpDirPath, 'serverless.yml');
  const serverlessYml = {
    service: 'first-service',
    provider: 'aws',
    functions: {
      first: {
        handler: 'sample.handler',
      },
    },
  };

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  beforeEach(() => {
    serverless = new Serverless();
    serverless.setProvider('aws', new AwsProvider(serverless, {}));
    serverless.utils.writeFileSync(serverlessYmlPath, serverlessYml);
    serverless.config.servicePath = tmpDirPath;
    const options = {
      stage: 'dev',
      region: 'us-east-1',
    };
    awsDeploy = new AwsDeploy(serverless, options);
    awsDeploy.serverless.service.service = `service-${(new Date()).getTime().toString()}`;
    awsDeploy.serverless.cli = {
      log: sinon.stub(),
    };
  });

  afterEach(() => {
    sandbox.reset();
    sandbox.restore();
  });

  describe('#create()', () => {
    it('should include custom stack tags', () => {
      awsDeploy.serverless.service.provider.stackTags = { STAGE: 'overridden', tag1: 'value1' };

      const createStackStub = sandbox
        .stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return expect(awsDeploy.create()).to.be.fulfilled
      .then(() => {
        expect(createStackStub.args[0][2].Tags)
          .to.deep.equal([
            { Key: 'STAGE', Value: 'overridden' },
            { Key: 'tag1', Value: 'value1' },
          ]);
      });
    });

    it('should use CloudFormation service role ARN if it is specified', () => {
      awsDeploy.serverless.service.provider.cfnRole = 'arn:aws:iam::123456789012:role/myrole';

      const createStackStub = sandbox
        .stub(awsDeploy.provider, 'request').resolves();
      sandbox.stub(awsDeploy, 'monitorStack').resolves();

      return expect(awsDeploy.create()).to.be.fulfilled
      .then(() => {
        expect(createStackStub.args[0][2].RoleARN)
          .to.equal('arn:aws:iam::123456789012:role/myrole');
      });
    });
  });

  describe('#createStack()', () => {
    it('should resolve if stack already created', () => {
      const createStub = sandbox
        .stub(awsDeploy, 'create').resolves();

      sandbox.stub(awsDeploy.provider, 'request').resolves();

      return expect(awsDeploy.createStack()).to.be.fulfilled
      .then(() => {
        expect(createStub.called).to.be.equal(false);
      });
    });

    it('should set the createLater flag and resolve if deployment bucket is provided', () => {
      awsDeploy.serverless.service.provider.deploymentBucket = 'serverless';
      sandbox.stub(awsDeploy.provider, 'request')
        .returns(BbPromise.reject({ message: 'does not exist' }));

      return expect(awsDeploy.createStack()).to.be.fulfilled
      .then(() => {
        expect(awsDeploy.createLater).to.equal(true);
      });
    });

    it('should throw error if describeStackResources fails for other reason than not found', () => {
      const errorMock = {
        message: 'Something went wrong.',
      };

      sandbox.stub(awsDeploy.provider, 'request').rejects(errorMock);

      const createStub = sandbox
        .stub(awsDeploy, 'create').resolves();

      return expect(awsDeploy.createStack()).to.be.rejectedWith(errorMock)
      .then(() => {
        expect(createStub).to.not.have.been.called;
      });
    });

    it('should run promise chain in order', () => {
      const errorMock = {
        message: 'does not exist',
      };

      sandbox.stub(awsDeploy.provider, 'request').rejects(errorMock);

      const createStub = sandbox
        .stub(awsDeploy, 'create').resolves();

      return expect(awsDeploy.createStack()).to.be.fulfilled
      .then(() => {
        expect(createStub).to.have.been.calledOnce;
      });
    });

    it('should disable S3 Transfer Acceleration if missing Output', () => {
      const disableTransferAccelerationStub = sandbox
        .stub(awsDeploy.provider,
          'disableTransferAccelerationForCurrentDeploy').resolves();

      const describeStacksOutput = {
        Stacks: [
          {
            Outputs: [],
          },
        ],
      };
      sandbox.stub(awsDeploy.provider, 'request').resolves(describeStacksOutput);

      awsDeploy.provider.options['aws-s3-accelerate'] = true;

      return expect(awsDeploy.createStack()).to.be.fulfilled
      .then(() => {
        expect(disableTransferAccelerationStub).to.have.been.calledOnce;
      });
    });
  });
});
