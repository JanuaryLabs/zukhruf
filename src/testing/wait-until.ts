import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

export function waitUntil(
	t: TestContext,
	condition: () => boolean,
	message: string,
	timeout = 2000,
) {
	return t.waitFor(() => assert.ok(condition(), message), {
		interval: 5,
		timeout,
	});
}
