/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/test/scripts/setup.ts'],
  transformIgnorePatterns: ['/node_modules/(?!(bpmn-moddle)/)'],
  moduleNameMapper: {
    '^bpmn-moddle$': '<rootDir>/node_modules/bpmn-moddle/dist/index.cjs',
  },
};
