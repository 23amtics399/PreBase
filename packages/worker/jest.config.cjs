/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          // Override tsconfig for tests — use node module resolution
          module: 'CommonJS',
          moduleResolution: 'node',
          target: 'ES2022',
          strict: true,
          esModuleInterop: true,
          // Do not include cloudflare types in jest context
          types: ['@types/jest', '@types/node'],
        },
      },
    ],
  },
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
