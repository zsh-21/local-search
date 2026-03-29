export {};
import type { SafeIpcRendererBridge } from "../shared/types/ipcBridge";

declare global {
	type SafeIpcRenderer = SafeIpcRendererBridge;

	interface Window {
		ipcRenderer: SafeIpcRenderer;
	}
}
