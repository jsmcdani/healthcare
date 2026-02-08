export default {
  displayName: 'unit',
  rootDir: '../../',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/helpers/unit-setup.js'],
  transform: {}
};
