import {getSystemHost} from "./getSystemHost"
import {TRequestMessage, TResponseMessage, TSupportedProtocols} from "./types"
import { socket, Socket } from 'zeromq';
import { EventEmitter } from 'events';

type TServerOptions = {
	protocol: TSupportedProtocols;
	host?: string;
	port: number;
};

export const MIN_PORT = 1024;
const MAX_PORT = 49151;
const DEFAULT_PROTOCOL = 'tcp';

export default class CommunicationServer extends EventEmitter {
	private readonly port: number;
	private readonly protocol: 'tcp' | 'ipc';

	private listenSocket: Socket;
	private host: string;
	private onRequest: (err?: Error, data?: any) => void;
	private socketStorage = new Map<string, Socket>();

	public constructor(options: TServerOptions) {
		super();

		options.protocol = options.protocol || DEFAULT_PROTOCOL;
		this.validateOptions(options);

		this.port = options.port;
		this.protocol = options.protocol;
		this.host = options.host;
	}

	private validateOptions({ port, host }: TServerOptions) {
		if (port < MIN_PORT || port > MAX_PORT) {
			throw new Error(`Port is out of range: ${port}`);
		}

		if (host != null && host.indexOf('://') !== -1) {
			throw new Error(`Hostname cannot contain protocol, format is hostname:port (but got ${host})`);
		}
	}

	public listen(onRequest: (err?: Error, data?: any) => void) {
		if (this.listenSocket != null) {
			throw new Error(`Already listening on port ${this.port}`);
		}

		this.onRequest = onRequest;

		this.listenInternal();
	}

	public close(): void {
		if (this.listenSocket != null) {
			this.listenSocket.close();
		}
	}

	private listenInternal(): void {
		this.listenSocket = this.getListenSocket();

		this.listenSocket.on('message', async (message) => {
			let messageObject: TRequestMessage;
			try {
				messageObject = JSON.parse(message.toString());
			} catch (err) {
				return this.onRequest(err);
			}

			const resultPromise = this.onRequest(undefined, messageObject);
			if (!messageObject.responseWanted) {
				return;
			}

			this.sendResponse(messageObject.sourceUri, {
				id: messageObject.id,
				data: await resultPromise,
				sourceUri: this.getListenUri(),
			});
		});
	}

	/**
	 * Get local hostname defined in constructor or in system (hostname)
	 */
	public getHost(): string {
		if (this.host != null) {
			return this.host;
		}

		this.host = getSystemHost();

		return this.host;
	}

	private getListenSocketIdentity(): string {
		return `server${process.pid}`;
	}

	private getListenUri(): string {
		return `${this.protocol}://${this.getHost()}:${this.port}`;
	}

	private getListenSocket(): Socket {
		const listenSocket = socket('pull');
		listenSocket.identity = this.getListenSocketIdentity();
		listenSocket.bindSync(this.getListenUri());

		return listenSocket;
	}

	private sendResponse(uri: string, message: TResponseMessage): void {
		const pushSocket = this.getPushSocket(uri);

		pushSocket.send(JSON.stringify(message));
	}

	private getUri(address: string): string {
		return `${this.protocol}://${address}`;
	}

	private getPushSocket(uri: string): Socket {
		return this.socketStorage.get(uri) || this.createPushSocket(uri);
	}

	private createPushSocket(uri: string): Socket {
		const pushSocket = socket('push');
		pushSocket.identity = this.getPushSocketIdentity();
		pushSocket.connect(uri);
		this.socketStorage.set(uri, pushSocket);

		return pushSocket;
	}

	private getPushSocketIdentity(): string {
		return `bind${process.pid}`;
	}
}
