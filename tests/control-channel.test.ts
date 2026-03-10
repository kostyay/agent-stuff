/**
 * Integration tests for lib/control-channel — UDP-based parent↔child comms.
 *
 * Uses real UDP sockets on localhost. Tests cover the full round-trip:
 * server bind → child send → handler dispatch, plus edge cases like
 * malformed packets, missing env vars, concurrent senders, and cleanup.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/control-channel.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as dgram from "node:dgram";

import {
	ControlChannelServer,
	sendControlMessage,
	ENV_CONTROL_PORT,
	ENV_CONTROL_ID,
	type ControlMessage,
} from "../lib/control-channel.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for a given number of messages or a timeout (whichever comes first). */
function collectMessages(
	count: number,
	timeoutMs = 500,
): { handler: (msg: ControlMessage) => void; promise: Promise<ControlMessage[]> } {
	const messages: ControlMessage[] = [];
	let resolve: (msgs: ControlMessage[]) => void;
	const promise = new Promise<ControlMessage[]>((r) => {
		resolve = r;
	});

	const timer = setTimeout(() => resolve(messages), timeoutMs);

	const handler = (msg: ControlMessage) => {
		messages.push(msg);
		if (messages.length >= count) {
			clearTimeout(timer);
			resolve(messages);
		}
	};

	return { handler, promise };
}

/** Send a raw UDP packet to localhost:port. */
function sendRawUdp(port: number, data: string | Buffer): Promise<void> {
	return new Promise((resolve) => {
		const sock = dgram.createSocket("udp4");
		const buf = typeof data === "string" ? Buffer.from(data) : data;
		sock.send(buf, port, "127.0.0.1", () => {
			sock.close();
			resolve();
		});
	});
}

/** Save and restore env vars around tests that mutate process.env. */
function saveEnv(): { restore: () => void } {
	const saved = {
		port: process.env[ENV_CONTROL_PORT],
		id: process.env[ENV_CONTROL_ID],
	};
	return {
		restore: () => {
			if (saved.port === undefined) delete process.env[ENV_CONTROL_PORT];
			else process.env[ENV_CONTROL_PORT] = saved.port;
			if (saved.id === undefined) delete process.env[ENV_CONTROL_ID];
			else process.env[ENV_CONTROL_ID] = saved.id;
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ControlChannelServer", () => {
	let server: ControlChannelServer;

	afterEach(() => {
		server?.close();
	});

	describe("lifecycle", () => {
		it("binds to a random port on start()", async () => {
			const { handler } = collectMessages(0);
			server = new ControlChannelServer(handler);
			assert.equal(server.getPort(), 0, "Port should be 0 before start");

			await server.start();
			const port = server.getPort();
			assert.ok(port > 0, "Port should be assigned after start");
			assert.ok(port < 65536, "Port should be in valid range");
		});

		it("close() resets port to 0", async () => {
			const { handler } = collectMessages(0);
			server = new ControlChannelServer(handler);
			await server.start();
			assert.ok(server.getPort() > 0);

			server.close();
			assert.equal(server.getPort(), 0, "Port should reset to 0 after close");
		});

		it("close() is idempotent — calling twice does not throw", async () => {
			const { handler } = collectMessages(0);
			server = new ControlChannelServer(handler);
			await server.start();

			assert.doesNotThrow(() => server.close());
			assert.doesNotThrow(() => server.close());
		});
	});

	describe("childEnv", () => {
		it("returns correct env vars for a given ID", async () => {
			const { handler } = collectMessages(0);
			server = new ControlChannelServer(handler);
			await server.start();

			const env = server.childEnv(42);
			assert.equal(env[ENV_CONTROL_PORT], String(server.getPort()));
			assert.equal(env[ENV_CONTROL_ID], "42");
		});

		it("returns string values for all keys", async () => {
			const { handler } = collectMessages(0);
			server = new ControlChannelServer(handler);
			await server.start();

			const env = server.childEnv(0);
			for (const [key, val] of Object.entries(env)) {
				assert.equal(typeof val, "string", `${key} should be a string`);
			}
		});
	});

	describe("message reception", () => {
		it("receives a well-formed JSON message", async () => {
			const { handler, promise } = collectMessages(1);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "status", id: 1, data: "hello" }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].type, "status");
			assert.equal(msgs[0].id, 1);
			assert.equal(msgs[0].data, "hello");
		});

		it("receives multiple messages in order", async () => {
			const { handler, promise } = collectMessages(3);
			server = new ControlChannelServer(handler);
			await server.start();

			for (let i = 0; i < 3; i++) {
				await sendRawUdp(
					server.getPort(),
					JSON.stringify({ type: "ping", id: i, seq: i }),
				);
			}

			const msgs = await promise;
			assert.equal(msgs.length, 3);
			for (let i = 0; i < 3; i++) {
				assert.equal(msgs[i].id, i);
				assert.equal(msgs[i].seq, i);
			}
		});

		it("handles messages from different child IDs", async () => {
			const { handler, promise } = collectMessages(2);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "session_name", id: 10, name: "alpha" }),
			);
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "session_name", id: 20, name: "beta" }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 2);
			const ids = msgs.map((m) => m.id).sort();
			assert.deepEqual(ids, [10, 20]);
		});

		it("preserves extra fields in messages", async () => {
			const { handler, promise } = collectMessages(1);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({
					type: "progress",
					id: 5,
					percent: 75,
					label: "building",
					nested: { a: 1 },
				}),
			);

			const msgs = await promise;
			assert.equal(msgs[0].percent, 75);
			assert.equal(msgs[0].label, "building");
			assert.deepEqual(msgs[0].nested, { a: 1 });
		});
	});

	describe("malformed / invalid packets", () => {
		it("ignores non-JSON data", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(server.getPort(), "not json at all");
			// Send a valid one after to prove handler still works
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "ok", id: 1 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].type, "ok");
		});

		it("ignores JSON without type field", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ id: 1, data: "no type" }),
			);
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "valid", id: 2 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].id, 2);
		});

		it("ignores JSON without id field", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "orphan" }),
			);
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "valid", id: 3 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].id, 3);
		});

		it("ignores JSON where type is not a string", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: 123, id: 1 }),
			);
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "valid", id: 4 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].id, 4);
		});

		it("ignores JSON where id is not a number", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "bad", id: "not-a-number" }),
			);
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "valid", id: 5 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].id, 5);
		});

		it("ignores empty buffer", async () => {
			const { handler, promise } = collectMessages(1, 200);
			server = new ControlChannelServer(handler);
			await server.start();

			await sendRawUdp(server.getPort(), Buffer.alloc(0));
			await sendRawUdp(
				server.getPort(),
				JSON.stringify({ type: "valid", id: 6 }),
			);

			const msgs = await promise;
			assert.equal(msgs.length, 1);
			assert.equal(msgs[0].id, 6);
		});
	});
});

describe("sendControlMessage", () => {
	let server: ControlChannelServer;
	let envBackup: { restore: () => void };

	beforeEach(() => {
		envBackup = saveEnv();
	});

	afterEach(() => {
		server?.close();
		envBackup.restore();
	});

	it("sends a message that the server receives", async () => {
		const { handler, promise } = collectMessages(1);
		server = new ControlChannelServer(handler);
		await server.start();

		const env = server.childEnv(7);
		process.env[ENV_CONTROL_PORT] = env[ENV_CONTROL_PORT];
		process.env[ENV_CONTROL_ID] = env[ENV_CONTROL_ID];

		sendControlMessage({ type: "hello", payload: "world" });

		const msgs = await promise;
		assert.equal(msgs.length, 1);
		assert.equal(msgs[0].type, "hello");
		assert.equal(msgs[0].id, 7);
		assert.equal(msgs[0].payload, "world");
	});

	it("injects the correct id from env", async () => {
		const { handler, promise } = collectMessages(1);
		server = new ControlChannelServer(handler);
		await server.start();

		process.env[ENV_CONTROL_PORT] = String(server.getPort());
		process.env[ENV_CONTROL_ID] = "99";

		sendControlMessage({ type: "check_id" });

		const msgs = await promise;
		assert.equal(msgs[0].id, 99);
	});

	it("is a no-op when PI_CONTROL_PORT is missing", async () => {
		const { handler, promise } = collectMessages(0, 150);
		server = new ControlChannelServer(handler);
		await server.start();

		delete process.env[ENV_CONTROL_PORT];
		process.env[ENV_CONTROL_ID] = "1";

		// Should not throw
		assert.doesNotThrow(() => sendControlMessage({ type: "noop" }));

		const msgs = await promise;
		assert.equal(msgs.length, 0, "No messages should arrive");
	});

	it("is a no-op when PI_CONTROL_ID is missing", async () => {
		const { handler, promise } = collectMessages(0, 150);
		server = new ControlChannelServer(handler);
		await server.start();

		process.env[ENV_CONTROL_PORT] = String(server.getPort());
		delete process.env[ENV_CONTROL_ID];

		assert.doesNotThrow(() => sendControlMessage({ type: "noop" }));

		const msgs = await promise;
		assert.equal(msgs.length, 0);
	});

	it("is a no-op when both env vars are missing", async () => {
		delete process.env[ENV_CONTROL_PORT];
		delete process.env[ENV_CONTROL_ID];

		// No server needed — just verify no throw
		assert.doesNotThrow(() => sendControlMessage({ type: "noop" }));
	});

	it("is a no-op when PI_CONTROL_PORT is not a number", async () => {
		const { handler, promise } = collectMessages(0, 150);
		server = new ControlChannelServer(handler);
		await server.start();

		process.env[ENV_CONTROL_PORT] = "banana";
		process.env[ENV_CONTROL_ID] = "1";

		assert.doesNotThrow(() => sendControlMessage({ type: "noop" }));

		const msgs = await promise;
		assert.equal(msgs.length, 0);
	});

	it("is a no-op when PI_CONTROL_ID is not a number", async () => {
		const { handler, promise } = collectMessages(0, 150);
		server = new ControlChannelServer(handler);
		await server.start();

		process.env[ENV_CONTROL_PORT] = String(server.getPort());
		process.env[ENV_CONTROL_ID] = "xyz";

		assert.doesNotThrow(() => sendControlMessage({ type: "noop" }));

		const msgs = await promise;
		assert.equal(msgs.length, 0);
	});
});

describe("end-to-end: server + sendControlMessage", () => {
	let server: ControlChannelServer;
	let envBackup: { restore: () => void };

	beforeEach(() => {
		envBackup = saveEnv();
	});

	afterEach(() => {
		server?.close();
		envBackup.restore();
	});

	it("multiple rapid messages from same child all arrive", async () => {
		const count = 10;
		const { handler, promise } = collectMessages(count);
		server = new ControlChannelServer(handler);
		await server.start();

		const env = server.childEnv(1);
		process.env[ENV_CONTROL_PORT] = env[ENV_CONTROL_PORT];
		process.env[ENV_CONTROL_ID] = env[ENV_CONTROL_ID];

		for (let i = 0; i < count; i++) {
			sendControlMessage({ type: "burst", seq: i });
		}

		const msgs = await promise;
		assert.equal(msgs.length, count);
		assert.ok(msgs.every((m) => m.type === "burst"));
		assert.ok(msgs.every((m) => m.id === 1));
	});

	it("simulates multiple children sending to the same server", async () => {
		const { handler, promise } = collectMessages(3, 500);
		server = new ControlChannelServer(handler);
		await server.start();

		// Simulate 3 children by switching env vars
		for (const childId of [10, 20, 30]) {
			const env = server.childEnv(childId);
			process.env[ENV_CONTROL_PORT] = env[ENV_CONTROL_PORT];
			process.env[ENV_CONTROL_ID] = env[ENV_CONTROL_ID];
			sendControlMessage({ type: "checkin", child: childId });
		}

		const msgs = await promise;
		assert.equal(msgs.length, 3);
		const childIds = msgs.map((m) => m.id).sort();
		assert.deepEqual(childIds, [10, 20, 30]);
	});

	it("server continues working after receiving malformed then valid packets", async () => {
		const { handler, promise } = collectMessages(2, 500);
		server = new ControlChannelServer(handler);
		await server.start();

		// Malformed
		await sendRawUdp(server.getPort(), "{{{{broken json");
		await sendRawUdp(server.getPort(), JSON.stringify({ no: "type or id" }));

		// Valid via sendControlMessage
		const env = server.childEnv(1);
		process.env[ENV_CONTROL_PORT] = env[ENV_CONTROL_PORT];
		process.env[ENV_CONTROL_ID] = env[ENV_CONTROL_ID];
		sendControlMessage({ type: "after_malformed", seq: 1 });
		sendControlMessage({ type: "after_malformed", seq: 2 });

		const msgs = await promise;
		assert.equal(msgs.length, 2);
		assert.ok(msgs.every((m) => m.type === "after_malformed"));
	});

	it("childEnv round-trips through sendControlMessage correctly", async () => {
		const { handler, promise } = collectMessages(1);
		server = new ControlChannelServer(handler);
		await server.start();

		const childId = 42;
		const env = server.childEnv(childId);

		// Apply env as a child process would see it
		process.env[ENV_CONTROL_PORT] = env[ENV_CONTROL_PORT];
		process.env[ENV_CONTROL_ID] = env[ENV_CONTROL_ID];

		sendControlMessage({ type: "session_name", name: "my-session" });

		const msgs = await promise;
		assert.equal(msgs[0].type, "session_name");
		assert.equal(msgs[0].id, childId);
		assert.equal(msgs[0].name, "my-session");
	});
});
