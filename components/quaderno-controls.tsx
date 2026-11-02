"use client";

import { useRef, useState } from "react";
import {
	TabletIcon,
	PaperclipIcon,
	UploadIcon,
	XIcon,
	Loader2Icon,
	FileTextIcon,
	CheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
	QuadernoActionResult,
	QuadernoAttachmentPayload,
} from "@/src/core";

export interface QuadernoRoundTripBarProps {
	title: string;
	markdown: string;
	docTitle: string;
	chatId?: string;
	toolCallId?: string;
	disabled?: boolean;
	attachedFiles?: readonly { name: string; mimeType: string; data: string }[];
	onAttach: (attachment: QuadernoAttachmentPayload) => void;
	onRemoveAttachment?: (name: string) => void;
	onTranscribed?: (text: string) => void;
}

export function QuadernoRoundTripBar({
	title,
	markdown,
	docTitle,
	chatId,
	toolCallId,
	disabled = false,
	attachedFiles = [],
	onAttach,
	onRemoveAttachment,
	onTranscribed,
}: QuadernoRoundTripBarProps) {
	const [activeDocTitle, setActiveDocTitle] = useState(docTitle);
	const [sending, setSending] = useState(false);
	const [pulling, setPulling] = useState(false);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleSend = async () => {
		if (sending || disabled) return;
		setSending(true);
		setStatusMessage(null);
		try {
			const res = await fetch("/api/quaderno", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "sendProblem",
					chatId,
					toolCallId,
					docTitle,
					title,
					markdown,
				}),
			});
			const result = (await res.json()) as QuadernoActionResult;
			if (result.ok) {
				if (result.docTitle) setActiveDocTitle(result.docTitle);
				setStatusMessage(result.message || `Sent to ${result.relativePath ?? "Quaderno"}`);
			} else {
				setStatusMessage(result.message || "Failed to send to Quaderno");
			}
		} catch {
			setStatusMessage("Error connecting to Quaderno");
		} finally {
			setSending(false);
		}
	};

	const handleAttach = async () => {
		if (pulling || disabled) return;
		setPulling(true);
		setStatusMessage(null);
		try {
			const res = await fetch("/api/quaderno", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "pullPdf",
					docTitle: activeDocTitle || docTitle,
				}),
			});
			const result = (await res.json()) as QuadernoActionResult;
			if (result.ok && result.attachment) {
				onAttach(result.attachment);
				if (result.transcription && onTranscribed) {
					onTranscribed(result.transcription);
				}
				setStatusMessage(result.message || `Attached ${result.attachment.name}`);
			} else {
				setStatusMessage(result.message || "No returned PDF found");
			}
		} catch {
			setStatusMessage("Error pulling PDF from Quaderno");
		} finally {
			setPulling(false);
		}
	};

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			const res = reader.result;
			if (typeof res === "string") {
				const base64 = res.includes(",") ? res.split(",")[1]! : res;
				onAttach({
					name: file.name,
					mimeType: "application/pdf",
					data: base64,
				});
				setStatusMessage(`Uploaded ${file.name}`);
			}
		};
		reader.readAsDataURL(file);
		e.target.value = "";
	};

	return (
		<div
			data-testid="quaderno-round-trip-bar"
			className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-accent/20 px-3 py-2 text-xs"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5 font-medium text-muted-foreground">
					<TabletIcon className="size-3.5 text-primary" />
					<span>Quaderno E-Ink</span>
				</div>

				<div className="flex flex-wrap items-center gap-1.5">
					<Button
						type="button"
						size="sm"
						variant="outline"
						data-testid="quaderno-send-button"
						disabled={disabled || sending}
						onClick={handleSend}
						className="h-7 gap-1 px-2 text-xs font-normal"
					>
						{sending ? (
							<Loader2Icon className="size-3 animate-spin" />
						) : (
							<TabletIcon className="size-3" />
						)}
						Send to Quaderno
					</Button>

					<Button
						type="button"
						size="sm"
						variant="outline"
						data-testid="quaderno-attach-button"
						disabled={disabled || pulling}
						onClick={handleAttach}
						className="h-7 gap-1 px-2 text-xs font-normal"
					>
						{pulling ? (
							<Loader2Icon className="size-3 animate-spin" />
						) : (
							<PaperclipIcon className="size-3" />
						)}
						Attach from Quaderno
					</Button>

					<input
						ref={fileInputRef}
						type="file"
						accept=".pdf,application/pdf"
						data-testid="quaderno-file-input"
						className="hidden"
						onChange={handleFileSelect}
					/>

					<Button
						type="button"
						size="sm"
						variant="ghost"
						data-testid="quaderno-upload-button"
						disabled={disabled}
						onClick={() => fileInputRef.current?.click()}
						className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
					>
						<UploadIcon className="size-3" />
						Upload PDF
					</Button>
				</div>
			</div>

			{statusMessage && (
				<div
					data-testid="quaderno-status-message"
					className="flex items-center gap-1 text-[11px] text-muted-foreground"
				>
					<CheckIcon className="size-3 text-emerald-600 dark:text-emerald-400" />
					<span className="truncate">{statusMessage}</span>
				</div>
			)}

			{attachedFiles.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 pt-1">
					{attachedFiles.map((att) => (
						<div
							key={att.name}
							data-testid="quaderno-attached-chip"
							className={cn(
								"inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/90 px-2 py-0.5 text-[11px] font-medium text-foreground shadow-xs",
							)}
						>
							<FileTextIcon className="size-3 text-primary" />
							<span className="max-w-48 truncate">{att.name}</span>
							{onRemoveAttachment && (
								<button
									type="button"
									aria-label={`Remove ${att.name}`}
									onClick={() => onRemoveAttachment(att.name)}
									className="ml-0.5 rounded-xs p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<XIcon className="size-3" />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
