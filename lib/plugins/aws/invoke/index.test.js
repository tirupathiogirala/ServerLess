'use strict';

/* eslint-disable no-unused-expressions */

const chai = require('chai');
const sinon = require('sinon');
const path = require('path');
const AwsInvoke = require('./index');
const AwsProvider = require('../provider/awsProvider');
const Serverless = require('../../../Serverless');
const chalk = require('chalk');
const testUtils = require('../../../../tests/utils');

chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));

const expect = chai.expect;

describe('AwsInvoke', () => {
  let serverless;
  let awsInvoke;

  beforeEach(() => {
    const options = {
      stage: 'dev',
      region: 'us-east-1',
      function: 'first',
    };
    serverless = new Serverless();
    serverless.setProvider('aws', new AwsProvider(serverless, options));
    awsInvoke = new AwsInvoke(serverless, options);
  });

  describe('#constructor()', () => {
    it('should have hooks', () => expect(awsInvoke.hooks).to.be.not.empty);

    it('should set the provider variable to an instance of AwsProvider',
      () => expect(awsInvoke.provider).to.be.instanceof(AwsProvider));

    it('should run promise chain in order', () => {
      const validateStub = sinon
        .stub(awsInvoke, 'extendedValidate').resolves();
      const invokeStub = sinon
        .stub(awsInvoke, 'invoke').resolves();
      const logStub = sinon
        .stub(awsInvoke, 'log').resolves();

      return awsInvoke.hooks['invoke:invoke']().then(() => {
        expect(validateStub).to.have.been.calledOnce;
        expect(invokeStub).to.have.been.calledAfter(validateStub);
        expect(logStub).to.have.been.calledAfter(invokeStub);
      })
      .finally(() => {
        validateStub.restore();
        invokeStub.restore();
        logStub.restore();
      });
    });

    it('should set an empty options object if no options are given', () => {
      const awsInvokeWithEmptyOptions = new AwsInvoke(serverless);

      expect(awsInvokeWithEmptyOptions.options).to.deep.equal({});
    });
  });

  describe('#extendedValidate()', () => {
    beforeEach(() => {
      serverless.config.servicePath = true;
      serverless.service.environment = {
        vars: {},
        stages: {
          dev: {
            vars: {},
            regions: {
              'us-east-1': {
                vars: {},
              },
            },
          },
        },
      };
      serverless.service.functions = {
        first: {
          handler: true,
        },
      };
      awsInvoke.options.data = null;
      awsInvoke.options.path = false;
    });

    it('it should throw error if function is not provided', () => {
      serverless.service.functions = null;
      return expect(awsInvoke.extendedValidate()).to.be.rejectedWith(Error);
    });

    it('should not throw error when there are no input data', () => {
      awsInvoke.options.data = undefined;

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.equal('');
      });
    });

    it('should keep data if it is a simple string', () => {
      awsInvoke.options.data = 'simple-string';

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.equal('simple-string');
      });
    });

    it('should parse data if it is a json string', () => {
      awsInvoke.options.data = '{"key": "value"}';

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.deep.equal({ key: 'value' });
      });
    });

    it('should skip parsing data if "raw" requested', () => {
      awsInvoke.options.data = '{"key": "value"}';
      awsInvoke.options.raw = true;

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.deep.equal('{"key": "value"}');
      });
    });

    it('it should parse file if relative file path is provided', () => {
      serverless.config.servicePath = testUtils.getTmpDirPath();
      const data = {
        testProp: 'testValue',
      };
      serverless.utils.writeFileSync(path
        .join(serverless.config.servicePath, 'data.json'), JSON.stringify(data));
      awsInvoke.options.path = 'data.json';

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.deep.equal(data);
      });
    });

    it('it should parse file if absolute file path is provided', () => {
      serverless.config.servicePath = testUtils.getTmpDirPath();
      const data = {
        testProp: 'testValue',
      };
      const dataFile = path.join(serverless.config.servicePath, 'data.json');
      serverless.utils.writeFileSync(dataFile, JSON.stringify(data));
      awsInvoke.options.path = dataFile;

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.deep.equal(data);
      });
    });

    it('it should parse a yaml file if file path is provided', () => {
      serverless.config.servicePath = testUtils.getTmpDirPath();
      const yamlContent = 'testProp: testValue';

      serverless.utils.writeFileSync(path
        .join(serverless.config.servicePath, 'data.yml'), yamlContent);
      awsInvoke.options.path = 'data.yml';

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled
      .then(() => {
        expect(awsInvoke.options.data).to.deep.equal({
          testProp: 'testValue',
        });
      });
    });

    it('it should reject if service path is not set', () => {
      serverless.config.servicePath = false;
      return expect(awsInvoke.extendedValidate()).to.be.rejectedWith(Error);
    });

    it('it should reject if file path does not exist', () => {
      serverless.config.servicePath = testUtils.getTmpDirPath();
      awsInvoke.options.path = 'some/path';

      return expect(awsInvoke.extendedValidate())
        .to.be.rejectedWith('The file you provided does not exist.');
    });

    it('should resolve if path is not given', () => {
      awsInvoke.options.path = false;

      return expect(awsInvoke.extendedValidate()).to.be.fulfilled;
    });
  });

  describe('#invoke()', () => {
    let invokeStub;

    beforeEach(() => {
      invokeStub = sinon.stub(awsInvoke.provider, 'request').resolves();
      awsInvoke.serverless.service.service = 'new-service';
      awsInvoke.options = {
        stage: 'dev',
        function: 'first',
        functionObj: {
          name: 'customName',
        },
      };
    });

    afterEach(() => {
      invokeStub.restore();
    });

    it('should invoke with correct params', () => awsInvoke.invoke()
      .then(() => {
        expect(invokeStub).to.have.been.calledOnce;
        expect(invokeStub).to.have.been.calledWithExactly(
          'Lambda',
          'invoke',
          {
            FunctionName: 'customName',
            InvocationType: 'RequestResponse',
            LogType: 'None',
            Payload: new Buffer(JSON.stringify({})),
          }
        );
      })
    );

    it('should invoke and log', () => {
      awsInvoke.options.log = true;

      return awsInvoke.invoke().then(() => {
        expect(invokeStub).to.have.been.calledOnce;
        expect(invokeStub).to.have.been.calledWithExactly(
          'Lambda',
          'invoke',
          {
            FunctionName: 'customName',
            InvocationType: 'RequestResponse',
            LogType: 'Tail',
            Payload: new Buffer(JSON.stringify({})),
          }
        );
      });
    });

    it('should invoke with other invocation type', () => {
      awsInvoke.options.type = 'OtherType';

      return awsInvoke.invoke().then(() => {
        expect(invokeStub).to.have.been.calledOnce;
        expect(invokeStub).to.have.been.calledWithExactly(
          'Lambda',
          'invoke',
          {
            FunctionName: 'customName',
            InvocationType: 'OtherType',
            LogType: 'None',
            Payload: new Buffer(JSON.stringify({})),
          }
        );
      });
    });
  });

  describe('#log()', () => {
    let consoleLogStub;

    beforeEach(() => {
      consoleLogStub = sinon.stub(awsInvoke, 'consoleLog');
    });

    afterEach(() => {
      consoleLogStub.restore();
    });

    it('should log payload', () => {
      const invocationReplyMock = {
        Payload: `
        {
         "testProp": "testValue"
        }
        `,
        LogResult: 'test',
      };

      return expect(awsInvoke.log(invocationReplyMock)).to.be.fulfilled
      .then(() => {
        const expectedPayloadMessage = `${chalk.white('{\n    "testProp": "testValue"\n}')}`;

        expect(consoleLogStub).to.have.been.calledWith(expectedPayloadMessage);
      });
    });

    it('rejects the promise for failed invocations', () => {
      const invocationReplyMock = {
        Payload: `
        {
         "testProp": "testValue"
        }
        `,
        LogResult: 'test',
        FunctionError: true,
      };

      return expect(awsInvoke.log(invocationReplyMock))
        .to.be.rejectedWith('Invoked function failed');
    });
  });
});
