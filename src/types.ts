export type TSupportedProtocols = 'tcp' | 'ipc';

export type TParams = {
	timeout?: number;
};

export type TRequestMessage = {
	id: number;
	createdAt: number;
	action: string;
	params: object;
	responseWanted: boolean;
	expiresAt: number;
	sourceUri: string;
};

export type TResponseMessage = {
	data: any;
	sourceUri?: string;
	id: number;
};