export default { test: { include: ['tests/**/*.test.ts'], pool: 'threads', setupFiles: ['./tests/offline.ts'], testTimeout: 20000 } };
