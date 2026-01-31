export {};

declare global {
	type SafeIpcRenderer = {
		on(channel: string, listener: (...args: any[]) => void): void;
		off(channel: string, listener?: (...args: any[]) => void): void;
		removeAllListeners(channel: string): void;
		send(channel: string, ...args: any[]): void;
		invoke(channel: string, ...args: any[]): Promise<any>;
	};

	interface Window {
		ipcRenderer: SafeIpcRenderer;
	}
}
