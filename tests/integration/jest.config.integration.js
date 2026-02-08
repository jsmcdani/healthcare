// tests/integration/jest.config.integration.js
export default {
  displayName: 'integration',
  rootDir: '../../',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.js'],
  globalTeardown: '<rootDir>/tests/integration/teardown.js',
  maxWorkers: 2,
  transform: {}
};
