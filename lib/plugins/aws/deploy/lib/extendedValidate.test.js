'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const AwsProvider = require('../../provider/awsProvider');
const AwsDeploy = require('../index');
const Serverless = require('../../../../Serverless');
const testUtils = require('../../../../../tests/utils');

const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);
chai.use(require('sinon-chai'));

const expect = chai.expect;

describe('extendedValidate', () => {
  let sandbox;
  let awsDeploy;
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
  const stateFileMock = {
    service: serverlessYml,
    package: {
      individually: true,
      artifactDirectoryName: 'some/path',
      artifact: '',
    },
  };

  before(() => {
    sandbox = sinon.sandbox.create();
  });

  beforeEach(() => {
    const options = {
      stage: 'dev',
      region: 'us-east-1',
    };

    serverless = new Serverless();
    serverless.setProvider('aws', new AwsProvider(serverless, options));
    serverless.utils.writeFileSync(serverlessYmlPath, serverlessYml);
    serverless.config.servicePath = tmpDirPath;

    serverless.service.service = `service-${(new Date()).getTime().toString()}`;
    serverless.cli = {
      log: sinon.stub(),
    };

    awsDeploy = Object.freeze(new AwsDeploy(serverless, options));
  });

  afterEach(() => {
    sandbox.reset();
    sandbox.restore();
  });

  describe('extendedValidate()', () => {
    let fileExistsSyncStub;
    let readFileSyncStub;

    beforeEach(() => {
      fileExistsSyncStub = sandbox.stub(serverless.utils, 'fileExistsSync');
      readFileSyncStub = sandbox.stub(serverless.utils, 'readFileSync');
      serverless.service.package.individually = false;
    });

    it('should reject if state file does not exist', () => {
      fileExistsSyncStub.returns(false);

      return expect(awsDeploy.extendedValidate()).to.be.rejectedWith(Error);
    });

    it('should reject if packaged individually but functions packages do not exist', () => {
      fileExistsSyncStub.onCall(0).returns(true);
      fileExistsSyncStub.onCall(1).returns(false);
      readFileSyncStub.returns(stateFileMock);

      serverless.service.package.individually = true;

      return expect(awsDeploy.extendedValidate())
        .to.be.rejectedWith(/No [^\s]+ file found in the package path you provided./);
    });

    it('should reject if service package does not exist', () => {
      fileExistsSyncStub.onCall(0).returns(true);
      fileExistsSyncStub.onCall(1).returns(false);
      readFileSyncStub.returns(stateFileMock);

      return expect(awsDeploy.extendedValidate()).to.be.rejectedWith(Error);
    });

    it('should not throw error if service has no functions and no service package', () => {
      stateFileMock.service.functions = {};
      fileExistsSyncStub.returns(true);
      readFileSyncStub.returns(stateFileMock);

      return expect(awsDeploy.extendedValidate()).to.have.been.fulfilled
      .then(() => {
        expect(fileExistsSyncStub).to.have.been.calledOnce;
        expect(readFileSyncStub).to.have.been.calledOnce;
      });
    });

    it('should not throw error if service has no functions and no function packages', () => {
      stateFileMock.service.functions = {};
      serverless.service.package.individually = true;
      fileExistsSyncStub.returns(true);
      readFileSyncStub.returns(stateFileMock);

      return expect(awsDeploy.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(fileExistsSyncStub).to.have.been.calledOnce;
        expect(readFileSyncStub).to.have.been.calledOnce;
      });
    });

    it('should use function package level artifact when provided', () => {
      stateFileMock.service.functions = {
        first: {
          package: {
            artifact: 'artifact.zip',
          },
        },
      };
      serverless.service.package.individually = true;
      fileExistsSyncStub.returns(true);
      readFileSyncStub.returns(stateFileMock);

      return expect(awsDeploy.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(fileExistsSyncStub).to.have.been.calledTwice;
        expect(readFileSyncStub).to.have.been.calledOnce;
        expect(fileExistsSyncStub).to.have.been.calledWithExactly('artifact.zip');
      });
    });

    it('should reject if specified package artifact does not exist', () => {
      // const fileExistsSyncStub = sinon.stub(awsDeploy.serverless.utils, 'fileExistsSync');
      fileExistsSyncStub.onCall(0).returns(true);
      fileExistsSyncStub.onCall(1).returns(false);
      readFileSyncStub.returns(stateFileMock);
      serverless.service.package.artifact = 'some/file.zip';
      return expect(awsDeploy.extendedValidate()).to.be.rejectedWith(Error)
      .finally(() => {
        delete serverless.service.package.artifact;
      });
    });

    it('should not throw error if specified package artifact exists', () => {
      // const fileExistsSyncStub = sinon.stub(awsDeploy.serverless.utils, 'fileExistsSync');
      fileExistsSyncStub.onCall(0).returns(true);
      fileExistsSyncStub.onCall(1).returns(true);
      readFileSyncStub.returns(stateFileMock);
      serverless.service.package.artifact = 'some/file.zip';
      return expect(awsDeploy.extendedValidate()).to.be.fulfilled
      .finally(() => {
        delete serverless.service.package.artifact;
      });
    });

    it('should warn if function\'s timeout is greater than 30 and it\'s attached to APIGW', () => {
      stateFileMock.service.functions = {
        first: {
          timeout: 31,
          package: {
            artifact: 'artifact.zip',
          },
          events: [{
            http: {},
          }],
        },
      };
      serverless.service.package.individually = true;
      fileExistsSyncStub.returns(true);
      readFileSyncStub.returns(stateFileMock);

      return expect(awsDeploy.extendedValidate()).to.be.fulfilled
      .then(() => {
        const msg = [
          'WARNING: Function first has timeout of 31 seconds, however, it\'s ',
          'attached to API Gateway so it\'s automatically limited to 30 seconds.',
        ].join('');
        expect(serverless.cli.log.firstCall).to.have.been.calledWithExactly(msg);
      });
    });
  });
});
