/**
 * UDP Control Channel
 *
 * Lightweight UDP-based communication channel between parent and child
 * processes. The parent binds a UDP socket on localhost and children
 * send JSON messages identified by a numeric ID.
 *
 * Designed for fire-and-forget metadata exchange (session names, status
 * updates, progress) without interfering with stdout/stderr streams.
 *
 * Usage:
 *   Parent: create a ControlChannelServer, start(), pass getPort() to children
 *   Child:  call sendControlMessage() — reads port/id from env vars automatically
 *
 * Environment variables:
 *   PI_CONTROL_PORT — UDP port the parent is listening on
 *   PI_CONTROL_ID   — numeric ID identifying this child process
 */

import * as dgram from "node:dgram";

/** Environment variable for the parent's UDP port. */
export const ENV_CONTROL_PORT = "PI_CONTROL_PORT";

/** Environment variable for the child's numeric identifier. */
export const ENV_CONTROL_ID = "PI_CONTROL_ID";

/** Base shape for all control channel messages. */
export interface ControlMessage {
	type: string;
	id: number;
	[key: string]: unknown;
}

/** Callback invoked when a valid control message is received. */
export type ControlMessageHandler = (msg: ControlMessage) => void;

/**
 * Parent-side UDP listener.
 *
 * Binds to a random port on localhost, parses incoming JSON messages,
 * and dispatches them to the registered handler.
 */
export class ControlChannelServer {
	private socket: dgram.Socket;
	private port = 0;
	private handler: ControlMessageHandler;

	constructor(handler: ControlMessageHandler) {
		this.handler = handler;
		this.socket = dgram.createSocket("udp4");

		this.socket.on("message", (data: Buffer) => {
			try {
				const msg = JSON.parse(data.toString()) as ControlMessage;
				if (typeof msg.type === "string" && typeof msg.id === "number") {
					this.handler(msg);
				}
			} catch {
				/* ignore malformed packets */
			}
		});

		this.socket.on("error", () => {
			/* ignore socket errors — best-effort channel */
		});
	}

	/** Start listening. Resolves once the socket is bound. */
	async start(): Promise<void> {
		return new Promise((resolve) => {
			this.socket.bind(0, "127.0.0.1", () => {
				this.port = this.socket.address().port;
				resolve();
			});
		});
	}

	/** The port the socket is listening on (0 if not yet started). */
	getPort(): number {
		return this.port;
	}

	/** Build env vars to pass to a child process for a given ID. */
	childEnv(id: number): Record<string, string> {
		return {
			[ENV_CONTROL_PORT]: String(this.port),
			[ENV_CONTROL_ID]: String(id),
		};
	}

	/** Close the socket and release resources. */
	close(): void {
		try {
			this.socket.close();
		} catch {
			/* ignore */
		}
		this.port = 0;
	}
}

/**
 * Send a control message from a child process to the parent.
 *
 * Reads PI_CONTROL_PORT and PI_CONTROL_ID from the environment.
 * No-op if the env vars are absent (i.e. not running as a child).
 * Fire-and-forget — errors are silently ignored.
 */
export function sendControlMessage(msg: Omit<ControlMessage, "id">): void {
	const portStr = process.env[ENV_CONTROL_PORT];
	const idStr = process.env[ENV_CONTROL_ID];
	if (!portStr || !idStr) return;

	const port = Number.parseInt(portStr, 10);
	const id = Number.parseInt(idStr, 10);
	if (Number.isNaN(port) || Number.isNaN(id)) return;

	const payload = Buffer.from(JSON.stringify({ ...msg, id }));
	const socket = dgram.createSocket("udp4");
	socket.send(payload, port, "127.0.0.1", () => {
		socket.close();
	});
}
