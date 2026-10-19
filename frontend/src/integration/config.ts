// Shared constants for the two-client integration suite.
//
// The port is fixed rather than negotiated so global-setup.ts (main process) and
// the test workers (separate processes) agree without passing state between them.
// 8099 is apart from the dev server's 8090 and the Playwright harnesses' ports
// (AGENTS.md), so running any of them alongside this suite cannot collide.
export const PORT = Number(process.env.INTEGRATION_PORT ?? 8099);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

// Superuser used only to seed fixtures (accounts, memberships) and to read
// server state for assertions. Never exercised by the client code under test.
export const SUPERUSER_EMAIL = 'integration@test.local';
export const SUPERUSER_PASSWORD = 'integration-test-password';
