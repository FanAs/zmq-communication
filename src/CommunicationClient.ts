import ClosedError from "errors/ClosedError"
import TimeoutError from "errors/TimeoutError"
import {getSystemHost} from "getSystemHost"
import {TParams, TRequestMessage, TResponseMessage, TSupportedProtocols} from "types"
import { socket, Socket } from 'zeromq';
import { EventEmitter } from 'events';

type TCallbackInformation<T> = {
	createdAt: number;
	expiresAt: number;
	resolve: (value: T) => void;
	reject: (err: Error) => void;
	action: string;
	sourceUri: string;
};

export type TClientOptions = {
	bindPort: number;
	protocol?: TSupportedProtocols;
	host?: string;
	checkTimeoutsInterval?: number;
	defaultTimeout?: number;
};

const MAX_ID = 10000000;
const DEFAULT_TIMEOUT = 250;
const DEFAULT_PROTOCOL = 'tcp';
const CHECK_TIMEOUTS_INTERVAL = 100;
const MIN_PORT = 1024;
const MAX_PORT = 49151;

export default class CommunicationClient extends EventEmitter {
	// pull socket port
	private readonly bindPort: number;
	// communication layer protocol
	private readonly protocol: 'tcp' | 'ipc';
	private readonly checkTimeoutsInterval: number;
	private readonly defaultTimeout: number;

	// hostname for gateways
	private host: string;
	private bindSocket: Socket;
	private nextId = 0;
	private callbackStorage = new Map<number, TCallbackInformation<any>>();
	private socketStorage = new Map<string, Socket>();
	private checkTimeoutsId: NodeJS.Timeout;

	/**
	 * We need to open pull socket on client side to be able to get responses
	 */
	public constructor(options: TClientOptions) {
		super();

		options.protocol = options.protocol || DEFAULT_PROTOCOL;
		options.defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
		options.checkTimeoutsInterval = options.checkTimeoutsInterval || CHECK_TIMEOUTS_INTERVAL;
		this.validateOptions(options);

		this.bindPort = options.bindPort;
		this.protocol = options.protocol;
		this.host = options.host;
		this.checkTimeoutsInterval = options.checkTimeoutsInterval;
		this.defaultTimeout = options.defaultTimeout;

		this.checkTimeoutsId = setTimeout(() => this.checkTimeouts(), options.checkTimeoutsInterval);
	}

	/**
	 * Close and release all used sockets
	 */
	public close(): void {
		if (this.bindSocket != null) {
			this.bindSocket.close();
		}

		if (this.checkTimeoutsId != null) {
			clearTimeout(this.checkTimeoutsId);
		}

		this.socketStorage.forEach((pushSocket) => pushSocket.close());
		this.socketStorage.clear();
		this.callbackStorage.forEach((callback) => callback.reject(new ClosedError()));
	}

	/**
	 * Fire & forget request to multiple endpoints
	 *
	 * @param addresses URIs in protocol://hostname:port format
	 * @param action type of action (similar to www path)
	 * @param params request params (similar to www params)
	 */
	public fireMulti(addresses: string[], action: string, params: TParams & object): void {
		addresses.forEach((uri) => this.fire(uri, action, params));
	}

	/**
	 * Fire & forget request to single endpoint
	 *
	 * @param address URI in hostname:port format
	 * @param action type of action (similar to www path)
	 * @param params request params (similar to www params)
	 */
	public fire(address: string, action: string, params: any): void {
		this.sendRaw(address, action, params, false);
	}

	/**
	 * Send request to multiple endpoints
	 *
	 * @param addresses URIs in hostname:port format
	 * @param action type of action (similar to www path)
	 * @param params request params (similar to www params)
	 * @param responseWanted if set to true,
	 */
	public async sendMulti<TResult>(
		addresses: string[],
		action: string,
		params: TParams & object,
		responseWanted: boolean,
	): Promise<TResult[]> {
		return Promise.all(addresses.map((uri) => this.send<TResult>(uri, action, params)));
	}

	/**
	 * Send request to single endpoint
	 *
	 * @param address URI in hostname:port format
	 * @param action type of action (similar to www path)
	 * @param params request params (similar to www params)
	 */
	public async send<TResult>(address: string, action: string, params: any): Promise<TResult> {
		const { id, createdAt, expiresAt, sourceUri } = this.sendRaw(address, action, params, true);

		return new Promise((resolve, reject) => {
			this.callbackStorage.set(id, {
				createdAt,
				expiresAt,
				resolve,
				reject,
				action,
				sourceUri,
			});
		}) as Promise<any>;
	}

	private validateOptions({ bindPort, host, checkTimeoutsInterval, defaultTimeout }: TClientOptions) {
		if (bindPort < MIN_PORT || bindPort > MAX_PORT) {
			throw new Error(`Port is out of range: ${bindPort}`);
		}

		if (host != null && host.indexOf('://') !== -1) {
			throw new Error(`Hostname cannot contain protocol, format is hostname:port (but got ${host})`);
		}

		if (defaultTimeout < 2) {
			throw new Error(`Timeout cannot be set to value smaller then 2: ${defaultTimeout}`);
		}

		if (checkTimeoutsInterval < 1) {
			throw new Error(`Timeout check cannot be set to value smaller then 1: ${defaultTimeout}`);
		}
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

	/**
	 * Get identifier for bind socket (inner socket for response handling)
	 */
	private getBindSocketIdentity(): string {
		return `bind${process.pid}`;
	}

	/**
	 * Get identifier for client socket (socket that sends messages at the first place)
	 */
	private getClientSocketIdentity(): string {
		return `client${process.pid}`;
	}

	/**
	 * Get uri for bind socket (inner socket for response handling)
	 */
	private getBindUri(): string {
		return `${this.protocol}://${this.getHost()}:${this.bindPort}`;
	}

	/**
	 * Creates uri from address (adds protocol prefix)
	 */
	private getUri(address: string): string {
		return `${this.protocol}://${address}`;
	}

	/**
	 * Get bind socket (inner socket for response handling)
	 */
	private getBindSocket(): Socket {
		const bindSocket = socket('pull');
		bindSocket.identity = this.getBindSocketIdentity();
		bindSocket.bindSync(this.getBindUri());

		return bindSocket;
	}

	/**
	 * Binds socket to listen for servers responses
	 */
	private bindInternal(): void {
		this.bindSocket = this.getBindSocket();

		this.bindSocket.on('message', async (message) => {
			let messageObject: TResponseMessage;
			try {
				messageObject = JSON.parse(message.toString());
			} catch (err) {
				this.emit('error', messageObject); // no way to get callback id neither understand is it response or request

				return;
			}

			messageObject['size'] = message.length;

			const possibleCallback = this.callbackStorage.get(messageObject.id);
			if (possibleCallback == null) {
				return;
			}

			this.callbackStorage.delete(messageObject.id);
			possibleCallback.resolve(messageObject);
		});
	}

	/**
	 * Get next unique id for callback
	 */
	private getNextId(): number {
		const nextId = this.nextId;
		this.nextId += 1;

		if (this.nextId > MAX_ID) {
			this.nextId = 0;
		}

		return nextId;
	}

	/**
	 *
	 * @param params
	 */
	private getTimeout(params: TParams): number {
		return params.timeout || this.defaultTimeout;
	}

	private sendRaw(address: string, action: string, params: any, responseWanted: boolean): TRequestMessage {
		const id = this.getNextId();
		const createdAt = Date.now();
		const expiresAt = createdAt + this.getTimeout(params);

		const localUri = this.getBindUri();

		const message: TRequestMessage = {
			id,
			createdAt,
			action,
			params,
			responseWanted,
			expiresAt,
			sourceUri: localUri,
		};

		if (this.bindSocket == null && message['responseWanted']) {
			this.bindInternal();
		}

		const uri = this.getUri(address);
		const pushSocket = this.getPushSocket(uri);

		pushSocket.send(JSON.stringify(message));

		return message;
	}

	private getPushSocket(uri: string): Socket {
		return this.socketStorage.get(uri) || this.createPushSocket(uri);
	}

	private createPushSocket(uri: string): Socket {
		const pushSocket = socket('push');
		pushSocket.identity = this.getClientSocketIdentity();
		pushSocket.connect(uri);
		this.socketStorage.set(uri, pushSocket);

		return pushSocket;
	}

	private checkTimeouts(): void {
		const time = Date.now();

		this.callbackStorage.forEach((callback, id) => {
			if (callback.expiresAt > time) {
				return;
			}

			callback.reject(new TimeoutError(`Timeout error`));
			this.callbackStorage.delete(id);
		});

		this.checkTimeoutsId = setTimeout(() => this.checkTimeouts(), this.checkTimeoutsInterval);
	}
}