/**
 * Quaderno Companion Round-Trip PDF Bridge Contracts (`learn-harness/` folder).
 */

export const DEFAULT_QUADERNO_BASE_URL = "http://127.0.0.1:5000";
export const DEFAULT_QUADERNO_FOLDER = "learn-harness";

export interface QuadernoConfig {
	baseUrl: string;
	apiKey: string | null;
	syncDir: string;
	folder: string;
}

export interface QuadernoStatus {
	ok: boolean;
	daemonReachable: boolean;
	deviceConnected: boolean;
	syncDir: string;
	folder: string;
	activeDocument?: {
		documentId?: string | null;
		title?: string | null;
		remotePath?: string | null;
		currentPage?: number;
		totalPages?: number;
	} | null;
}

export type QuadernoActionRequest =
	| {
			action: "sendProblem";
			chatId?: string;
			toolCallId?: string;
			docTitle?: string;
			title: string;
			markdown: string;
	  }
	| {
			action: "exportSheet";
			chatId?: string;
			docTitle?: string;
			title: string;
			markdown: string;
	  }
	| {
			action: "pullPdf";
			docTitle?: string | null;
			filePath?: string | null;
	  };

export interface QuadernoAttachmentPayload {
	name: string;
	mimeType: "application/pdf";
	data: string;
}

export interface QuadernoActionResult {
	ok: boolean;
	mode: "daemon" | "filesystem";
	message: string;
	docTitle?: string;
	relativePath?: string;
	filePath?: string;
	attachment?: QuadernoAttachmentPayload;
}
